import { z } from 'zod';
import type { CheckContext, CheckDef, CheckOutcome, Issue, ScenarioContext, SessionRecord } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { SessionHandle, screenIncludes, screenMatches as matchesScreen } from '../../core/session.ts';
import { normalizeText } from '../../core/workspace.ts';
import { clip, compile, containsOf, containsParams, fold, matchesOf, matchesParams, prepare } from '../shared.ts';

const DEFAULT_EXPECT_SEC = 5;

const error = (path: string, message: string): Issue => ({ path, message, severity: 'error' });
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- nested steps -------------------------------------------------------------------------

const seconds = z.number().positive();

const nestedStep = z.union([
  z.strictObject({ send: z.string() }), // text + Enter
  z.strictObject({ type: z.string() }), // text, no Enter
  z.strictObject({ press: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
  z.strictObject({
    expect_screen: z.union([
      z.string(),
      z.strictObject({ text: z.string(), timeout: seconds.optional() }),
      z.strictObject({ pattern: z.string(), timeout: seconds.optional() }),
    ]),
  }),
  z.strictObject({
    wait_exit: z.preprocess((value) => value ?? {}, z.strictObject({ timeout: seconds.optional() })), // `wait_exit:` with no parameters
  }),
]);
type Nested = z.output<typeof nestedStep>;

const sessionParams = z.preprocess(
  (value) => value ?? {}, // `session:` with no parameters
  z.strictObject({
    args: z.array(z.string()).default([]),
    id: z.string().min(1).optional(),
    rows: z.number().int().positive().optional(),
    cols: z.number().int().positive().optional(),
    timeout: seconds.optional(), // seconds for the whole session
    env: z.record(z.string(), z.string()).optional(),
    steps: z.array(nestedStep).default([]),
  }),
);
type SessionParams = z.output<typeof sessionParams>;

/** The regular expression of an `expect_screen`; `m` so that `^`/`$` anchor at line boundaries. */
const SCREEN_FLAGS = 'm';

interface Budget {
  /** Milliseconds left until the session deadline (never negative). */
  left(): number;
}

/** Runs one nested step; resolves to a failure message, or undefined when the step succeeded. */
async function runNested(ctx: ScenarioContext, handle: SessionHandle, step: Nested, budget: Budget): Promise<string | undefined> {
  const limit = (sec: number | undefined, fallbackSec?: number): number => {
    const wanted = sec ?? fallbackSec;
    return wanted === undefined ? budget.left() : Math.min(Math.round(wanted * 1000), budget.left());
  };
  if ('send' in step) {
    await handle.send(ctx.interpolate(step.send));
  } else if ('type' in step) {
    await handle.type(ctx.interpolate(step.type));
  } else if ('press' in step) {
    await handle.press(...(typeof step.press === 'string' ? [step.press] : step.press));
  } else if ('expect_screen' in step) {
    const spec = step.expect_screen;
    const o = typeof spec === 'string' ? { text: spec } : spec;
    const regex = 'pattern' in o;
    const wanted = ctx.interpolate(regex ? o.pattern : o.text);
    const timeoutMs = limit(o.timeout, DEFAULT_EXPECT_SEC);
    const seen = await handle.expectScreen(wanted, { regex, timeoutMs });
    if (!seen) return `the screen ${regex ? 'did not match' : 'did not show'} ${JSON.stringify(wanted)} within ${timeoutMs} ms`;
  } else {
    await handle.waitExit(limit(step.wait_exit.timeout)); // a timeout is not a failure: the program is judged by the checks
  }
  return undefined;
}

const nestedName = (step: Nested): string => Object.keys(step)[0] ?? '?';

async function sessionStep(ctx: ScenarioContext, params: SessionParams): Promise<void> {
  const binary = ctx.binaryPath;
  if (binary === undefined) throw new Error('build_failed');
  const id = ctx.currentStepId ?? `session-${ctx.sessions.size + 1}`;
  if (params.id !== undefined && params.id !== id && (ctx.sessions.has(params.id) || ctx.runs.has(params.id))) {
    throw new Error(`duplicate step id '${params.id}'`); // never overwrite another record
  }
  const timeoutMs = params.timeout === undefined ? ctx.limits.runTimeoutMs : Math.round(params.timeout * 1000);
  const env = params.env === undefined ? undefined : ctx.interpolate(params.env);

  const started = performance.now();
  const budget: Budget = { left: () => Math.max(0, Math.round(timeoutMs - (performance.now() - started))) };
  let handle: SessionHandle;
  try {
    handle = await SessionHandle.start(binary, ctx.interpolate(params.args), {
      cwd: ctx.workdir,
      ...(env === undefined ? {} : { env }),
      ...(params.rows === undefined ? {} : { rows: params.rows }),
      ...(params.cols === undefined ? {} : { cols: params.cols }),
    });
  } catch (e) {
    throw new Error(`cannot start the program: ${messageOf(e)}`);
  }

  let failure: string | undefined;
  let record: SessionRecord;
  try {
    for (const [index, step] of params.steps.entries()) {
      let problem: string | undefined;
      try {
        problem = await runNested(ctx, handle, step, budget);
      } catch (e) {
        problem = messageOf(e);
      }
      if (problem !== undefined) {
        failure = `nested step ${index + 1} (${nestedName(step)}) failed: ${problem}`;
        break;
      }
    }
    // After a failure the program is not waited for: it is only inspected and then killed by close().
    const exit = await handle.waitExit(failure === undefined ? budget.left() : 0);
    record = {
      id,
      screen: await handle.screen(),
      exitCode: exit.exitCode,
      exited: exit.exited,
      timedOut: failure === undefined && !exit.exited,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    await handle.close(); // always: kills a program that is still running
  }

  // The record is registered even when a nested step failed, so screen/exit checks can still evaluate.
  ctx.sessions.set(id, record);
  if (params.id !== undefined) ctx.sessions.set(params.id, record);
  ctx.lastSession = record;
  if (failure !== undefined) throw new Error(failure);
}

function validateSession(params: SessionParams): Issue[] {
  const issues: Issue[] = [];
  params.steps.forEach((step, index) => {
    if (!('expect_screen' in step) || typeof step.expect_screen === 'string' || !('pattern' in step.expect_screen)) return;
    try {
      new RegExp(step.expect_screen.pattern, SCREEN_FLAGS);
    } catch (e) {
      issues.push(error(`/steps/${index}/expect_screen/pattern`, `invalid regular expression: ${messageOf(e)}`));
    }
  });
  return issues;
}

// ---- screen checks ------------------------------------------------------------------------

const screenOf = (ctx: CheckContext): string => normalizeText(ctx.session?.screen ?? '');

const screenContains: CheckDef<z.output<typeof containsParams>> = {
  description: 'Passes when the final screen of the session contains the text, which may span several lines (blank cells at the end of its last line count, so "> " matches a bare prompt).',
  example: '- screen_contains: "> "\n- screen_contains: { text: "uspesnost", ignore_case: true, fold_diacritics: true }',
  params: containsParams,
  source: 'session',
  describe: (p, t) => t('check.screen_contains', { text: containsOf(p).text }),
  async run(ctx, p): Promise<CheckOutcome> {
    const c = containsOf(p);
    const text = ctx.interpolate(c.text);
    const screen = screenOf(ctx);
    if (screenIncludes(prepare(screen, c), prepare(text, c))) return { pass: true };
    return { pass: false, message: 'the screen does not contain the expected text', expected: text, actual: clip(screen) };
  },
};

/** Screen patterns anchor per line, like `expect_screen`. */
function screenPattern(p: z.output<typeof matchesParams>): ReturnType<typeof matchesOf> {
  const m = matchesOf(p);
  return m.flags.includes('m') ? m : { ...m, flags: `${m.flags}${SCREEN_FLAGS}` };
}

const screenMatches: CheckDef<z.output<typeof matchesParams>> = {
  description: 'Passes when the final screen of the session matches the regular expression (^ and $ match at line boundaries).',
  example: "- screen_matches: '^total: \\d+$'\n- screen_matches: { pattern: 'MENU', ignore_case: true }",
  params: matchesParams,
  source: 'session',
  validate(p) {
    const regex = compile(screenPattern(p));
    return typeof regex === 'string' ? [error('', regex)] : [];
  },
  describe: (p, t) => t('check.screen_matches', { pattern: matchesOf(p).pattern }),
  async run(ctx, p): Promise<CheckOutcome> {
    const m = screenPattern(p);
    const regex = compile(m);
    if (typeof regex === 'string') return { pass: false, message: regex, expected: m.pattern };
    const screen = screenOf(ctx);
    if (matchesScreen(m.foldDiacritics ? fold(screen) : screen, regex)) return { pass: true };
    return { pass: false, message: 'the screen does not match the pattern', expected: m.pattern, actual: clip(screen) };
  },
};

export const stepsSession = fp(
  (app) => {
    app.step('session', {
      description:
        'Runs the student program in a terminal (PTY), performs the nested steps (send, type, press, expect_screen, wait_exit), then waits for the program to exit and records the final screen. `timeout` (seconds, default: the run timeout) bounds the whole session; a program still running at the end is killed.',
      example:
        '- session:\n    steps:\n      - expect_screen: "> "\n      - send: "index one-word.txt"\n      - expect_screen: { pattern: "indexed \\d+", timeout: 3 }\n      - press: Ctrl+D',
      params: sessionParams,
      produces: 'session',
      validate: validateSession,
      run: sessionStep,
    });
    app.check('screen_contains', screenContains);
    app.check('screen_matches', screenMatches);
  },
  { name: 'steps-session' },
);
