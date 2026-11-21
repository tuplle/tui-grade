// Static validation of a loaded assignment: everything that can be checked without running a submission.
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { z } from 'zod';
import type { LoadedAssignment } from './assignment.ts';
import type { CheckDef, CheckSpec, Issue, ScenarioIR, ValidateContext } from './contracts.ts';
import { joinPointer, zodIssues } from './issues.ts';
import { findVariables } from './template.ts';

const CONFIG = 'assignment.yaml#';
const LOCALES = ['en', 'sk'];
const RUNTIME_VARS = ['binary', 'workdir', 'fixtures'];
const MAX_NESTING = 20;

type Kind = 'run' | 'session';
interface Produced {
  id: string | undefined;
  kind: Kind;
}

/** The `id` a step names inside its own params (only meaningful for steps that produce a record). */
function paramId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const { id } = params as { id?: unknown };
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function error(path: string, message: string): Issue {
  return { path, message, severity: 'error' };
}
function warning(path: string, message: string): Issue {
  return { path, message, severity: 'warning' };
}
function known(names: string[]): string {
  return names.length === 0 ? 'none registered' : names.sort().join(', ');
}

/**
 * Issues returned by a plugin's `validate()` carry a pointer relative to the step or check (`'/file'`, or
 * `''` for the whole entry); a path that already names a file (`x#/…`) is kept as is.
 */
function anchor(issues: Issue[], pointer: string): Issue[] {
  return issues.map((entry) => (entry.path.includes('#') ? entry : { ...entry, path: joinPointer(pointer, entry.path) }));
}

/** Parses `params` with the registered schema; on success runs the plugin's own `validate()` hook. */
function checkParams<P>(
  def: { params: z.ZodType<P>; validate?: ((params: P, v: ValidateContext) => Issue[]) | undefined },
  params: unknown,
  pointer: string,
  v: ValidateContext,
): { issues: Issue[]; data: { value: P } | undefined } {
  const parsed = def.params.safeParse(params);
  if (!parsed.success) return { issues: zodIssues(parsed.error, pointer), data: undefined };
  if (def.validate === undefined) return { issues: [], data: { value: parsed.data } };
  try {
    return { issues: anchor(def.validate(parsed.data, v), pointer), data: { value: parsed.data } };
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    return { issues: [error(pointer, `validate() threw: ${reason}`)], data: { value: parsed.data } };
  }
}

function validateConfig(loaded: LoadedAssignment): Issue[] {
  const { config, app, dir } = loaded;
  const issues: Issue[] = [];

  if (!LOCALES.includes(config.locale)) {
    issues.push(error(`${CONFIG}/locale`, `unknown locale '${config.locale}' (available: ${LOCALES.join(', ')})`));
  }

  if (config.groups !== undefined) {
    const seen = new Set<string>();
    for (const [i, group] of config.groups.entries()) {
      if (seen.has(group.id)) issues.push(error(`${CONFIG}/groups/${i}/id`, `duplicate group id '${group.id}'`));
      seen.add(group.id);
      if (typeof group.title === 'object' && !Object.hasOwn(group.title, config.locale)) {
        issues.push(warning(`${CONFIG}/groups/${i}/title`, `title has no '${config.locale}' translation`));
      }
    }
    const sum = config.groups.reduce((total, group) => total + group.points, 0);
    if (Math.abs(sum - config.max_points) > 1e-9) {
      issues.push(error(`${CONFIG}/groups`, `group points sum to ${sum}, but max_points is ${config.max_points}`));
    }
  }

  const { type, ...buildParams } = config.build;
  const builder = app.lookup('builder', type);
  if (builder === undefined) {
    const names = app.list('builder').map((entry) => entry.name);
    issues.push(error(`${CONFIG}/build/type`, `unknown builder '${type}' (available: ${known(names)})`));
  } else {
    const parsed = builder.params.safeParse(buildParams);
    if (!parsed.success) issues.push(...zodIssues(parsed.error, `${CONFIG}/build`));
  }

  if (app.lookup('scorer', config.scoring.use) === undefined) {
    const names = app.list('scorer').map((entry) => entry.name);
    issues.push(error(`${CONFIG}/scoring/use`, `unknown scorer '${config.scoring.use}' (available: ${known(names)})`));
  }

  if (config.template !== undefined && !existsSync(resolve(dir, config.template))) {
    issues.push(error(`${CONFIG}/template`, `template directory '${config.template}' does not exist`));
  }
  return issues;
}

/** Checks one check (and its nested checks) against the registries and the scenario's record producers. */
function validateCheck(
  loaded: LoadedAssignment,
  scenario: ScenarioIR,
  spec: CheckSpec,
  produced: Produced[],
  v: ValidateContext,
  inheritedFrom: string | undefined,
  depth: number,
): Issue[] {
  const { app } = loaded;
  const { pointer } = spec;
  const def: CheckDef | undefined = app.lookup('check', spec.name);
  if (def === undefined) {
    const names = app.list('check').map((entry) => entry.name);
    return [error(pointer, `unknown check '${spec.name}' (available: ${known(names)})`)];
  }

  const { issues, data } = checkParams(def, spec.params, pointer, v);
  const from = spec.from ?? inheritedFrom;

  // source scoping (§6): which record the check reads must exist in this scenario
  if (def.source === 'none') {
    if (spec.from !== undefined) {
      if (def.nested === undefined) {
        issues.push(error(`${pointer}/from`, `check '${spec.name}' does not read a record; remove from`));
      } else if (!produced.some((entry) => entry.id === spec.from)) {
        // a composite only passes `from` on to its nested checks, which are validated against it below
        const why = scenario.steps.some((step) => step.id === spec.from) ? 'is a step that produces no run or session' : 'does not match any step id';
        issues.push(error(`${pointer}/from`, `from '${spec.from}' ${why}`));
      }
    }
  } else if (from !== undefined) {
    const target = produced.find((entry) => entry.id === from);
    const at = spec.from === undefined ? pointer : `${pointer}/from`;
    if (target === undefined) {
      const isStep = scenario.steps.some((step) => step.id === from);
      const why = isStep ? 'is a step that produces no run or session' : 'does not match any step id';
      issues.push(error(at, `from '${from}' ${why}`));
    } else if (def.source !== 'either' && target.kind !== def.source) {
      issues.push(error(at, `check '${spec.name}' reads a ${def.source} (source: ${def.source}), but step '${from}' produces a ${target.kind}`));
    }
  } else if (def.source === 'either') {
    if (produced.length === 0) {
      issues.push(error(pointer, `check '${spec.name}' reads a run or a session (source: either), but the scenario has no step that produces one`));
    }
  } else if (!produced.some((entry) => entry.kind === def.source)) {
    const others = def.source === 'run' ? 'session' : 'run';
    const hint = produced.length > 0 ? ` (the scenario only produces a ${others})` : '';
    issues.push(error(pointer, `check '${spec.name}' reads a ${def.source} (source: ${def.source}), but the scenario has no step that produces a ${def.source}${hint}`));
  }

  if (def.nested !== undefined && data !== undefined) {
    if (depth >= MAX_NESTING) return [...issues, error(pointer, `checks nested deeper than ${MAX_NESTING} levels`)];
    let children: CheckSpec[] = [];
    try {
      children = def.nested(data.value);
    } catch (thrown) {
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      issues.push(error(pointer, `nested() threw: ${reason}`));
    }
    for (const [i, child] of children.entries()) {
      const childSpec = child.pointer === '' ? { ...child, pointer: `${pointer}/nested/${i}` } : child;
      issues.push(...validateCheck(loaded, scenario, childSpec, produced, v, from, depth + 1));
    }
  }
  return issues;
}

function validateScenario(loaded: LoadedAssignment, scenario: ScenarioIR, v: ValidateContext): Issue[] {
  const { app, config } = loaded;
  const issues: Issue[] = [];
  const { pointer } = scenario;

  // variables: matrix values are substituted at load, so what is left must be a runtime variable
  const allowed = [...Object.keys(scenario.vars), ...RUNTIME_VARS];
  const unknown = (value: unknown, path: string): void => {
    for (const name of findVariables(value)) {
      if (!allowed.includes(name)) issues.push(error(path, `unknown variable \${${name}} (available: ${allowed.join(', ')})`));
    }
  };
  unknown(scenario.id, `${pointer}/id`);
  unknown(scenario.title, `${pointer}/title`);

  if (scenario.group !== undefined) {
    if (findVariables(scenario.group).length > 0) {
      issues.push(error(`${pointer}/group`, 'group is not interpolated: variables are not allowed in a group id'));
    } else if (!(config.groups ?? []).some((group) => group.id === scenario.group)) {
      const hint = config.groups === undefined ? 'assignment.yaml defines no groups' : `known groups: ${known(config.groups.map((group) => group.id))}`;
      issues.push(error(`${pointer}/group`, `unknown group '${scenario.group}' (${hint})`));
    }
  }

  if (typeof scenario.title === 'object' && !Object.hasOwn(scenario.title, config.locale)) {
    issues.push(warning(`${pointer}/title`, `title has no '${config.locale}' translation`));
  }

  const produced: Produced[] = [];
  const ids = new Set<string>();
  for (const step of scenario.steps) {
    unknown(step.params, step.pointer);
    if (step.id !== undefined) {
      if (ids.has(step.id)) issues.push(error(`${step.pointer}/id`, `duplicate step id '${step.id}'`));
      ids.add(step.id);
    }
    const def = app.lookup('step', step.name);
    if (def === undefined) {
      const names = app.list('step').map((entry) => entry.name);
      issues.push(error(step.pointer, `unknown step '${step.name}' (available: ${known(names)})`));
      continue;
    }
    if (def.produces !== undefined) {
      // A producing step may also be named from inside its params (`session: { id: s1 }`): both ids are valid `from` targets.
      const inner = paramId(step.params);
      if (inner !== undefined && inner !== step.id) {
        if (ids.has(inner)) issues.push(error(`${step.pointer}/id`, `duplicate step id '${inner}'`));
        ids.add(inner);
        produced.push({ id: inner, kind: def.produces });
      }
      if (inner === undefined || step.id !== undefined) produced.push({ id: step.id, kind: def.produces });
    }
    issues.push(...checkParams(def, step.params, step.pointer, v).issues);
  }

  for (const check of scenario.expect) {
    unknown(check.params, check.pointer);
    issues.push(...validateCheck(loaded, scenario, check, produced, v, undefined, 0));
  }
  return issues;
}

/**
 * All static checks of a loaded assignment. Load-time problems (`loaded.issues`) are not repeated here;
 * callers report both lists. Equal issues (e.g. from the scenarios of one matrix) are reported once.
 */
export function validateAssignment(loaded: LoadedAssignment): Issue[] {
  const fixturesDir = join(loaded.dir, 'fixtures');
  const v: ValidateContext = {
    assignmentDir: loaded.dir,
    fixturesDir,
    fixtureExists(rel) {
      const target = resolve(fixturesDir, rel);
      const inside = relative(fixturesDir, target);
      if (inside.startsWith('..') || isAbsolute(inside)) return false;
      return existsSync(target);
    },
    knownVars: RUNTIME_VARS,
  };

  const issues = validateConfig(loaded);
  const firstSeen = new Map<string, string>();
  for (const scenario of loaded.scenarios) {
    const first = firstSeen.get(scenario.id);
    if (first === undefined) firstSeen.set(scenario.id, scenario.pointer);
    else if (first !== scenario.pointer) {
      issues.push(error(`${scenario.pointer}/id`, `duplicate scenario id '${scenario.id}' (first defined at ${first})`));
    }
    const scoped: ValidateContext = { ...v, knownVars: [...Object.keys(scenario.vars), ...RUNTIME_VARS] };
    issues.push(...validateScenario(loaded, scenario, scoped));
  }

  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.severity}\0${entry.path}\0${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
