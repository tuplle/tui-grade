// Programmatic API (§8): the CLI commands are thin wrappers over `createGrader`.
import { z } from 'zod';
import { App } from './core/app.ts';
import { assignmentConfigSchema, loadAssignment } from './core/assignment.ts';
import type { Issue } from './core/contracts.ts';
import { ConfigError } from './core/errors.ts';
import { localize } from './core/i18n.ts';
import { type RunOptions, gradeAll } from './core/lifecycle.ts';
import type { Kind, PluginDef } from './core/plugin.ts';
import { validateAssignment } from './core/validate.ts';
import { defaultPreset } from './plugins/preset.ts';

export interface DescribeEntry {
  kind: Kind;
  name: string;
  description: string;
  example?: string;
  params: object; // JSON Schema (input side) of the params
}

export interface ScenarioSummary {
  id: string;
  title: string; // localized with the assignment's locale
  group?: string;
  file: string;
}

export interface CheckReport {
  ok: boolean; // no error issues (warnings alone keep it valid)
  issues: Issue[]; // load issues first, then the validator's
  scenarios: ScenarioSummary[];
  locale: string;
}

export interface Grader {
  check(): Promise<Issue[]>;
  /** Like `check`, plus the expanded scenario list (what `tui-grade check --json` prints). */
  inspect(): Promise<CheckReport>;
  describe(): Promise<DescribeEntry[]>;
  schema(): Promise<object>;
  run(o: Omit<RunOptions, 'assignmentDir' | 'extraPlugins'>): ReturnType<typeof gradeAll>;
}

/** Without `assignmentDir`, `describe` and `schema` use a fresh app with the default preset; `check` and `run` need one. */
export interface GraderOptions {
  assignmentDir?: string;
  plugins?: PluginDef[];
}

const KINDS: Kind[] = ['step', 'check', 'builder', 'reporter', 'scorer'];
const CONFIG_FILE = 'assignment.yaml';

/** `z.toJSONSchema` can reject exotic schemas; the description is more useful than a crash, so fall back to `{}`. */
function jsonSchema(schema: z.ZodType | undefined): Record<string, unknown> {
  if (schema === undefined) return {};
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Nested schemas must not repeat the dialect declaration. */
function nested(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

export function createGrader(opts: GraderOptions): Grader {
  const plugins = opts.plugins ?? [];
  const requireDir = (): string => {
    if (opts.assignmentDir === undefined) throw new Error('an assignment directory is required');
    return opts.assignmentDir;
  };
  const extra = (): { extraPlugins?: PluginDef[] } => (plugins.length === 0 ? {} : { extraPlugins: plugins });

  /** The app whose registries describe what an assignment can use; content problems of scenarios are ignored here. */
  async function registry(): Promise<App> {
    if (opts.assignmentDir === undefined) {
      const app = new App(new App());
      await app.register({ ...defaultPreset, shared: true });
      for (const plugin of plugins) await app.register({ ...plugin, shared: true });
      return app;
    }
    const loaded = await loadAssignment(opts.assignmentDir, extra());
    const unusable = loaded.issues.filter(
      (i) => i.severity === 'error' && (i.path.startsWith(`${CONFIG_FILE}#`) || i.path.startsWith('extraPlugins#')),
    );
    if (unusable.length > 0 || !loaded.configOk) {
      const summary = unusable.map((i) => `${i.path}: ${i.message}`).join('\n');
      throw new ConfigError(summary === '' ? 'assignment is unusable' : summary, unusable);
    }
    return loaded.app;
  }

  async function inspect(): Promise<CheckReport> {
    const loaded = await loadAssignment(requireDir(), extra());
    // Static issues only; validating the placeholder config of an unreadable assignment.yaml would add noise.
    const issues = !loaded.configOk ? [...loaded.issues] : [...loaded.issues, ...validateAssignment(loaded)];
    const locale = loaded.config.locale;
    return {
      ok: !issues.some((i) => i.severity === 'error'),
      issues,
      scenarios: loaded.scenarios.map((s) => ({
        id: s.id,
        title: localize(s.title, locale),
        ...(s.group === undefined ? {} : { group: s.group }),
        file: s.file,
      })),
      locale,
    };
  }

  async function describe(): Promise<DescribeEntry[]> {
    const app = await registry();
    const entries: DescribeEntry[] = [];
    for (const kind of KINDS) {
      const items = app.list(kind).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const { name, def } of items) {
        const example = 'example' in def ? def.example : undefined;
        entries.push({
          kind,
          name,
          description: def.description,
          ...(example === undefined ? {} : { example }),
          params: jsonSchema(def.params),
        });
      }
    }
    return entries;
  }

  async function schema(): Promise<object> {
    const entries = await describe();
    const props = (kind: Kind): Record<string, unknown> =>
      Object.fromEntries(entries.filter((e) => e.kind === kind).map((e) => [e.name, annotate(e)]));
    const annotate = (e: DescribeEntry): Record<string, unknown> => ({
      ...nested(e.params as Record<string, unknown>),
      description: e.description,
      ...(e.example === undefined ? {} : { examples: [e.example] }),
    });
    const ref = (name: string): { $ref: string } => ({ $ref: `#/$defs/${name}` });
    const stepProps = props('step');
    const text = { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }] };

    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'tui-grade scenario file',
      type: 'array',
      items: ref('scenario'),
      $defs: {
        assignment: nested(jsonSchema(assignmentConfigSchema())),
        scenario: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'expect'],
          properties: {
            id: { type: 'string', minLength: 1 },
            title: text,
            group: { type: 'string' },
            weight: { type: 'number', minimum: 0 },
            matrix: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' }, minItems: 1 } },
            setup: { type: 'array', items: ref('step') },
            steps: { type: 'array', items: ref('step') },
            run: stepProps['run'] ?? {},
            session: stepProps['session'] ?? {},
            expect: { type: 'array', items: ref('check') },
          },
        },
        step: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description: 'One step: its name maps to its parameters; `id` names the record it produces.',
          properties: { ...stepProps, id: { type: 'string' } },
        },
        check: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description: 'One check: its name maps to its parameters; `from` picks the step record it reads.',
          properties: {
            ...props('check'),
            from: { type: 'string' },
            weight: { type: 'number', minimum: 0 },
            hidden: { type: 'boolean' },
            not: { type: 'boolean' },
          },
        },
      },
    };
  }

  return {
    async check() {
      return (await inspect()).issues;
    },
    inspect,
    describe,
    schema,
    run(o) {
      return gradeAll({ ...o, assignmentDir: requireDir(), ...extra() });
    },
  };
}
