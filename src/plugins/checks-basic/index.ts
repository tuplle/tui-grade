import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { CheckContext, CheckDef, CheckOutcome, CheckResult, CheckSpec, Issue, Translate, ValidateContext } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { normalizeCheck } from '../../core/scenario.ts';
import { normalizeText, safeJoin } from '../../core/workspace.ts';
import { type TextOptions, clip, compile, containsOf, containsParams, fold, loadScript, matchesOf, matchesParams, prepare, readGuardedText, workdirPath } from '../shared.ts';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const error = (path: string, message: string): Issue => ({ path, message, severity: 'error' });

type Stream = 'stdout' | 'stderr';

const streamText = (ctx: CheckContext, stream: Stream): string => normalizeText(ctx.run?.[stream] ?? '');

function containsCheck(stream: Stream): CheckDef<z.output<typeof containsParams>> {
  const key = `${stream}_contains`;
  return {
    description: `Passes when the program's ${stream} contains the text (line endings and ANSI escapes are normalized).`,
    example: `- ${key}: "Help"\n- ${key}: { text: "uspesnost", ignore_case: true, fold_diacritics: true }`,
    params: containsParams,
    source: 'run',
    describe: (p, t) => t(`check.${key}`, { text: containsOf(p).text }),
    async run(ctx, p): Promise<CheckOutcome> {
      const c = containsOf(p);
      const text = ctx.interpolate(c.text);
      const output = streamText(ctx, stream);
      if (prepare(output, c).includes(prepare(text, c))) return { pass: true };
      return { pass: false, message: `${stream} does not contain the expected text`, expected: text, actual: clip(output) };
    },
  };
}

function matchesCheck(stream: Stream): CheckDef<z.output<typeof matchesParams>> {
  const key = `${stream}_matches`;
  return {
    description: `Passes when the program's ${stream} matches the regular expression (line endings and ANSI escapes are normalized).`,
    example: `- ${key}: '\\b100\\.00%'\n- ${key}: { pattern: '^total: \\d+$', flags: m }`,
    params: matchesParams,
    source: 'run',
    validate(p) {
      const regex = compile(matchesOf(p));
      return typeof regex === 'string' ? [error('', regex)] : [];
    },
    describe: (p, t) => t(`check.${key}`, { pattern: matchesOf(p).pattern }),
    async run(ctx, p): Promise<CheckOutcome> {
      const m = matchesOf(p);
      const regex = compile(m);
      if (typeof regex === 'string') return { pass: false, message: regex, expected: m.pattern };
      const output = streamText(ctx, stream);
      if (regex.test(m.foldDiacritics ? fold(output) : output)) return { pass: true };
      return { pass: false, message: `${stream} does not match the pattern`, expected: m.pattern, actual: clip(output) };
    },
  };
}

// ---- exit code ----------------------------------------------------------------------------

const exitCodeParams = z.union([z.number().int(), z.literal('nonzero')]);

const exitCode: CheckDef<z.output<typeof exitCodeParams>> = {
  description: "Passes when the program exited with the given code, or with any non-zero code ('nonzero').",
  example: "- exit_code: 0\n- exit_code: nonzero",
  params: exitCodeParams,
  source: 'either',
  describe: (p, t) => (p === 'nonzero' ? t('check.exit_code_nonzero') : t('check.exit_code', { code: p })),
  async run(ctx, p): Promise<CheckOutcome> {
    const expected = p === 'nonzero' ? 'non-zero exit code' : String(p);
    const record = ctx.run ?? ctx.session;
    if (record === undefined) return { pass: false, message: 'no run or session available', expected };
    if (ctx.run === undefined && ctx.session !== undefined && !ctx.session.exited) {
      return { pass: false, message: 'the program has not exited', expected, actual: 'still running' };
    }
    const code = record.exitCode;
    if (code === null) {
      const signal = ctx.run?.signal;
      const actual = signal ? `killed by ${signal}` : 'no exit code';
      return { pass: false, message: 'the program did not exit normally', expected, actual };
    }
    const pass = p === 'nonzero' ? code !== 0 : code === p;
    return pass ? { pass } : { pass, message: `unexpected exit code ${code}`, expected, actual: String(code) };
  },
};

// ---- files --------------------------------------------------------------------------------

type Resolved = { path: string } | { failure: CheckOutcome };

function resolveFile(ctx: CheckContext, rel: string): Resolved {
  try {
    return { path: workdirPath(ctx, rel) };
  } catch (e) {
    return { failure: { pass: false, message: messageOf(e) } };
  }
}

/** Reads a workdir file as normalized text; a failure outcome when it cannot be read. */
async function readText(ctx: CheckContext, rel: string): Promise<{ text: string } | { failure: CheckOutcome }> {
  const file = resolveFile(ctx, rel);
  if ('failure' in file) return file;
  // The file is student-created: guarded read (regular file, size-capped, never blocks on a FIFO).
  return readGuardedText(file.path, rel, ctx.limits.outputLimitBytes);
}

const pathParam = z.string().min(1);
const fileContainsParams = z.strictObject({ path: pathParam, text: z.string(), ignore_case: z.boolean().optional() });

const fileExists: CheckDef<string> = {
  description: 'Passes when the file or directory exists in the scenario workdir.',
  example: '- file_exists: output.txt',
  params: pathParam,
  source: 'none',
  describe: (path, t) => t('check.file_exists', { path }),
  async run(ctx, path): Promise<CheckOutcome> {
    const file = resolveFile(ctx, path);
    if ('failure' in file) return file.failure;
    const found = await stat(file.path).then(
      () => true,
      () => false,
    );
    return found ? { pass: true } : { pass: false, message: `file not found: ${path}`, expected: path };
  },
};

const fileContains: CheckDef<z.output<typeof fileContainsParams>> = {
  description: 'Passes when the file in the scenario workdir contains the text (line endings are normalized).',
  example: '- file_contains: { path: output.txt, text: "done", ignore_case: true }',
  params: fileContainsParams,
  source: 'none',
  describe: (p, t) => t('check.file_contains', { path: p.path, text: p.text }),
  async run(ctx, p): Promise<CheckOutcome> {
    const content = await readText(ctx, p.path);
    if ('failure' in content) return content.failure;
    const o: TextOptions = { ignoreCase: p.ignore_case === true, foldDiacritics: false };
    const text = ctx.interpolate(p.text);
    if (prepare(content.text, o).includes(prepare(text, o))) return { pass: true };
    return { pass: false, message: `file '${p.path}' does not contain the expected text`, expected: text, actual: clip(content.text) };
  },
};

const fileEmpty: CheckDef<string> = {
  description: 'Passes when the file exists and is empty or contains only whitespace.',
  example: '- file_empty: errors.log',
  params: pathParam,
  source: 'none',
  describe: (path, t) => t('check.file_empty', { path }),
  async run(ctx, path): Promise<CheckOutcome> {
    const content = await readText(ctx, path);
    if ('failure' in content) return content.failure;
    if (content.text.trim() === '') return { pass: true };
    return { pass: false, message: `file '${path}' is not empty`, expected: 'empty file', actual: clip(content.text) };
  },
};

// ---- composites ---------------------------------------------------------------------------

const compositeParams = z.array(z.record(z.string(), z.unknown())).min(1);
type Composite = z.output<typeof compositeParams>;

/** Children are check objects in the scenario's own shape (one name key plus modifiers). */
function nestedSpecs(items: Composite): CheckSpec[] {
  return items.map((item, i) => {
    const issues: Issue[] = [];
    const spec = normalizeCheck(item, '', issues);
    if (spec === null) throw new Error(`item ${i}: ${issues.map((entry) => entry.message).join('; ')}`);
    return spec;
  });
}

/**
 * `name: value` for the main parameter of a child, used in the composite's description. A hidden child
 * contributes only the generic `report.check.hidden` label: the parent is reported as a visible check,
 * so nothing of what the hidden child looks for may appear in its description.
 */
function summarize(spec: CheckSpec, t: Translate): string {
  if (spec.hidden) return t('report.check.hidden');
  const text = summarizeParams(spec);
  return spec.not ? t('check.not', { description: text }) : text;
}

function summarizeParams(spec: CheckSpec): string {
  const { params } = spec;
  if (typeof params === 'string' || typeof params === 'number') return `${spec.name}: ${params}`;
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    for (const key of ['text', 'pattern', 'path']) {
      const value = (params as Record<string, unknown>)[key];
      if (typeof value === 'string') return `${spec.name}: ${value}`;
    }
  }
  return spec.name;
}

function describeComposite(key: 'any_of' | 'all_of', items: Composite, t: Translate): string {
  const checks = nestedSpecs(items).map((spec) => summarize(spec, t)).join(', ');
  return t(`check.${key}`, { checks });
}

function composite(key: 'any_of' | 'all_of'): CheckDef<Composite> {
  const any = key === 'any_of';
  return {
    description: any ? 'Passes when at least one of the nested checks passes.' : 'Passes when all of the nested checks pass.',
    example: any
      ? '- any_of:\n    - stdout_contains: "Help"\n    - stdout_contains: "Pomoc"'
      : '- all_of:\n    - stdout_contains: "a"\n    - exit_code: 0',
    params: compositeParams,
    source: 'none', // the children read their own records
    nested: nestedSpecs,
    describe: (items, t) => describeComposite(key, items, t),
    async run(ctx, items): Promise<CheckOutcome> {
      const results: CheckResult[] = [];
      for (const spec of nestedSpecs(items)) results.push(await ctx.evaluate(spec));
      const failed = results.filter((r) => !r.pass);
      // Hidden children are listed by the generic label only: no description, message, expected or actual.
      const detail = (rs: CheckResult[]): string =>
        rs
          .map((r) => {
            if (r.hidden) return ctx.t('report.check.hidden');
            return r.message === undefined ? r.description : `${r.description} (${r.message})`;
          })
          .join('; ');
      if (any) {
        if (results.some((r) => r.pass)) return { pass: true };
        return { pass: false, message: `none of the checks passed: ${detail(results)}` };
      }
      if (failed.length === 0) return { pass: true };
      return { pass: false, message: `failed: ${detail(failed)}` };
    },
  };
}

// ---- script -------------------------------------------------------------------------------

const scriptParams = z.strictObject({ path: z.string().min(1), options: z.unknown().optional() });

const scriptCheck: CheckDef<z.output<typeof scriptParams>> = {
  description: 'Runs a custom ES module from the assignment: its default export is called with (ctx, options) and returns a CheckOutcome.',
  example: '- script: { path: scripts/check-output.mjs, options: { min: 3 } }',
  params: scriptParams,
  source: 'none',
  validate(p, v: ValidateContext) {
    let file: string;
    try {
      file = safeJoin(v.assignmentDir, p.path);
    } catch (e) {
      return [error('/path', messageOf(e))];
    }
    return existsSync(file) ? [] : [error('/path', `script not found: ${p.path}`)];
  },
  describe: (p, t) => t('check.script', { path: p.path }),
  async run(ctx, p): Promise<CheckOutcome> {
    try {
      const fn = await loadScript(ctx.assignmentDir, ctx.interpolate(p.path));
      const outcome = (await fn(ctx, ctx.interpolate(p.options))) as unknown;
      if (outcome === null || typeof outcome !== 'object' || typeof (outcome as { pass?: unknown }).pass !== 'boolean') {
        return { pass: false, message: `script '${p.path}' must return a CheckOutcome ({ pass: boolean, ... })` };
      }
      return outcome as CheckOutcome;
    } catch (e) {
      return { pass: false, message: messageOf(e) };
    }
  },
};

export const checksBasic = fp(
  (app) => {
    app.check('exit_code', exitCode);
    app.check('stdout_contains', containsCheck('stdout'));
    app.check('stdout_matches', matchesCheck('stdout'));
    app.check('stderr_contains', containsCheck('stderr'));
    app.check('stderr_matches', matchesCheck('stderr'));
    app.check('file_exists', fileExists);
    app.check('file_contains', fileContains);
    app.check('file_empty', fileEmpty);
    app.check('any_of', composite('any_of'));
    app.check('all_of', composite('all_of'));
    app.check('script', scriptCheck);
  },
  { name: 'checks-basic' },
);
