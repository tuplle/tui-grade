// Scenario files: YAML parsing, matrix expansion and shape-only normalization into the IR.
// Plugin registries are never consulted here; that is the validator's job.
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { CheckSpec, Issue, LocalizedText, ScenarioIR, StepSpec } from './contracts.ts';
import { interpolate, UnknownVariableError } from './template.ts';

export interface RawScenario {
  id: string;
  title: LocalizedText;
  group?: string;
  weight?: number;
  matrix?: Record<string, string[]>;
  setup?: unknown[];
  steps?: unknown[];
  run?: unknown;
  session?: unknown;
  expect: unknown[];
}

const localizedText = z.union([z.string(), z.record(z.string(), z.string())]);
const rawScenarioSchema = z.strictObject({
  id: z.string().min(1),
  title: localizedText,
  group: z.string().optional(),
  weight: z.number().nonnegative().optional(),
  matrix: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.array(z.string()).min(1)).optional(),
  setup: z.array(z.unknown()).optional(),
  steps: z.array(z.unknown()).optional(),
  run: z.unknown().optional(),
  session: z.unknown().optional(),
  expect: z.array(z.unknown()),
});

const STEP_RESERVED = ['id'] as const;
const CHECK_RESERVED = ['from', 'weight', 'hidden', 'not'] as const;

function issue(path: string, message: string): Issue {
  return { path, message, severity: 'error' };
}

/**
 * Parses a scenario file (a YAML array). Invalid scenarios are reported and left out of `raw`;
 * `indices[i]` is the position in the file of `raw[i]`, to be passed on as the `index` of later stages.
 */
export function parseScenarioFile(
  text: string,
  file: string,
): { raw: RawScenario[]; indices: number[]; issues: Issue[] } {
  const root = `${file}#/`;
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const issues = doc.errors.map((error) => {
      const base = (error.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?$/, '');
      const pos = error.linePos?.[0];
      return issue(root, pos ? `${base} (line ${pos.line}, col ${pos.col})` : base);
    });
    return { raw: [], indices: [], issues };
  }
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (error) {
    return { raw: [], indices: [], issues: [issue(root, `invalid YAML: ${(error as Error).message}`)] };
  }
  if (!Array.isArray(data)) {
    const issues = [issue(root, 'a scenario file must contain a YAML array of scenarios')];
    return { raw: [], indices: [], issues };
  }

  const raw: RawScenario[] = [];
  const indices: number[] = [];
  const issues: Issue[] = [];
  data.forEach((item: unknown, index) => {
    const parsed = rawScenarioSchema.safeParse(item);
    if (parsed.success) {
      raw.push(parsed.data as RawScenario);
      indices.push(index);
      return;
    }
    for (const problem of parsed.error.issues) {
      const pointer = [String(index), ...problem.path.map(String)].join('/');
      issues.push(issue(`${file}#/${pointer}`, problem.message));
    }
  });
  return { raw, indices, issues };
}

/** Expands `matrix` into one scenario per combination (first key varies slowest). */
export function expandMatrix(
  raw: RawScenario,
  index: number,
  file: string,
): { scenarios: RawScenario[]; issues: Issue[] } {
  const entries = Object.entries(raw.matrix ?? {});
  if (entries.length === 0) return { scenarios: [raw], issues: [] };

  let combos: Array<Record<string, string>> = [{}];
  for (const [key, values] of entries) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
  }

  const scenarios: RawScenario[] = [];
  try {
    for (const vars of combos) {
      // runtime variables (${binary}, ${workdir}, ${fixtures}) must survive until the scenario runs
      const interp = <T>(value: T): T => interpolate(value, vars, { keepUnknown: true });
      scenarios.push({
        ...raw,
        id: interp(raw.id),
        title: interp(raw.title),
        matrix: Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, [value]])),
        ...(raw.setup === undefined ? {} : { setup: interp(raw.setup) }),
        ...(raw.steps === undefined ? {} : { steps: interp(raw.steps) }),
        ...(raw.run === undefined ? {} : { run: interp(raw.run) }),
        ...(raw.session === undefined ? {} : { session: interp(raw.session) }),
        expect: interp(raw.expect),
      });
    }
  } catch (error) {
    if (!(error instanceof UnknownVariableError)) throw error;
    return { scenarios: [], issues: [issue(`${file}#/${index}`, error.message)] };
  }

  const ids = scenarios.map((scenario) => scenario.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    const message = `matrix expansion: ids not unique (duplicate "${duplicate}"); use a matrix variable in the id`;
    return { scenarios: [], issues: [issue(`${file}#/${index}/id`, message)] };
  }
  return { scenarios, issues: [] };
}

type Split = { name: string; params: unknown; mods: Record<string, unknown> } | { problem: string };

/** Splits a step/check object into its single action key plus the reserved modifiers. */
function split(entry: unknown, reserved: readonly string[], what: string): Split {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { problem: `a ${what} must be an object with exactly one ${what} name key` };
  }
  const mods: Record<string, unknown> = {};
  const rest: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(entry)) {
    if (reserved.includes(key)) mods[key] = value;
    else rest.push([key, value]);
  }
  if (rest.length !== 1) {
    const found = rest.length === 0 ? 'none' : rest.map(([key]) => key).join(', ');
    return { problem: `a ${what} needs exactly one ${what} name key besides ${reserved.join('/')}, found: ${found}` };
  }
  const [name, params] = rest[0] as [string, unknown];
  return { name, params, mods };
}

function normalizeStep(entry: unknown, pointer: string, issues: Issue[]): StepSpec | null {
  const parts = split(entry, STEP_RESERVED, 'step');
  if ('problem' in parts) {
    issues.push(issue(pointer, parts.problem));
    return null;
  }
  const { id } = parts.mods;
  if (id !== undefined && typeof id !== 'string') {
    issues.push(issue(`${pointer}/id`, 'step id must be a string'));
    return null;
  }
  return { name: parts.name, params: parts.params, ...(id === undefined ? {} : { id }), pointer };
}

export function normalizeCheck(entry: unknown, pointer: string, issues: Issue[]): CheckSpec | null {
  const parts = split(entry, CHECK_RESERVED, 'check');
  if ('problem' in parts) {
    issues.push(issue(pointer, parts.problem));
    return null;
  }
  const { from, weight = 1, hidden = false, not = false } = parts.mods;
  const before = issues.length;
  if (from !== undefined && typeof from !== 'string') issues.push(issue(`${pointer}/from`, 'from must be a string'));
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
    issues.push(issue(`${pointer}/weight`, 'weight must be a non-negative number'));
  }
  if (typeof hidden !== 'boolean') issues.push(issue(`${pointer}/hidden`, 'hidden must be a boolean'));
  if (typeof not !== 'boolean') issues.push(issue(`${pointer}/not`, 'not must be a boolean'));
  if (issues.length > before) return null;
  return {
    name: parts.name,
    params: parts.params,
    ...(from === undefined ? {} : { from: from as string }),
    weight: weight as number,
    hidden: hidden as boolean,
    not: not as boolean,
    pointer,
  };
}

/** Shape-only normalization of one (already matrix-expanded) scenario; `scenario` is null on any error. */
export function normalizeScenario(
  raw: RawScenario,
  index: number,
  file: string,
): { scenario: ScenarioIR | null; issues: Issue[] } {
  const pointer = `${file}#/${index}`;
  const issues: Issue[] = [];

  const vars: Record<string, string> = {};
  for (const [key, values] of Object.entries(raw.matrix ?? {})) {
    if (values.length === 1) vars[key] = values[0] as string;
    else issues.push(issue(`${pointer}/matrix/${key}`, 'matrix is not expanded; call expandMatrix first'));
  }

  // An expect-only scenario (static checks, no step) is fine; the validator rejects checks that need a run or session.
  const hasStep = (raw.setup?.length ?? 0) > 0 || (raw.steps?.length ?? 0) > 0 || raw.run !== undefined || raw.session !== undefined;
  if (!hasStep && raw.expect.length === 0) issues.push(issue(pointer, 'a scenario needs at least one step (steps, run or session) or one expect check'));

  const steps: StepSpec[] = [];
  const add = (step: StepSpec | null): void => {
    if (step) steps.push(step);
  };
  (raw.setup ?? []).forEach((entry, i) => add(normalizeStep(entry, `${pointer}/setup/${i}`, issues)));
  (raw.steps ?? []).forEach((entry, i) => add(normalizeStep(entry, `${pointer}/steps/${i}`, issues)));
  if (raw.run !== undefined) steps.push({ name: 'run', params: raw.run, pointer: `${pointer}/run` });
  if (raw.session !== undefined) steps.push({ name: 'session', params: raw.session, pointer: `${pointer}/session` });

  const expect: CheckSpec[] = [];
  raw.expect.forEach((entry, i) => {
    const check = normalizeCheck(entry, `${pointer}/expect/${i}`, issues);
    if (check) expect.push(check);
  });

  if (issues.length > 0) return { scenario: null, issues };
  return {
    scenario: {
      id: raw.id,
      title: raw.title,
      ...(raw.group === undefined ? {} : { group: raw.group }),
      weight: raw.weight ?? 1,
      steps,
      expect,
      file,
      pointer,
      vars,
    },
    issues,
  };
}
