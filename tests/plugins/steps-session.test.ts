import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessions } from '@microsoft/tui-test';
import { App } from '../../src/core/app.ts';
import type { CheckSpec, ScenarioContext, ScenarioIR, StepSpec, ValidateContext } from '../../src/core/contracts.ts';
import { type ScenarioEnv, createScenarioContext, evaluateCheck, executeStep, runScenario } from '../../src/core/execute.ts';
import { removeDir } from '../../src/core/workspace.ts';
import { checksBasic } from '../../src/plugins/checks-basic/index.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { stepsSession } from '../../src/plugins/steps-session/index.ts';
import { withTempDir } from '../helpers/tmp.ts';

const step = (name: string, params: unknown, id?: string): StepSpec => ({
  name,
  params,
  ...(id === undefined ? {} : { id }),
  pointer: `#/steps/${name}`,
});
const check = (name: string, params: unknown, over: Partial<CheckSpec> = {}): CheckSpec => ({
  name,
  params,
  weight: 1,
  hidden: false,
  not: false,
  pointer: `#/expect/${name}`,
  ...over,
});

/** Prints `> `, reads a line, prints `got:<line>`, exits 3. */
const ECHO = 'printf "> "; read x; echo "got:$x"; exit 3';

async function makeApp(): Promise<App> {
  const app = new App();
  await app.register(stepsSession);
  await app.register(checksBasic);
  return app;
}

interface Harness {
  ctx: ScenarioContext;
  dir: string;
  run(spec: StepSpec): ReturnType<typeof executeStep>;
}

async function withHarness(body: string, fn: (h: Harness) => Promise<void>, env: Partial<ScenarioEnv> = {}): Promise<void> {
  await withTempDir(async (dir) => {
    const assignmentDir = join(dir, 'assignment');
    await mkdir(assignmentDir, { recursive: true });
    const program = join(dir, 'prog.sh');
    await writeFile(program, `#!/bin/sh\n${body}\n`);
    await chmod(program, 0o755);
    const ctx = await createScenarioContext(
      {
        app: await makeApp(),
        submission: { id: 'stu' } as ScenarioEnv['submission'],
        binaryPath: program,
        projectDir: dir,
        build: undefined,
        locale: 'en',
        t: (key) => key,
        assignmentDir,
        limits: { runTimeoutMs: 10_000, outputLimitBytes: 1024 * 1024 },
        log: () => {},
        ...env,
      },
      { id: 's', title: 's', weight: 1, steps: [], expect: [], file: 'f.yaml', pointer: '#/0', vars: {} },
    );
    try {
      await fn({ ctx, dir, run: (spec) => executeStep(ctx, spec) });
    } finally {
      await removeDir(ctx.workdir);
    }
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};

const validateCtx: ValidateContext = { assignmentDir: '/nonexistent', fixturesDir: '/nonexistent/fixtures', fixtureExists: () => true, knownVars: [] };

const spawned: number[] = [];
afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
  expect(await sessions()).toEqual([]); // every session is closed
});

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (/^\d+\n/.test(text)) {
      const pid = Number(text.trim());
      spawned.push(pid);
      return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pid in ${file}`);
}

describe('registration', () => {
  it('is a builtin plugin and part of the default preset', async () => {
    expect(builtinPlugins['steps-session']).toBe(stepsSession);
    expect(stepsSession.meta.name).toBe('steps-session');
    const app = new App();
    await app.register(defaultPreset);
    expect(app.lookup('step', 'session')?.produces).toBe('session');
    expect(app.lookup('check', 'screen_contains')?.source).toBe('session');
    expect(app.lookup('check', 'screen_matches')?.source).toBe('session');
  });
});

describe('session step', () => {
  it('drives an interactive program and registers the record', async () => {
    await withHarness(ECHO, async ({ ctx, run }) => {
      const record = await run(
        step('session', { steps: [{ expect_screen: '> ' }, { send: 'hi' }, { expect_screen: 'got:hi' }] }),
      );
      expect(record).toMatchObject({ name: 'session', id: 'session-1', ok: true });
      const session = ctx.sessions.get('session-1');
      expect(session).toBeDefined();
      expect(ctx.lastSession).toBe(session);
      expect(session).toMatchObject({ id: 'session-1', exited: true, exitCode: 3, timedOut: false, screen: '> hi\ngot:hi' });
      expect(session?.durationMs).toBeGreaterThan(0);
      expect((await evaluateCheck(ctx, check('exit_code', 3))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('exit_code', 0))).pass).toBe(false);
    });
  });

  it('uses the step id, and also registers an id given in the params', async () => {
    await withHarness('echo hello', async ({ ctx, run }) => {
      expect((await run(step('session', {}, 'first'))).ok).toBe(true);
      expect((await run(step('session', { id: 'second' }))).ok).toBe(true);
      expect([...ctx.sessions.keys()].sort()).toEqual(['first', 'second', 'session-1']);
      expect(ctx.sessions.get('second')).toBe(ctx.sessions.get('session-1'));
      expect(ctx.lastSession?.screen).toBe('hello');
    });
  });

  it('interpolates args and passes env, rows and cols', async () => {
    await withHarness('echo "$1|$FOO"; tput lines; tput cols', async ({ ctx, run }) => {
      const r = await run(step('session', { args: ['${workdir}/x'], env: { FOO: 'bar' }, rows: 15, cols: 44 }));
      expect(r.ok).toBe(true);
      expect(ctx.lastSession?.screen).toBe(`${ctx.workdir}/x|bar\n15\n44`);
    });
  });

  it('fails with build_failed when there is no binary', async () => {
    await withHarness(
      'true',
      async ({ ctx, run }) => {
        const r = await run(step('session', {}));
        expect(r).toMatchObject({ ok: false, message: 'build_failed' });
        expect(ctx.sessions.size).toBe(0);
      },
      { binaryPath: undefined },
    );
  });

  it('a failing expect_screen fails the step after its timeout, skips the rest and still registers the screen', async () => {
    await withHarness('echo "$$" > pid.txt; echo "hello"; read x; echo "got:$x" > got.txt; sleep 30', async ({ ctx, run }) => {
      const started = Date.now();
      const r = await run(
        step('session', {
          steps: [{ expect_screen: 'hello' }, { expect_screen: { text: 'never shown', timeout: 0.3 } }, { send: 'skipped' }],
        }),
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/expect_screen/);
      expect(r.message).toMatch(/never shown/);
      const session = ctx.sessions.get('session-1');
      expect(session).toMatchObject({ screen: 'hello', exited: false, timedOut: false });
      expect(ctx.lastSession).toBe(session);
      // the skipped send never reached the program, and the program is dead
      await expect(readFile(join(ctx.workdir, 'got.txt'), 'utf8')).rejects.toThrow();
      expect(await gone(Number((await readFile(join(ctx.workdir, 'pid.txt'), 'utf8')).trim()))).toBe(true);
      // screen checks still evaluate on the final screen
      expect((await evaluateCheck(ctx, check('screen_contains', 'hello'))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('exit_code', 0))).pass).toBe(false);
    });
  });

  it('kills a program that never exits at the session timeout', async () => {
    await withHarness('echo "$$" > pid.txt; echo started; sleep 30', async ({ ctx, run }) => {
      const r = await run(step('session', { timeout: 0.6, steps: [{ expect_screen: 'started' }] }));
      expect(r.ok).toBe(true);
      expect(ctx.lastSession).toMatchObject({ timedOut: true, exited: false, exitCode: null, screen: 'started' });
      expect(await gone(Number((await readFile(join(ctx.workdir, 'pid.txt'), 'utf8')).trim()))).toBe(true);
      const exit = await evaluateCheck(ctx, check('exit_code', 0));
      expect(exit.pass).toBe(false);
      expect(exit.message).toMatch(/not exited/);
      expect((await evaluateCheck(ctx, check('screen_contains', 'started'))).pass).toBe(true);
    });
  });

  it('defaults the timeout to limits.runTimeoutMs, which also bounds the nested steps', async () => {
    await withHarness(
      'sleep 30',
      async ({ ctx, run }) => {
        const started = Date.now();
        const r = await run(step('session', { steps: [{ expect_screen: { text: 'never', timeout: 20 } }] }));
        expect(Date.now() - started).toBeLessThan(5000);
        expect(r.ok).toBe(false);
        expect(ctx.lastSession).toMatchObject({ exited: false });
      },
      { limits: { runTimeoutMs: 500, outputLimitBytes: 1024 } },
    );
    await withHarness(
      'sleep 30',
      async ({ ctx, run }) => {
        expect((await run(step('session', {}))).ok).toBe(true);
        expect(ctx.lastSession).toMatchObject({ timedOut: true });
      },
      { limits: { runTimeoutMs: 500, outputLimitBytes: 1024 } },
    );
  });

  it('press Ctrl+D ends input so the program exits', async () => {
    await withHarness('cat >/dev/null; echo eof-seen; exit 0', async ({ ctx, run }) => {
      const r = await run(step('session', { steps: [{ type: 'abc' }, { press: 'Ctrl+D' }, { press: ['Ctrl+D'] }, { wait_exit: { timeout: 3 } }] }));
      expect(r.ok).toBe(true);
      expect(ctx.lastSession).toMatchObject({ exited: true, exitCode: 0, timedOut: false });
      expect(ctx.lastSession?.screen).toContain('eof-seen');
    });
  });

  it('wait_exit that times out does not fail the step; the program is still waited for at the end', async () => {
    await withHarness('sleep 1; echo done', async ({ ctx, run }) => {
      const r = await run(step('session', { timeout: 10, steps: [{ wait_exit: { timeout: 0.2 } }] }));
      expect(r.ok).toBe(true);
      expect(ctx.lastSession).toMatchObject({ exited: true, exitCode: 0 });
    });
  });

  it('expect_screen accepts a pattern', async () => {
    await withHarness('echo "total: 42"', async ({ run }) => {
      expect((await run(step('session', { steps: [{ expect_screen: { pattern: '^total: \\d+$' } }] }))).ok).toBe(true);
    });
    await withHarness('echo "total: x"', async ({ run }) => {
      const r = await run(step('session', { steps: [{ expect_screen: { pattern: '^total: \\d+$', timeout: 0.2 } }] }));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/total/);
    });
  });

  it('kills a HUP-ignoring program (and its children) at the session timeout and after a failed expectation', async () => {
    const body = "trap '' HUP\necho $$ > pid.txt\nsleep 30 &\necho $! > child.txt\necho started\nwhile :; do sleep 0.1; done";
    await withHarness(body, async ({ ctx, run }) => {
      const r = await run(step('session', { timeout: 0.8, steps: [{ expect_screen: 'started' }] }));
      expect(r.ok).toBe(true);
      expect(ctx.lastSession).toMatchObject({ timedOut: true, exited: false });
      for (const file of ['pid.txt', 'child.txt']) expect(await gone(await readPid(join(ctx.workdir, file)))).toBe(true);
    });
    await withHarness(body, async ({ ctx, run }) => {
      const r = await run(step('session', { steps: [{ expect_screen: { text: 'never', timeout: 0.3 } }] }));
      expect(r.ok).toBe(false);
      for (const file of ['pid.txt', 'child.txt']) expect(await gone(await readPid(join(ctx.workdir, file)))).toBe(true);
    });
  });

  it('refuses a params-level id that is already taken, without starting the program', async () => {
    await withHarness('echo ran >> ran.txt; echo hi', async ({ ctx, run }) => {
      expect((await run(step('session', {}, 'taken'))).ok).toBe(true);
      const first = ctx.sessions.get('taken');
      const r = await run(step('session', { id: 'taken' }));
      expect(r).toMatchObject({ ok: false, message: "duplicate step id 'taken'" });
      expect(ctx.sessions.get('taken')).toBe(first);
      expect((await readFile(join(ctx.workdir, 'ran.txt'), 'utf8')).trim().split('\n')).toEqual(['ran']);
    });
  });

  it('expect_screen accepts text spanning lines (block-scalar style)', async () => {
    await withHarness('printf "Menu:\\n1) Add\\n2) Quit\\n> "; read x', async ({ ctx, run }) => {
      const r = await run(
        step('session', {
          timeout: 5,
          steps: [
            { expect_screen: 'Menu:\n1) Add\n' },
            { expect_screen: { text: '1) Add\n2) Quit\n> ', timeout: 2 } },
            { expect_screen: { pattern: '^Menu:\n1\\) Add\n2\\) Quit$\n', timeout: 2 } },
            { press: 'Enter' },
          ],
        }),
      );
      expect(r.ok).toBe(true);
      expect(ctx.lastSession?.exited).toBe(true);
    });
    await withHarness('printf "Menu:\\n1) Add\\n"', async ({ run }) => {
      const r = await run(step('session', { steps: [{ expect_screen: { text: 'Menu:\n2) Quit', timeout: 0.2 } }] }));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Menu:\\n2\) Quit/);
    });
  });

  it('rejects malformed nested steps and invalid patterns', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      const bad = await run(step('session', { steps: [{ jump: 'x' }] }));
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/invalid parameters/);
      expect((await run(step('session', { steps: [{ send: 'a', type: 'b' }] }))).ok).toBe(false);
      expect((await run(step('session', { steps: [{ expect_screen: { text: 'a', pattern: 'b' } }] }))).ok).toBe(false);
      expect((await run(step('session', { bogus: 1 }))).ok).toBe(false);
      expect(ctx.sessions.size).toBe(0);
      const def = ctx.app.lookup('step', 'session');
      const issues = def?.validate?.(def.params.parse({ steps: [{ expect_screen: '(' }, { expect_screen: { pattern: '(' } }] }), validateCtx);
      expect(issues).toHaveLength(1);
      expect(issues?.[0]).toMatchObject({ severity: 'error', path: '/steps/1/expect_screen/pattern' });
    });
  });

  it('runs inside runScenario and exposes the final screen', async () => {
    await withTempDir(async (dir) => {
      const program = join(dir, 'prog.sh');
      await writeFile(program, `#!/bin/sh\n${ECHO}\n`);
      await chmod(program, 0o755);
      const scenario: ScenarioIR = {
        id: 'inter',
        title: 'interactive',
        weight: 1,
        steps: [step('session', { steps: [{ expect_screen: '> ' }, { send: 'x' }] })],
        expect: [check('screen_contains', 'got:x'), check('exit_code', 3), check('screen_matches', '^got:\\w$', { not: true })],
        file: 'f.yaml',
        pointer: '#/0',
        vars: {},
      };
      const result = await runScenario(
        {
          app: await makeApp(),
          submission: { id: 'stu' } as ScenarioEnv['submission'],
          binaryPath: program,
          projectDir: dir,
          build: undefined,
          locale: 'en',
          t: (key) => key,
          assignmentDir: dir,
          limits: { runTimeoutMs: 10_000, outputLimitBytes: 1024 },
          log: () => {},
        },
        scenario,
      );
      expect(result.checks.map((c) => c.pass)).toEqual([true, true, false]);
      expect(result.status).toBe('failed');
      expect(result.screens).toEqual({ 'session-1': '> x\ngot:x' });
    });
  });
});

describe('screen checks', () => {
  const screenOf = async (body: string, fn: (ctx: ScenarioContext) => Promise<void>): Promise<void> =>
    withHarness(body, async ({ ctx, run }) => {
      expect((await run(step('session', {}))).ok).toBe(true);
      await fn(ctx);
    });

  it('screen_contains sees the final screen after the program exited', async () => {
    await screenOf('printf "Menu:\\n1) Prida\\xc5\\xa5\\n> "', async (ctx) => {
      expect((await evaluateCheck(ctx, check('screen_contains', '1) Pridať'))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('screen_contains', '> '))).pass).toBe(true); // blank cells after a prompt
      const miss = await evaluateCheck(ctx, check('screen_contains', 'Quit'));
      expect(miss).toMatchObject({ pass: false, expected: 'Quit' });
      expect(miss.actual).toContain('Menu:');
      expect((await evaluateCheck(ctx, check('screen_contains', 'MENU:'))).pass).toBe(false);
      expect((await evaluateCheck(ctx, check('screen_contains', { text: 'MENU:', ignore_case: true }))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('screen_contains', { text: '1) Pridat', fold_diacritics: true }))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('screen_contains', 'Quit', { not: true }))).pass).toBe(true);
    });
  });

  it('screen_matches uses a regular expression', async () => {
    await screenOf('echo "count: 12"', async (ctx) => {
      expect((await evaluateCheck(ctx, check('screen_matches', 'count: \\d+'))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('screen_matches', { pattern: 'COUNT', flags: 'i' }))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('screen_matches', { pattern: 'COUNT', ignore_case: true }))).pass).toBe(true);
      const miss = await evaluateCheck(ctx, check('screen_matches', '^count: x$'));
      expect(miss).toMatchObject({ pass: false, expected: '^count: x$' });
      const def = ctx.app.lookup('check', 'screen_matches');
      expect(def?.validate?.('(', validateCtx)?.[0]?.message).toMatch(/invalid regular expression/);
    });
  });

  it('screen_contains and screen_matches accept text spanning lines', async () => {
    await screenOf('printf "Menu:\\n1) Pridat\\n2) Quit\\n> "', async (ctx) => {
      const contains = async (params: unknown): Promise<boolean> => (await evaluateCheck(ctx, check('screen_contains', params))).pass;
      const matches = async (params: unknown): Promise<boolean> => (await evaluateCheck(ctx, check('screen_matches', params))).pass;
      expect(await contains('Menu:\n1) Pridat')).toBe(true);
      expect(await contains('Menu:\n1) Pridat\n2) Quit\n')).toBe(true); // trailing newline of a block scalar
      expect(await contains('2) Quit\n> ')).toBe(true);
      expect(await contains('Menu:\r\n1) Pridat')).toBe(true);
      expect(await contains({ text: 'MENU:\n1) PRIDAT', ignore_case: true })).toBe(true);
      expect(await contains({ text: 'Menu:\n1) Pridať', fold_diacritics: true })).toBe(true);
      const miss = await evaluateCheck(ctx, check('screen_contains', 'Menu:\n2) Quit'));
      expect(miss).toMatchObject({ pass: false, expected: 'Menu:\n2) Quit' });
      expect(await contains('Menu:\n2) Quit')).toBe(false);
      expect((await evaluateCheck(ctx, check('screen_contains', 'Menu:\n2) Quit', { not: true }))).pass).toBe(true);
      expect(await matches('Menu:\n1\\) \\w+\n2\\)')).toBe(true);
      expect(await matches('^Menu:\n1\\) Pridat\n2\\) Quit\n>$\n')).toBe(true); // block scalar, last line without its blank
      expect(await matches('^2\\) Quit\n1\\)')).toBe(false);
    });
  });

  it('screen_matches does not pass vacuously for ^$ or ^\\s*$', async () => {
    await screenOf('printf "a\\nb"', async (ctx) => {
      expect((await evaluateCheck(ctx, check('screen_matches', '^$'))).pass).toBe(false);
      expect((await evaluateCheck(ctx, check('screen_matches', '^\\s*$'))).pass).toBe(false);
    });
    await screenOf('printf "a\\n\\nb"', async (ctx) => {
      expect((await evaluateCheck(ctx, check('screen_matches', '^$'))).pass).toBe(true);
    });
  });

  it('fails when there is no session, or the id names a run', async () => {
    await withHarness('true', async ({ ctx }) => {
      const r = await evaluateCheck(ctx, check('screen_contains', 'x'));
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/no session/);
    });
  });

  it('screen_contains reads the session named by from', async () => {
    await withHarness('echo "$1"', async ({ ctx, run }) => {
      await run(step('session', { args: ['one'] }, 'a'));
      await run(step('session', { args: ['two'] }, 'b'));
      expect((await evaluateCheck(ctx, check('screen_contains', 'one', { from: 'a' }))).pass).toBe(true);
      expect((await evaluateCheck(ctx, check('screen_contains', 'one', { from: 'b' }))).pass).toBe(false);
      expect((await evaluateCheck(ctx, check('screen_contains', 'two'))).pass).toBe(true); // the last session
    });
  });
});
