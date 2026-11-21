import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { App } from '../../src/core/app.ts';
import type {
  CheckSpec,
  RunRecord,
  ScenarioContext,
  ScenarioIR,
  SessionRecord,
  StepSpec,
  Submission,
} from '../../src/core/contracts.ts';
import {
  type ScenarioEnv,
  createScenarioContext as createContext,
  evaluateCheck,
  executeStep,
  runScenario,
} from '../../src/core/execute.ts';

const itNotRoot = process.getuid?.() === 0 ? it.skip : it;

// Contexts made directly (not through runScenario) own a temp workdir; remove them after each test.
const createdWorkdirs: string[] = [];
const createScenarioContext: typeof createContext = async (env, scenario) => {
  const ctx = await createContext(env, scenario);
  createdWorkdirs.push(ctx.workdir);
  return ctx;
};
afterEach(async () => {
  await Promise.all(createdWorkdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const runRecord = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  args: [],
  stdout: `out-${id}`,
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  durationMs: 1,
  ...over,
});

const sessionRecord = (id: string): SessionRecord => ({
  id,
  screen: `screen-${id}`,
  exitCode: null,
  exited: false,
  timedOut: false,
  durationMs: 1,
});

const step = (name: string, params: unknown = {}, id?: string): StepSpec => ({
  name,
  params,
  ...(id === undefined ? {} : { id }),
  pointer: `#/steps/${name}`,
});

const check = (name: string, params: unknown = {}, over: Partial<CheckSpec> = {}): CheckSpec => ({
  name,
  params,
  weight: 1,
  hidden: false,
  not: false,
  pointer: `#/expect/${name}`,
  ...over,
});

const scenario = (steps: StepSpec[], expect: CheckSpec[]): ScenarioIR => ({
  id: 's1',
  title: 'Scenario',
  weight: 1,
  steps,
  expect,
  file: 'scenarios.yaml',
  pointer: '#/0',
  vars: {},
});

/** Stub plugin: `put` stores a run, `put-session` a session, `fail` / `throw-step` break, checks read the run. */
function stubApp(): App {
  const app = new App();
  app.step('put', {
    description: 'stores a run',
    params: z.object({ stdout: z.string().default('hello'), timedOut: z.boolean().default(false) }),
    produces: 'run',
    async run(ctx: ScenarioContext, params: { stdout: string; timedOut: boolean }) {
      const record = runRecord(ctx.currentStepId ?? '?', { stdout: params.stdout, timedOut: params.timedOut });
      ctx.runs.set(record.id, record);
      ctx.lastRun = record;
    },
  });
  app.step('put-session', {
    description: 'stores a session',
    params: z.unknown(),
    produces: 'session',
    async run(ctx: ScenarioContext) {
      const record = sessionRecord(ctx.currentStepId ?? '?');
      ctx.sessions.set(record.id, record);
      ctx.lastSession = record;
    },
  });
  app.step('throw-step', {
    description: 'throws',
    params: z.unknown(),
    async run() {
      throw new Error('step exploded');
    },
  });
  app.step('noop', { description: 'noop', params: z.unknown(), async run() {} });
  app.step('lock-dir', {
    description: 'leaves a read-only directory with a file behind, like `mkdir d; touch d/x; chmod 500 d`',
    params: z.unknown(),
    async run(ctx: ScenarioContext) {
      const dir = join(ctx.workdir, 'd', 'inner');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'x'), 'x');
      await chmod(dir, 0o500);
      await chmod(join(ctx.workdir, 'd'), 0o500);
    },
  });
  app.check('has', {
    description: 'stdout contains text',
    params: z.object({ text: z.string() }),
    source: 'run',
    describe: (params) => `stdout has ${params.text}`,
    async run(ctx, params) {
      const stdout = ctx.run?.stdout ?? '';
      return { pass: stdout.includes(params.text), message: 'text missing', expected: params.text, actual: stdout };
    },
  });
  app.check('session-has', {
    description: 'screen contains text',
    params: z.object({ text: z.string() }),
    source: 'session',
    describe: (params) => `screen has ${params.text}`,
    async run(ctx, params) {
      return { pass: (ctx.session?.screen ?? '').includes(params.text) };
    },
  });
  app.check('either-id', {
    description: 'reports the record id',
    params: z.object({ id: z.string() }),
    source: 'either',
    describe: () => 'either id',
    async run(ctx, params) {
      const id = ctx.run?.id ?? ctx.session?.id;
      return { pass: id === params.id, actual: String(id) };
    },
  });
  app.check('boom', {
    description: 'throws',
    params: z.unknown(),
    source: 'none',
    describe: () => 'boom check',
    async run() {
      throw new Error('check exploded');
    },
  });
  app.check('bad-describe', {
    description: 'describe throws',
    params: z.unknown(),
    source: 'none',
    describe: () => {
      throw new Error('no description');
    },
    async run() {
      return { pass: true };
    },
  });
  app.check('always', {
    description: 'always passes',
    params: z.unknown(),
    source: 'none',
    describe: () => 'always',
    async run() {
      return { pass: true };
    },
  });
  app.check('any_of', {
    description: 'any of nested checks',
    params: z.object({ checks: z.array(z.record(z.string(), z.unknown())) }),
    source: 'none',
    nested: (params: { checks: Array<Record<string, unknown>> }) =>
      params.checks.map((entry) => {
        const [name = '', params2] = Object.entries(entry)[0] ?? [];
        return check(name, params2);
      }),
    describe: () => 'any of',
    async run(ctx, params) {
      const results = [];
      for (const entry of params.checks) {
        const [name = '', nestedParams] = Object.entries(entry)[0] ?? [];
        results.push(await ctx.evaluate(check(name, nestedParams)));
      }
      const messages = results.flatMap((r) => (r.message === undefined ? [] : [r.message]));
      return { pass: results.some((r) => r.pass), ...(messages.length === 0 ? {} : { message: messages.join('; ') }) }; // children's messages, to observe them
    },
  });
  return app;
}

const submission = { id: 'stu' } as Submission;

function envFor(app: App, over: Partial<ScenarioEnv> = {}): ScenarioEnv {
  return {
    app,
    submission,
    binaryPath: '/bin/student',
    projectDir: '/proj',
    build: undefined,
    locale: 'en',
    t: (key) => key,
    assignmentDir: '/assignment',
    limits: { runTimeoutMs: 1000, outputLimitBytes: 1024 },
    log: () => {},
    ...over,
  };
}

describe('createScenarioContext', () => {
  it('creates a fresh empty workdir per scenario', async () => {
    const env = envFor(stubApp());
    const a = await createScenarioContext(env, scenario([], []));
    const b = await createScenarioContext(env, scenario([], []));
    expect(a.workdir).not.toBe(b.workdir);
    expect(existsSync(a.workdir)).toBe(true);
    expect(a.fixturesDir).toBe('/assignment/fixtures');
    expect(a.assignmentDir).toBe('/assignment');
    expect(a.binaryPath).toBe('/bin/student');
  });

  it('rejects a path that escapes the workdir', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    expect(() => ctx.resolvePath('../x')).toThrow();
    expect(ctx.resolvePath('sub/file.txt')).toBe(`${ctx.workdir}/sub/file.txt`);
  });

  it('interpolates ${binary} ${workdir} ${fixtures} deeply', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    expect(ctx.interpolate('${binary} ${workdir}')).toBe(`/bin/student ${ctx.workdir}`);
    expect(ctx.interpolate({ a: ['${fixtures}/in.txt', 3], b: { c: '${binary}' } })).toEqual({
      a: ['/assignment/fixtures/in.txt', 3],
      b: { c: '/bin/student' },
    });
    expect(ctx.interpolate('${other}')).toBe('${other}');
  });

  it('keeps names of Object.prototype literal in interpolation', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(ctx.interpolate(`\${${name}}`)).toBe(`\${${name}}`);
    }
  });
});

describe('executeStep', () => {
  it('registers a produced run under the step id and auto ids per kind', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    const named = await executeStep(ctx, step('put', {}, 'first'));
    const auto1 = await executeStep(ctx, step('put', {}));
    const auto2 = await executeStep(ctx, step('put', {}));
    const session = await executeStep(ctx, step('put-session'));
    expect(named).toMatchObject({ name: 'put', id: 'first', ok: true });
    expect([...ctx.runs.keys()]).toEqual(['first', 'run-1', 'run-2']);
    expect(auto1.id).toBe('run-1');
    expect(auto2.id).toBe('run-2');
    expect(session.id).toBe('session-1');
    expect([...ctx.sessions.keys()]).toEqual(['session-1']);
    expect(ctx.currentStepId).toBeUndefined();
  });

  it('never throws: unknown step, bad params and a throwing step become ok=false', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    const unknown = await executeStep(ctx, step('nope'));
    const badParams = await executeStep(ctx, step('put', { stdout: 5 }));
    const thrown = await executeStep(ctx, step('throw-step'));
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.message).toContain('nope');
    expect(badParams.ok).toBe(false);
    expect(badParams.message).toContain('stdout');
    expect(thrown).toMatchObject({ ok: false, message: 'step exploded' });
  });
});

describe('evaluateCheck', () => {
  it('inverts the result with not:true', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put', { stdout: 'hello' }));
    const plain = await evaluateCheck(ctx, check('has', { text: 'hello' }));
    const inverted = await evaluateCheck(ctx, check('has', { text: 'hello' }, { not: true }));
    const invertedMiss = await evaluateCheck(ctx, check('has', { text: 'zzz' }, { not: true }));
    expect(plain.pass).toBe(true);
    expect(inverted.pass).toBe(false);
    expect(inverted.message).toContain('expected NOT');
    expect(invertedMiss.pass).toBe(true);
  });

  it('resolves spec.from to the named record and defaults to the last one', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put', { stdout: 'alpha' }, 'first'));
    await executeStep(ctx, step('put', { stdout: 'beta' }, 'second'));
    expect((await evaluateCheck(ctx, check('has', { text: 'alpha' }, { from: 'first' }))).pass).toBe(true);
    expect((await evaluateCheck(ctx, check('has', { text: 'alpha' }))).pass).toBe(false);
    expect((await evaluateCheck(ctx, check('has', { text: 'beta' }))).pass).toBe(true);
    const missing = await evaluateCheck(ctx, check('has', { text: 'x' }, { from: 'ghost' }));
    expect(missing.pass).toBe(false);
    expect(missing.message).toContain('ghost');
  });

  it('fails without a record, even with not:true', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    const result = await evaluateCheck(ctx, check('has', { text: 'x' }, { not: true }));
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/no run/i);
  });

  it('fails a check on a timed-out run with a timeout message and does not throw', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put', { stdout: 'hello', timedOut: true }));
    const result = await evaluateCheck(ctx, check('has', { text: 'hello' }));
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/time/i);
  });

  it('resolves source "either" to whichever record was produced last', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put'));
    await executeStep(ctx, step('put-session'));
    expect((await evaluateCheck(ctx, check('either-id', { id: 'session-1' }))).pass).toBe(true);
    await executeStep(ctx, step('put'));
    expect((await evaluateCheck(ctx, check('either-id', { id: 'run-2' }))).pass).toBe(true);
    expect((await evaluateCheck(ctx, check('either-id', { id: 'session-1' }, { from: 'session-1' }))).pass).toBe(true);
  });

  it('turns a throwing check into pass=false with the error message', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    const result = await evaluateCheck(ctx, check('boom'));
    expect(result).toMatchObject({ pass: false, name: 'boom', description: 'boom check' });
    expect(result.message).toContain('check exploded');
  });

  it('hides the error detail of a throwing hidden check (and of its nested children) from the result and logs it', async () => {
    const logs: string[] = [];
    const ctx = await createScenarioContext(envFor(stubApp(), { log: (m) => logs.push(m) }), scenario([], []));
    const hidden = await evaluateCheck(ctx, check('boom', {}, { hidden: true }));
    expect(hidden.message).toBe('a hidden check raised an error');
    expect(logs.join('\n')).toContain('check exploded');

    const nestedCtx = await createScenarioContext(envFor(stubApp(), { log: (m) => logs.push(m) }), scenario([], []));
    const nestedResult = await evaluateCheck(nestedCtx, check('any_of', { checks: [{ boom: {} }] }, { hidden: true }));
    expect(nestedResult.message).toBe('a hidden check raised an error'); // the child's own result is generic too
    expect(logs.join('\n')).toContain("check 'boom': check exploded (hidden check)");
    const nested = await runScenario(
      envFor(stubApp(), { log: (m) => logs.push(m) }),
      scenario([], [check('any_of', { checks: [{ boom: {} }] }, { hidden: true })]),
    );
    expect(nested.error).toBe('a hidden check raised an error');
  });

  it('reports an unknown check and invalid params as failures', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put'));
    const unknown = await evaluateCheck(ctx, check('nope'));
    const invalid = await evaluateCheck(ctx, check('has', { text: 5 }));
    expect(unknown.pass).toBe(false);
    expect(unknown.message).toContain('nope');
    expect(invalid.pass).toBe(false);
    expect(invalid.message).toContain('text');
  });

  it('uses describe() as the description and falls back to the name when it throws', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put'));
    expect((await evaluateCheck(ctx, check('has', { text: 'hello' }))).description).toBe('stdout has hello');
    expect((await evaluateCheck(ctx, check('bad-describe'))).description).toBe('bad-describe');
  });

  it('carries expected/actual but not for hidden checks', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put', { stdout: 'hello' }));
    const visible = await evaluateCheck(ctx, check('has', { text: 'zzz' }));
    const hidden = await evaluateCheck(ctx, check('has', { text: 'zzz' }, { hidden: true }));
    expect(visible).toMatchObject({ expected: 'zzz', actual: 'hello', hidden: false });
    expect(hidden.hidden).toBe(true);
    expect(hidden).not.toHaveProperty('expected');
    expect(hidden).not.toHaveProperty('actual');
  });

  it('lets a composite check evaluate nested specs, inheriting from', async () => {
    const ctx = await createScenarioContext(envFor(stubApp()), scenario([], []));
    await executeStep(ctx, step('put', { stdout: 'alpha' }, 'first'));
    await executeStep(ctx, step('put', { stdout: 'beta' }, 'second'));
    const inherited = await evaluateCheck(
      ctx,
      check('any_of', { checks: [{ has: { text: 'alpha' } }] }, { from: 'first' }),
    );
    const notInherited = await evaluateCheck(ctx, check('any_of', { checks: [{ has: { text: 'alpha' } }] }));
    expect(inherited.pass).toBe(true);
    expect(notInherited.pass).toBe(false);
  });
});

describe('runScenario', () => {
  it('passes when all steps and checks succeed, and removes the workdir', async () => {
    let workdir = '';
    const app = stubApp();
    app.hook('onScenarioStart', ({ ctx }) => {
      workdir = ctx.workdir;
      expect(existsSync(workdir)).toBe(true);
    });
    const result = await runScenario(
      envFor(app),
      scenario([step('put', { stdout: 'hello' })], [check('has', { text: 'hello' }, { weight: 3 })]),
    );
    expect(result).toMatchObject({ id: 's1', status: 'passed', weight: 1, artifacts: [] });
    expect(result.steps).toHaveLength(1);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'has', pass: true, weight: 3 }),
    ]);
    expect(typeof result.durationMs).toBe('number');
    expect(workdir).not.toBe('');
    expect(existsSync(workdir)).toBe(false);
  });

  it('is "failed" when a check fails', async () => {
    const result = await runScenario(
      envFor(stubApp()),
      scenario([step('put')], [check('has', { text: 'nope' }), check('always')]),
    );
    expect(result.status).toBe('failed');
    expect(result.checks.map((c) => c.pass)).toEqual([false, true]);
  });

  it('is "error" for a throwing check while the other checks are still evaluated', async () => {
    const result = await runScenario(
      envFor(stubApp()),
      scenario([step('put')], [check('boom'), check('has', { text: 'hello' })]),
    );
    expect(result.status).toBe('error');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toMatchObject({ pass: false });
    expect(result.checks[0]?.message).toContain('check exploded');
    expect(result.checks[1]?.pass).toBe(true);
    expect(result.error).toContain('check exploded');
  });

  it('keeps the detailed error for a throwing visible check and hides it for a hidden one', async () => {
    const logs: string[] = [];
    const env = envFor(stubApp(), { log: (m) => logs.push(m) });
    const visible = await runScenario(env, scenario([], [check('boom')]));
    expect(visible.error).toBe("check 'boom': check exploded");
    expect(visible.checks[0]?.message).toBe('check exploded');
    expect(logs).toEqual([]);

    const hidden = await runScenario(env, scenario([], [check('boom', {}, { hidden: true })]));
    expect(hidden.status).toBe('error');
    expect(hidden.error).toBe('a hidden check raised an error');
    expect(hidden.error).not.toMatch(/boom|exploded/);
    expect(hidden.checks[0]).toMatchObject({ pass: false, hidden: true, message: 'a hidden check raised an error' });
    expect(logs.join('\n')).toContain("check 'boom': check exploded");
  });

  it('is "error" for a throwing step, skips later steps and still evaluates checks', async () => {
    const executed: string[] = [];
    const app = stubApp();
    app.hook('onStep', ({ step: s }) => {
      executed.push(s.name);
    });
    const result = await runScenario(
      envFor(app),
      scenario(
        [step('put'), step('throw-step'), step('put', { stdout: 'later' })],
        [check('has', { text: 'hello' }), check('has', { text: 'later' })],
      ),
    );
    expect(result.status).toBe('error');
    expect(result.steps.map((s) => [s.name, s.ok])).toEqual([
      ['put', true],
      ['throw-step', false],
    ]);
    expect(executed).toEqual(['put', 'throw-step']);
    expect(result.checks.map((c) => c.pass)).toEqual([true, false]);
    expect(result.error).toContain('step exploded');
  });

  it('fires hooks in order with payloads', async () => {
    const events: string[] = [];
    const app = stubApp();
    app.hook('onScenarioStart', ({ scenario: s, submission: sub, ctx }) => {
      events.push(`start:${s.id}:${sub.id}:${typeof ctx.workdir}`);
    });
    app.hook('onStep', ({ step: s, record }) => {
      events.push(`step:${s.name}:${record.ok}`);
    });
    app.hook('onCheck', ({ check: c, result }) => {
      events.push(`check:${c.name}:${result.pass}`);
    });
    app.hook('onScenarioEnd', ({ scenario: s, result }) => {
      events.push(`end:${s.id}:${result.status}`);
    });
    await runScenario(
      envFor(app),
      scenario([step('put'), step('noop')], [check('has', { text: 'hello' }), check('has', { text: 'x' })]),
    );
    expect(events).toEqual([
      'start:s1:stu:string',
      'step:put:true',
      'step:noop:true',
      'check:has:true',
      'check:has:false',
      'end:s1:failed',
    ]);
  });

  it('does not abort the scenario when a hook throws', async () => {
    const app = stubApp();
    app.hook('onStep', () => {
      throw new Error('hook broke');
    });
    const logs: string[] = [];
    const result = await runScenario(
      envFor(app, { log: (m) => logs.push(m) }),
      scenario([step('put')], [check('has', { text: 'hello' })]),
    );
    expect(result.status).toBe('passed');
    expect(logs.join('\n')).toContain('hook broke');
  });

  it('collects the final screens of produced sessions', async () => {
    const result = await runScenario(
      envFor(stubApp()),
      scenario([step('put-session', {}, 'main'), step('put')], [check('always')]),
    );
    expect(result.screens).toEqual({ main: 'screen-main' });
  });

  it('collects the program output of every run as logs', async () => {
    const result = await runScenario(
      envFor(stubApp()),
      scenario([step('put', { stdout: 'first' }, 'a'), step('put', { stdout: 'second', timedOut: true }, 'b')], [check('always')]),
    );
    expect(result.logs).toEqual({
      a: { stdout: 'first', stderr: '', exitCode: 0, timedOut: false },
      b: { stdout: 'second', stderr: '', exitCode: 0, timedOut: true },
    });
  });

  itNotRoot('keeps the computed result and removes the workdir when the program left a read-only directory behind', async () => {
    let workdir = '';
    const lines: string[] = [];
    const app = stubApp();
    app.hook('onScenarioStart', ({ ctx }) => {
      workdir = ctx.workdir;
    });
    const result = await runScenario(
      envFor(app, { log: (m) => lines.push(m) }),
      scenario([step('put', { stdout: 'hello' }), step('lock-dir')], [check('has', { text: 'hello' })]),
    );
    expect(result.status).toBe('passed');
    expect(result.checks).toEqual([expect.objectContaining({ name: 'has', pass: true })]);
    expect(workdir).not.toBe('');
    expect(existsSync(workdir)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('removes the workdir even when a hook fails', async () => {
    let workdir = '';
    const app = stubApp();
    app.hook('onScenarioStart', ({ ctx }) => {
      workdir = ctx.workdir;
    });
    app.hook('onScenarioEnd', () => {
      throw new Error('end hook');
    });
    await runScenario(envFor(app), scenario([], [check('always')]));
    expect(existsSync(workdir)).toBe(false);
  });
});
