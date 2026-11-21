import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/core/app.ts';
import type { CheckResult, CheckSpec, RunRecord, ScenarioContext, ValidateContext } from '../../src/core/contracts.ts';
import { type ScenarioEnv, createScenarioContext, evaluateCheck } from '../../src/core/execute.ts';
import { removeDir } from '../../src/core/workspace.ts';
import { checksBasic } from '../../src/plugins/checks-basic/index.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-1',
  args: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  durationMs: 1,
  ...over,
});

const spec = (name: string, params: unknown, over: Partial<CheckSpec> = {}): CheckSpec => ({
  name,
  params,
  weight: 1,
  hidden: false,
  not: false,
  pointer: `#/expect/${name}`,
  ...over,
});

async function makeApp(): Promise<App> {
  const app = new App();
  await app.register(checksBasic);
  return app;
}

interface Harness {
  ctx: ScenarioContext;
  assignmentDir: string;
  /** Evaluates `name: params` against the last run. */
  check(name: string, params: unknown, over?: Partial<CheckSpec>): Promise<CheckResult>;
}

async function withHarness(run: Partial<RunRecord> | undefined, fn: (h: Harness) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const assignmentDir = join(dir, 'assignment');
    await mkdir(assignmentDir, { recursive: true });
    const env: ScenarioEnv = {
      app: await makeApp(),
      submission: { id: 'stu' } as ScenarioEnv['submission'],
      binaryPath: '/bin/true',
      projectDir: dir,
      build: undefined,
      locale: 'en',
      t: (key, vars) => (vars === undefined ? key : `${key} ${JSON.stringify(vars)}`),
      assignmentDir,
      limits: { runTimeoutMs: 1000, outputLimitBytes: 1024 },
      log: () => {},
    };
    const ctx = await createScenarioContext(env, { id: 's', title: 's', weight: 1, steps: [], expect: [], file: 'f.yaml', pointer: '#/0', vars: {} });
    if (run !== undefined) {
      const rec = record(run);
      ctx.runs.set(rec.id, rec);
      ctx.lastRun = rec;
    }
    try {
      await fn({ ctx, assignmentDir, check: (name, params, over) => evaluateCheck(ctx, spec(name, params, over)) });
    } finally {
      await removeDir(ctx.workdir);
    }
  });
}

const validateCtx = (assignmentDir = '/nonexistent'): ValidateContext => ({
  assignmentDir,
  fixturesDir: `${assignmentDir}/fixtures`,
  fixtureExists: () => true,
  knownVars: [],
});

describe('registration', () => {
  it('is a builtin plugin, part of the preset, with the declared sources', async () => {
    expect(builtinPlugins['checks-basic']).toBe(checksBasic);
    expect(checksBasic.meta.name).toBe('checks-basic');
    const app = new App();
    await app.register(defaultPreset);
    const sources = Object.fromEntries(app.list('check').map((c) => [c.name, c.def.source]));
    expect(sources).toEqual({
      exit_code: 'either',
      stdout_contains: 'run',
      stdout_matches: 'run',
      stderr_contains: 'run',
      stderr_matches: 'run',
      file_exists: 'none',
      file_contains: 'none',
      file_empty: 'none',
      any_of: 'none',
      all_of: 'none',
      script: 'none',
      screen_contains: 'session', // from steps-session
      screen_matches: 'session',
      function_count: 'none', // from checks-source
      no_compiler_warnings: 'none',
      file_line_count: 'none',
    });
  });
});

describe('exit_code', () => {
  it('passes for the exact code and fails otherwise, reporting expected/actual', async () => {
    await withHarness({ exitCode: 0 }, async ({ check }) => {
      expect((await check('exit_code', 0)).pass).toBe(true);
      const failed = await check('exit_code', 1);
      expect(failed).toMatchObject({ pass: false, expected: '1', actual: '0' });
    });
  });

  it("'nonzero' passes for 2 and fails for 0", async () => {
    await withHarness({ exitCode: 2 }, async ({ check }) => {
      expect((await check('exit_code', 'nonzero')).pass).toBe(true);
    });
    await withHarness({ exitCode: 0 }, async ({ check }) => {
      expect((await check('exit_code', 'nonzero')).pass).toBe(false);
    });
  });

  it('does not accept death by signal as an exit code', async () => {
    await withHarness({ exitCode: null, signal: 'SIGSEGV' }, async ({ check }) => {
      const r = await check('exit_code', 'nonzero');
      expect(r.pass).toBe(false);
      expect(r.actual).toContain('SIGSEGV');
      expect((await check('exit_code', 0)).pass).toBe(false);
    });
  });

  it('reads an exited session record', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      ctx.sessions.set('s1', { id: 's1', screen: '', exitCode: 4, exited: true, timedOut: false, durationMs: 1 });
      ctx.lastSession = ctx.sessions.get('s1')!;
      expect((await check('exit_code', 4)).pass).toBe(true);
    });
  });

  it('fails for a session that has not exited', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      ctx.sessions.set('s1', { id: 's1', screen: '', exitCode: null, exited: false, timedOut: false, durationMs: 1 });
      ctx.lastSession = ctx.sessions.get('s1')!;
      const r = await check('exit_code', 'nonzero');
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/not exited/);
    });
  });

  it('rejects other parameter shapes', async () => {
    const def = (await makeApp()).lookup('check', 'exit_code')!;
    expect(def.params.safeParse('zero').success).toBe(false);
    expect(def.params.safeParse(1.5).success).toBe(false);
    expect(def.params.safeParse('nonzero').success).toBe(true);
  });

  it('describes itself with translate keys', async () => {
    const def = (await makeApp()).lookup('check', 'exit_code')!;
    const t = (key: string, vars?: Record<string, string | number>): string => `${key}|${JSON.stringify(vars ?? {})}`;
    expect(def.describe(0, t)).toBe('check.exit_code|{"code":0}');
    expect(def.describe('nonzero', t)).toBe('check.exit_code_nonzero|{}');
  });
});

describe('stdout_contains / stderr_contains', () => {
  it('matches plain text and reports the failure', async () => {
    await withHarness({ stdout: 'Hello world\n', stderr: 'oops\n' }, async ({ check }) => {
      expect((await check('stdout_contains', 'world')).pass).toBe(true);
      expect((await check('stderr_contains', 'oops')).pass).toBe(true);
      const miss = await check('stdout_contains', 'nope');
      expect(miss).toMatchObject({ pass: false, expected: 'nope' });
      expect(miss.actual).toContain('Hello world');
      expect((await check('stderr_contains', 'world')).pass).toBe(false);
    });
  });

  it('is case sensitive unless ignore_case is set', async () => {
    await withHarness({ stdout: 'HELP me' }, async ({ check }) => {
      expect((await check('stdout_contains', 'help')).pass).toBe(false);
      expect((await check('stdout_contains', { text: 'help', ignore_case: true })).pass).toBe(true);
    });
  });

  it('fold_diacritics matches Uspesnost against Úspešnosť (and the reverse)', async () => {
    await withHarness({ stdout: 'Úspešnosť: 100%\n' }, async ({ check }) => {
      expect((await check('stdout_contains', 'Uspesnost')).pass).toBe(false);
      expect((await check('stdout_contains', { text: 'Uspesnost', fold_diacritics: true })).pass).toBe(true);
      expect((await check('stdout_contains', { text: 'Úspešnosť', fold_diacritics: true })).pass).toBe(true);
    });
    await withHarness({ stdout: 'Uspesnost' }, async ({ check }) => {
      expect((await check('stdout_contains', { text: 'Úspešnosť', fold_diacritics: true })).pass).toBe(true);
    });
  });

  it('fold_diacritics works on decomposed input and combines with ignore_case', async () => {
    await withHarness({ stdout: 'USPÉSNOST' }, async ({ check }) => {
      expect((await check('stdout_contains', { text: 'uspesnost', fold_diacritics: true, ignore_case: true })).pass).toBe(true);
    });
  });

  it('ignores CRLF line endings and ANSI escapes', async () => {
    await withHarness({ stdout: '\u001b[1;32mHelp\u001b[0m\r\nline two\r\n' }, async ({ check }) => {
      expect((await check('stdout_contains', 'Help')).pass).toBe(true);
      expect((await check('stdout_contains', 'Help\nline two')).pass).toBe(true);
    });
  });

  it('interpolates runtime variables in the text', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      const rec = record({ stdout: `wrote ${ctx.workdir}/out.txt` });
      ctx.runs.set(rec.id, rec);
      ctx.lastRun = rec;
      expect((await check('stdout_contains', 'wrote ${workdir}/out.txt')).pass).toBe(true);
    });
  });

  it('describes itself and validates parameter shapes', async () => {
    const def = (await makeApp()).lookup('check', 'stdout_contains')!;
    const t = (key: string, vars?: Record<string, string | number>): string => `${key}|${JSON.stringify(vars ?? {})}`;
    expect(def.describe('Help', t)).toBe('check.stdout_contains|{"text":"Help"}');
    expect(def.describe({ text: 'Help', ignore_case: true }, t)).toBe('check.stdout_contains|{"text":"Help"}');
    expect(def.params.safeParse({ pattern: 'x' }).success).toBe(false);
    expect(def.params.safeParse({ text: 'x', bogus: true }).success).toBe(false);
    expect(def.params.safeParse(5).success).toBe(false);
  });
});

describe('stdout_matches / stderr_matches', () => {
  it('matches a regular expression against normalized output', async () => {
    await withHarness({ stdout: 'Score: 100.00%\r\n' }, async ({ check }) => {
      expect((await check('stdout_matches', '\\b100\\.00%')).pass).toBe(true);
      expect((await check('stdout_matches', '\\b99\\.00%')).pass).toBe(false);
      expect((await check('stdout_matches', '^Score: \\d+\\.\\d+%$')).pass).toBe(false); // no m flag
      expect((await check('stdout_matches', { pattern: '^Score: \\d+\\.\\d+%$', flags: 'm' })).pass).toBe(true);
    });
  });

  it('supports ignore_case and fold_diacritics', async () => {
    await withHarness({ stdout: 'Úspešnosť 100%' }, async ({ check }) => {
      expect((await check('stdout_matches', { pattern: 'uspesnost \\d+', ignore_case: true, fold_diacritics: true })).pass).toBe(true);
      expect((await check('stdout_matches', { pattern: 'uspesnost \\d+', ignore_case: true })).pass).toBe(false);
    });
  });

  it('reads stderr for stderr_matches', async () => {
    await withHarness({ stdout: 'a', stderr: 'error: code 42' }, async ({ check }) => {
      expect((await check('stderr_matches', 'code \\d+')).pass).toBe(true);
      expect((await check('stdout_matches', 'code \\d+')).pass).toBe(false);
    });
  });

  it('fails (without throwing) on an invalid pattern or flags', async () => {
    await withHarness({ stdout: 'x' }, async ({ check }) => {
      const bad = await check('stdout_matches', '(unclosed');
      expect(bad.pass).toBe(false);
      expect(bad.message).toMatch(/invalid regular expression/i);
      const flags = await check('stdout_matches', { pattern: 'x', flags: 'zz' });
      expect(flags.pass).toBe(false);
      expect(flags.message).toMatch(/invalid regular expression/i);
    });
  });

  it('is not reported as a plugin error for a bad pattern', async () => {
    await withHarness({ stdout: 'x' }, async ({ check }) => {
      const bad = await check('stdout_matches', '[');
      expect(bad.message).not.toMatch(/exploded|threw/);
    });
  });

  it('validate reports an invalid pattern statically', async () => {
    const def = (await makeApp()).lookup('check', 'stdout_matches')!;
    expect(def.validate!('ok\\d', validateCtx())).toEqual([]);
    const bad = def.validate!('(unclosed', validateCtx());
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ severity: 'error' });
    expect(def.validate!({ pattern: 'x', flags: 'qq' }, validateCtx())).toHaveLength(1);
  });
});

describe('file checks', () => {
  it('file_exists', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      await writeFile(join(ctx.workdir, 'out.txt'), 'x');
      expect((await check('file_exists', 'out.txt')).pass).toBe(true);
      expect((await check('file_exists', 'missing.txt')).pass).toBe(false);
      expect((await check('file_exists', '${workdir}/out.txt')).pass).toBe(true);
    });
  });

  it('file paths escaping the workdir fail the check instead of throwing', async () => {
    await withHarness(undefined, async ({ check }) => {
      const r = await check('file_exists', '../x');
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/escapes/);
    });
  });

  it('file_contains normalizes the file, supports ignore_case and fails for a missing file', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      await writeFile(join(ctx.workdir, 'r.txt'), 'Total: 5\r\nDone\r\n');
      expect((await check('file_contains', { path: 'r.txt', text: 'Total: 5\nDone' })).pass).toBe(true);
      expect((await check('file_contains', { path: 'r.txt', text: 'total' })).pass).toBe(false);
      expect((await check('file_contains', { path: 'r.txt', text: 'total', ignore_case: true })).pass).toBe(true);
      const missing = await check('file_contains', { path: 'nope.txt', text: 'x' });
      expect(missing.pass).toBe(false);
      expect(missing.message).toMatch(/not found/);
    });
  });

  it('file_empty treats missing as failure, whitespace-only as empty', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      await writeFile(join(ctx.workdir, 'empty.txt'), '');
      await writeFile(join(ctx.workdir, 'blank.txt'), ' \n\t\r\n');
      await writeFile(join(ctx.workdir, 'full.txt'), 'data');
      expect((await check('file_empty', 'empty.txt')).pass).toBe(true);
      expect((await check('file_empty', 'blank.txt')).pass).toBe(true);
      expect((await check('file_empty', 'full.txt')).pass).toBe(false);
      expect((await check('file_empty', 'nope.txt')).pass).toBe(false);
    });
  });

  it('file_contains and file_empty fail on a file larger than the output limit', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      ctx.limits.outputLimitBytes = 16;
      await writeFile(join(ctx.workdir, 'big.txt'), 'x'.repeat(17));
      await writeFile(join(ctx.workdir, 'small.txt'), 'x'.repeat(16));
      for (const r of [await check('file_contains', { path: 'big.txt', text: 'x' }), await check('file_empty', 'big.txt')]) {
        expect(r.pass).toBe(false);
        expect(r.message).toMatch(/too large.*17 bytes, limit 16/);
      }
      expect((await check('file_contains', { path: 'small.txt', text: 'x' })).pass).toBe(true);
    });
  });

  it('file_contains and file_empty fail on a directory', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      await mkdir(join(ctx.workdir, 'dir'));
      for (const r of [await check('file_contains', { path: 'dir', text: 'x' }), await check('file_empty', 'dir')]) {
        expect(r).toMatchObject({ pass: false, message: expect.stringMatching(/not a regular file/) });
      }
    });
  });

  itIf(hasTool('mkfifo'))(
    'file_contains and file_empty fail promptly on a FIFO instead of blocking',
    async () => {
      await withHarness(undefined, async ({ ctx, check }) => {
        execFileSync('mkfifo', [join(ctx.workdir, 'pipe')]);
        const results = await Promise.all([check('file_contains', { path: 'pipe', text: 'x' }), check('file_empty', 'pipe')]);
        for (const r of results) {
          expect(r).toMatchObject({ pass: false, message: expect.stringMatching(/not a regular file/) });
        }
      });
    },
    3000,
  );

  it('works without any run record (source none)', async () => {
    await withHarness(undefined, async ({ ctx, check }) => {
      await writeFile(join(ctx.workdir, 'a.txt'), 'x');
      expect((await check('file_exists', 'a.txt')).pass).toBe(true);
    });
  });
});

describe('any_of / all_of', () => {
  const help = { stdout_contains: 'Help' };
  const pomoc = { stdout_contains: 'Pomoc' };

  it('any_of passes when one child passes and fails when none do', async () => {
    await withHarness({ stdout: 'Pomoc: ...' }, async ({ check }) => {
      expect((await check('any_of', [help, pomoc])).pass).toBe(true);
      const none = await check('any_of', [help, { stdout_contains: 'Aide' }]);
      expect(none.pass).toBe(false);
      expect(none.message).toMatch(/none of the checks passed/);
    });
  });

  it('all_of fails when one child fails and passes when all pass', async () => {
    await withHarness({ stdout: 'Pomoc 100' }, async ({ check }) => {
      const failed = await check('all_of', [pomoc, help]);
      expect(failed.pass).toBe(false);
      expect(failed.message).toContain('Help');
      expect((await check('all_of', [pomoc, { stdout_contains: '100' }])).pass).toBe(true);
    });
  });

  it('not: true inverts any_of', async () => {
    await withHarness({ stdout: 'Pomoc' }, async ({ check }) => {
      expect((await check('any_of', [help, { stdout_contains: 'Aide' }], { not: true })).pass).toBe(true);
      expect((await check('any_of', [help, pomoc], { not: true })).pass).toBe(false);
    });
  });

  it('children honour their own modifiers (not) and nest', async () => {
    await withHarness({ stdout: 'Pomoc' }, async ({ check }) => {
      expect((await check('all_of', [pomoc, { stdout_contains: 'Help', not: true }])).pass).toBe(true);
      expect((await check('any_of', [{ all_of: [help, pomoc] }, { all_of: [pomoc] }])).pass).toBe(true);
    });
  });

  it('children inherit the parent from', async () => {
    await withHarness({ stdout: 'first' }, async ({ ctx, check }) => {
      const second = record({ id: 'other', stdout: 'second' });
      ctx.runs.set('other', second);
      ctx.lastRun = second;
      expect((await check('any_of', [{ stdout_contains: 'first' }], { from: 'run-1' })).pass).toBe(true);
      expect((await check('any_of', [{ stdout_contains: 'first' }])).pass).toBe(false);
    });
  });

  it('nested() returns CheckSpecs with an empty pointer, and rejects malformed children', async () => {
    const app = await makeApp();
    const def = app.lookup('check', 'any_of')!;
    const specs = def.nested!(def.params.parse([{ stdout_contains: 'a', weight: 2, hidden: true }, { exit_code: 0, not: true }]));
    expect(specs).toEqual([
      { name: 'stdout_contains', params: 'a', weight: 2, hidden: true, not: false, pointer: '' },
      { name: 'exit_code', params: 0, weight: 1, hidden: false, not: true, pointer: '' },
    ]);
    expect(() => def.nested!(def.params.parse([{ stdout_contains: 'a', exit_code: 0 }]))).toThrow(/exactly one check name key/);
    expect(def.params.safeParse([]).success).toBe(false);
    expect(def.params.safeParse('x').success).toBe(false);
  });

  it('describe lists the children', async () => {
    const def = (await makeApp()).lookup('check', 'any_of')!;
    const t = (key: string, vars?: Record<string, string | number>): string => `${key}|${JSON.stringify(vars ?? {})}`;
    expect(def.describe([help, pomoc], t)).toBe('check.any_of|{"checks":"stdout_contains: Help, stdout_contains: Pomoc"}');
    expect((await makeApp()).lookup('check', 'all_of')!.describe([help, { file_exists: 'a' }], t)).toBe(
      'check.all_of|{"checks":"stdout_contains: Help, file_exists: a"}',
    );
  });
});

describe('any_of / all_of with hidden children', () => {
  const secret = { stdout_contains: 'SECRET-TEXT', hidden: true };
  const visible = { stdout_contains: 'Visible-Text' };
  const t = (key: string, vars?: Record<string, string | number>): string => `${key}|${JSON.stringify(vars ?? {})}`;

  it('describe names a hidden child only by the generic label', async () => {
    const app = await makeApp();
    for (const name of ['any_of', 'all_of']) {
      const text = app.lookup('check', name)!.describe([visible, secret], t);
      expect(text).not.toContain('SECRET-TEXT');
      expect(text).toContain('stdout_contains: Visible-Text');
      expect(text).toContain('report.check.hidden');
    }
  });

  it('describe also hides a hidden child that is a path or pattern and nested composites', async () => {
    const def = (await makeApp()).lookup('check', 'all_of')!;
    const text = def.describe([{ file_exists: 'secret.txt', hidden: true }, { stdout_matches: 'S3CR3T', hidden: true }, { any_of: [secret] }], t);
    expect(text).not.toMatch(/secret\.txt|S3CR3T|SECRET-TEXT/);
  });

  it('all_of message lists a failed hidden child by the label only', async () => {
    await withHarness({ stdout: 'nothing here' }, async ({ check }) => {
      const result = await check('all_of', [visible, secret]);
      expect(result.pass).toBe(false);
      expect(result.message).not.toContain('SECRET-TEXT');
      expect(result.message?.split('does not contain')).toHaveLength(2); // only the visible child's detail
      expect(result.message).toContain('Visible-Text'); // the visible failed child is still detailed
      expect(result.message).toContain('report.check.hidden');
      expect(result.description).not.toContain('SECRET-TEXT');
    });
  });

  it('any_of message lists hidden children by the label only', async () => {
    await withHarness({ stdout: 'nothing here' }, async ({ check }) => {
      const result = await check('any_of', [visible, secret]);
      expect(result.pass).toBe(false);
      expect(result.message).not.toContain('SECRET-TEXT');
      expect(result.message?.split('does not contain')).toHaveLength(2); // only the visible child's detail
      expect(result.message).toContain('report.check.hidden');
    });
  });

  it('a hidden child still counts towards the verdict', async () => {
    await withHarness({ stdout: 'SECRET-TEXT' }, async ({ check }) => {
      expect((await check('any_of', [visible, secret])).pass).toBe(true);
      expect((await check('all_of', [visible, secret])).pass).toBe(false);
    });
  });
});

describe('script check', () => {
  it('returns the outcome of the default export', async () => {
    await withHarness({ stdout: 'abc' }, async ({ check, assignmentDir }) => {
      await writeFile(
        join(assignmentDir, 'c.mjs'),
        `export default (ctx, options) => ({ pass: ctx.lastRun.stdout.length === options.len, message: 'len mismatch', expected: String(options.len), actual: String(ctx.lastRun.stdout.length) });\n`,
      );
      expect((await check('script', { path: 'c.mjs', options: { len: 3 } })).pass).toBe(true);
      expect(await check('script', { path: 'c.mjs', options: { len: 4 } })).toMatchObject({
        pass: false,
        message: 'len mismatch',
        expected: '4',
        actual: '3',
      });
    });
  });

  it('supports async scripts and works without a run (source none)', async () => {
    await withHarness(undefined, async ({ check, assignmentDir }) => {
      await writeFile(join(assignmentDir, 'a.mjs'), `export default async () => ({ pass: true });\n`);
      expect((await check('script', { path: 'a.mjs' })).pass).toBe(true);
    });
  });

  it('a throwing script fails the check without crashing', async () => {
    await withHarness({ stdout: '' }, async ({ check, assignmentDir }) => {
      await writeFile(join(assignmentDir, 'boom.mjs'), `export default () => { throw new Error('script check boom'); };\n`);
      const r = await check('script', { path: 'boom.mjs' });
      expect(r).toMatchObject({ pass: false, message: 'script check boom' });
    });
  });

  it('fails for a script returning a malformed outcome, a missing file or an escaping path', async () => {
    await withHarness({ stdout: '' }, async ({ check, assignmentDir }) => {
      await writeFile(join(assignmentDir, 'bad.mjs'), `export default () => 'yes';\n`);
      expect((await check('script', { path: 'bad.mjs' })).message).toMatch(/CheckOutcome/);
      expect((await check('script', { path: 'absent.mjs' })).message).toMatch(/script not found/);
      expect((await check('script', { path: '../x.mjs' })).message).toMatch(/escapes/);
    });
  });

  it('validate requires the script file to exist', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'there.mjs'), 'export default () => ({ pass: true });\n');
      const def = (await makeApp()).lookup('check', 'script')!;
      expect(def.validate!({ path: 'there.mjs' }, validateCtx(dir))).toEqual([]);
      expect(def.validate!({ path: 'gone.mjs' }, validateCtx(dir))).toHaveLength(1);
    });
  });
});
