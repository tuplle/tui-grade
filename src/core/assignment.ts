// Assignment loading: assignment.yaml, plugin registration and scenario files. Content problems become issues.
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { App } from './app.ts';
import type { AssignmentConfig, Issue, ScenarioIR } from './contracts.ts';
import { zodIssues } from './issues.ts';
import type { PluginDef } from './plugin.ts';
import { resolvePlugin } from './plugin-resolver.ts';
import { expandMatrix, normalizeScenario, parseScenarioFile } from './scenario.ts';
import { defaultPreset } from '../plugins/preset.ts';

export interface LoadedAssignment {
  dir: string;
  config: AssignmentConfig;
  app: App;
  scenarios: ScenarioIR[];
  issues: Issue[];
  /** False when assignment.yaml could not be read or parsed: `config` is then a placeholder and `issues` explain why. */
  configOk: boolean;
}

const CONFIG_FILE = 'assignment.yaml';

const localizedText = z.union([z.string(), z.record(z.string(), z.string())]);
const positiveInt = z.number().int().positive();

const regex = z.string().refine(
  (source) => {
    try {
      new RegExp(source);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a valid regular expression' },
);

const configSchema = z.strictObject({
  name: z.string().min(1),
  max_points: z.number().nonnegative(),
  locale: z.enum(['en', 'sk']).default('en'),
  build: z.looseObject({ type: z.string().min(1) }),
  binary: z.string().min(1).optional(),
  project_root_marker: z.string().min(1),
  project_root_depth: z.number().int().nonnegative().default(2),
  student_id: z.strictObject({ pattern: regex.optional(), strip_prefix: z.string().optional() }).optional(),
  groups: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        title: localizedText,
        points: z.number().nonnegative(),
        manual: z.boolean().optional(),
        requires_build: z.boolean().optional(),
      }),
    )
    .optional(),
  scoring: z
    .strictObject({
      use: z.string().min(1).default('proportional'),
      rounding: z.enum(['none', 'floor', 'round', 'ceil']).default('none'),
      cap: z.boolean().default(true),
    })
    .prefault({}),
  plugins: z
    .array(z.union([z.string().min(1), z.strictObject({ use: z.string().min(1), options: z.unknown().optional() })]))
    .default([]),
  preset: z.enum(['default', 'none']).default('default'),
  template: z.string().min(1).optional(),
  limits: z
    .strictObject({
      build_timeout_sec: z.number().positive().default(120),
      run_timeout_sec: z.number().positive().default(10),
      output_limit_bytes: positiveInt.default(1_048_576),
      unzip_max_bytes: positiveInt.default(524_288_000),
      unzip_max_files: positiveInt.default(20_000),
    })
    .prefault({}),
});

// Compile-time proof that the schema yields the contract, in both directions. `exactOptionalPropertyTypes`
// makes zod's `key?: T | undefined` differ from the contract's `key?: T`, so both sides are compared in a
// form where optional keys also accept an explicit `undefined`.
type Relax<T> = T extends readonly (infer U)[]
  ? Relax<U>[]
  : T extends object
    ? { [K in keyof T as {} extends Pick<T, K> ? never : K]: Relax<T[K]> } & {
        [K in keyof T as {} extends Pick<T, K> ? K : never]?: Relax<T[K]> | undefined;
      }
    : T;
type SchemaOutput = Relax<z.output<typeof configSchema>>;
type Contract = Relax<AssignmentConfig>;
true satisfies [SchemaOutput] extends [Contract] ? true : false;
true satisfies [Contract] extends [SchemaOutput] ? true : false;

/** Zod schema of `assignment.yaml`; defaults are applied while parsing. */
export function assignmentConfigSchema(): z.ZodType<AssignmentConfig> {
  return configSchema as unknown as z.ZodType<AssignmentConfig>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issue(path: string, message: string): Issue {
  return { path, message, severity: 'error' };
}

/** Placeholder config used when assignment.yaml is unusable; only ever returned together with errors. */
function fallbackConfig(dir: string): AssignmentConfig {
  return {
    name: basename(dir),
    max_points: 0,
    locale: 'en',
    build: { type: '' },
    project_root_marker: '',
    project_root_depth: 2,
    scoring: { use: 'proportional', rounding: 'none', cap: true },
    plugins: [],
    preset: 'default',
    limits: {
      build_timeout_sec: 120,
      run_timeout_sec: 10,
      output_limit_bytes: 1_048_576,
      unzip_max_bytes: 524_288_000,
      unzip_max_files: 20_000,
    },
  };
}

async function readConfig(dir: string, issues: Issue[]): Promise<AssignmentConfig | null> {
  const root = `${CONFIG_FILE}#/`;
  let text: string;
  try {
    text = await readFile(join(dir, CONFIG_FILE), 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `not found in ${dir}` : String(error);
    issues.push(issue(root, `${CONFIG_FILE} ${reason}`));
    return null;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const base = (error.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?$/, '');
      const pos = error.linePos?.[0];
      issues.push(issue(root, pos ? `${base} (line ${pos.line}, col ${pos.col})` : base));
    }
    return null;
  }
  const parsed = assignmentConfigSchema().safeParse(doc.toJS());
  if (!parsed.success) {
    issues.push(...zodIssues(parsed.error, root.slice(0, -1)));
    return null;
  }
  return parsed.data;
}

/** Scenario files below `<dir>/scenarios`, sorted, as POSIX paths relative to `dir`; a missing directory is no files. */
async function findScenarioFiles(dir: string, issues: Issue[]): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(dir, 'scenarios'), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(issue('scenarios#/', `cannot read scenarios/: ${errorMessage(error)}`));
      return [];
    }
    entries = [];
  }
  const files = entries
    .filter((entry) => /\.ya?ml$/.test(entry))
    .map((entry) => `scenarios/${entry.split('\\').join('/')}`)
    .sort();
  if (files.length === 0) issues.push(issue('scenarios#/', 'no scenario files (*.yaml, *.yml) found in scenarios/'));
  return files;
}

/** Registers a plugin as shared. A named plugin that is already loaded (e.g. by the preset) is skipped, so listing it again is harmless. */
async function registerPlugin(app: App, def: PluginDef, options: unknown, path: string, issues: Issue[]): Promise<void> {
  if (def.meta.name !== undefined && app.hasPlugin(def.meta.name)) return;
  try {
    await app.register({ ...def, shared: true }, options);
  } catch (error) {
    issues.push(issue(path, errorMessage(error)));
  }
}

/**
 * Loads an assignment directory: config, plugins (preset first, then `opts.extraPlugins`, then the
 * `plugins` list) and scenarios. Never throws for content problems; they are returned in `issues`.
 */
export async function loadAssignment(dir: string, opts: { extraPlugins?: PluginDef[] } = {}): Promise<LoadedAssignment> {
  const assignmentDir = resolve(dir);
  const issues: Issue[] = [];
  const app = new App(new App());

  const config = await readConfig(assignmentDir, issues);
  if (config === null) return { dir: assignmentDir, config: fallbackConfig(assignmentDir), app, scenarios: [], issues, configOk: false };

  if (config.preset === 'default') await registerPlugin(app, defaultPreset, undefined, `${CONFIG_FILE}#/preset`, issues);
  for (const [i, def] of (opts.extraPlugins ?? []).entries()) {
    await registerPlugin(app, def, undefined, `extraPlugins#/${i}`, issues);
  }
  for (const [i, entry] of config.plugins.entries()) {
    const path = `${CONFIG_FILE}#/plugins/${i}`;
    const spec = typeof entry === 'string' ? entry : entry.use;
    const options = typeof entry === 'string' ? undefined : entry.options;
    let def: PluginDef;
    try {
      def = await resolvePlugin(spec, assignmentDir);
    } catch (error) {
      issues.push(issue(path, errorMessage(error)));
      continue;
    }
    await registerPlugin(app, def, options, path, issues);
  }

  const scenarios: ScenarioIR[] = [];
  for (const file of await findScenarioFiles(assignmentDir, issues)) {
    let text: string;
    try {
      text = await readFile(join(assignmentDir, file), 'utf8');
    } catch (error) {
      issues.push(issue(`${file}#/`, `cannot read file: ${errorMessage(error)}`));
      continue;
    }
    const parsed = parseScenarioFile(text, file);
    issues.push(...parsed.issues);
    for (const [position, raw] of parsed.raw.entries()) {
      const index = parsed.indices[position] as number;
      const expanded = expandMatrix(raw, index, file);
      issues.push(...expanded.issues);
      for (const item of expanded.scenarios) {
        const normalized = normalizeScenario(item, index, file);
        issues.push(...normalized.issues);
        if (normalized.scenario) scenarios.push(normalized.scenario);
      }
    }
  }
  return { dir: assignmentDir, config, app, scenarios, issues, configOk: true };
}
