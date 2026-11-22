import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/core/app.ts';
import type { ScenarioContext, StepSpec, ValidateContext } from '../../src/core/contracts.ts';
import { type ScenarioEnv, createScenarioContext, executeStep } from '../../src/core/execute.ts';
import { removeDir } from '../../src/core/workspace.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { stepsBasic } from '../../src/plugins/steps-basic/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { withTempDir } from '../helpers/tmp.ts';

const step = (name: string, params: unknown, id?: string): StepSpec => ({
  name,
  params,
  ...(id === undefined ? {} : { id }),
  pointer: `#/steps/${name}`,
});

async function makeApp(): Promise<App> {
  const app = new App();
  await app.register(stepsBasic);
  return app;
}

interface Harness {
  ctx: ScenarioContext;
  assignmentDir: string;
  program: string;
  run(spec: StepSpec): ReturnType<typeof executeStep>;
}

/** Runs `fn` with a scenario context whose "student binary" is the shell script `body`. */
async function withHarness(body: string, fn: (h: Harness) => Promise<void>, env: Partial<ScenarioEnv> = {}): Promise<void> {
  await withTempDir(async (dir) => {
    const assignmentDir = join(dir, 'assignment');
    await mkdir(join(assignmentDir, 'fixtures', 'sub'), { recursive: true });
    await writeFile(join(assignmentDir, 'fixtures', 'input.txt'), 'fixture\n');
    await writeFile(join(assignmentDir, 'fixtures', 'sub', 'deep.txt'), 'deep\n');
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
      await fn({ ctx, assignmentDir, program, run: (spec) => executeStep(ctx, spec) });
    } finally {
      await removeDir(ctx.workdir);
    }
  });
}

const validateCtx = (fixtureExists: (rel: string) => boolean = () => true, assignmentDir = '/nonexistent'): ValidateContext => ({
  assignmentDir,
  fixturesDir: `${assignmentDir}/fixtures`,
  fixtureExists,
  knownVars: [],
});

describe('registration', () => {
  it('is a builtin plugin and part of the default preset', async () => {
    expect(builtinPlugins['steps-basic']).toBe(stepsBasic);
    expect(stepsBasic.meta.name).toBe('steps-basic');
    const app = new App();
    await app.register(defaultPreset);
    expect(app.list('step').map((s) => s.name).sort()).toEqual(['copy', 'run', 'script', 'session', 'write_file']);
  });

  it('marks only run as a producer of runs', async () => {
    const app = await makeApp();
    expect(app.lookup('step', 'run')?.produces).toBe('run');
    expect(app.lookup('step', 'copy')?.produces).toBeUndefined();
  });
});

describe('copy', () => {
  it('copies a fixture file into the workdir (string form keeps the relative path)', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      expect(await run(step('copy', 'input.txt'))).toMatchObject({ ok: true });
      expect(await readFile(join(ctx.workdir, 'input.txt'), 'utf8')).toBe('fixture\n');
    });
  });

  it('copies to another name with { from, to }, creating parent directories', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      expect((await run(step('copy', { from: 'input.txt', to: 'data/in.txt' }))).ok).toBe(true);
      expect(await readFile(join(ctx.workdir, 'data', 'in.txt'), 'utf8')).toBe('fixture\n');
    });
  });

  it('copies a directory recursively', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      expect((await run(step('copy', { from: 'sub', to: 'copied' }))).ok).toBe(true);
      expect(await readFile(join(ctx.workdir, 'copied', 'deep.txt'), 'utf8')).toBe('deep\n');
    });
  });

  it('skips symlinks inside a copied fixture directory', async () => {
    await withHarness('true', async ({ ctx, run, assignmentDir }) => {
      await symlink('/etc/hostname', join(assignmentDir, 'fixtures', 'sub', 'link'));
      expect((await run(step('copy', 'sub'))).ok).toBe(true);
      expect(existsSync(join(ctx.workdir, 'sub', 'deep.txt'))).toBe(true);
      expect(existsSync(join(ctx.workdir, 'sub', 'link'))).toBe(false);
    });
  });

  it('fails on a missing fixture and on paths escaping fixtures/ or the workdir', async () => {
    await withHarness('true', async ({ run }) => {
      expect((await run(step('copy', 'missing.txt'))).message).toMatch(/fixture not found: missing\.txt/);
      expect((await run(step('copy', '../assignment.yaml'))).ok).toBe(false);
      expect((await run(step('copy', { from: 'input.txt', to: '../out.txt' }))).ok).toBe(false);
    });
  });

  it('validate rejects a missing fixture and accepts an existing one', async () => {
    const def = (await makeApp()).lookup('step', 'copy')!;
    const exists = (rel: string): boolean => rel === 'input.txt';
    expect(def.validate!('input.txt', validateCtx(exists))).toEqual([]);
    expect(def.validate!({ from: 'input.txt', to: 'x' }, validateCtx(exists))).toEqual([]);
    const bad = def.validate!('nope.txt', validateCtx(exists));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ severity: 'error', message: expect.stringContaining('nope.txt') });
    expect(def.validate!({ from: 'nope.txt' }, validateCtx(exists))[0]!.path).toBe('/from');
  });

  it('validate rejects variables in copy paths, which would only fail at run time', async () => {
    const def = (await makeApp()).lookup('step', 'copy')!;
    const message = 'variables are not allowed in copy paths; paths are relative to fixtures/';
    const exists = (): boolean => true;
    expect(def.validate!('${fixtures}/x', validateCtx(exists))).toEqual([{ path: '', message, severity: 'error' }]);
    expect(def.validate!({ from: '${fixtures}/x' }, validateCtx(exists))).toEqual([{ path: '/from', message, severity: 'error' }]);
    expect(def.validate!({ from: 'x', to: '${workdir}/y' }, validateCtx(exists))).toEqual([{ path: '/to', message, severity: 'error' }]);
    expect(def.validate!({ from: 'x', to: 'y' }, validateCtx(exists))).toEqual([]);
  });
});

describe('write_file', () => {
  it('writes inside the workdir, creating directories', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      expect((await run(step('write_file', { path: 'a/b.txt', content: 'hello\n' }))).ok).toBe(true);
      expect(await readFile(join(ctx.workdir, 'a', 'b.txt'), 'utf8')).toBe('hello\n');
    });
  });

  it('interpolates runtime variables in content', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      await run(step('write_file', { path: 'w.txt', content: '${workdir}' }));
      expect(await readFile(join(ctx.workdir, 'w.txt'), 'utf8')).toBe(ctx.workdir);
    });
  });

  it('accepts an absolute path produced by ${workdir} that points into the workdir', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      expect((await run(step('write_file', { path: '${workdir}/abs.txt', content: 'abs' }))).ok).toBe(true);
      expect(await readFile(join(ctx.workdir, 'abs.txt'), 'utf8')).toBe('abs');
    });
  });

  it('rejects paths that escape the workdir', async () => {
    await withHarness('true', async ({ ctx, run }) => {
      const result = await run(step('write_file', { path: '../evil.txt', content: 'x' }));
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/escapes/);
      expect(existsSync(join(ctx.workdir, '..', 'evil.txt'))).toBe(false);
      expect((await run(step('write_file', { path: '/tmp/abs.txt', content: 'x' }))).ok).toBe(false);
    });
  });

  it('validate flags absolute and escaping paths', async () => {
    const def = (await makeApp()).lookup('step', 'write_file')!;
    expect(def.validate!({ path: 'ok/file.txt', content: '' }, validateCtx())).toEqual([]);
    expect(def.validate!({ path: '../x', content: '' }, validateCtx())).toHaveLength(1);
    expect(def.validate!({ path: '/x', content: '' }, validateCtx())).toHaveLength(1);
    expect(def.validate!({ path: '${workdir}/x', content: '' }, validateCtx())).toEqual([]);
  });
});

describe('run', () => {
  it('captures stdout, stderr and the exit code, and registers the record under the step id', async () => {
    await withHarness('echo out; echo err >&2; exit 3', async ({ ctx, run }) => {
      const result = await run(step('run', {}, 'main'));
      expect(result).toMatchObject({ ok: true, id: 'main' });
      expect(ctx.lastRun).toMatchObject({ id: 'main', stdout: 'out\n', stderr: 'err\n', exitCode: 3, timedOut: false });
      expect(ctx.runs.get('main')).toBe(ctx.lastRun);
    });
  });

  it('uses auto ids run-1, run-2 and interpolates args', async () => {
    await withHarness('echo "$@"', async ({ ctx, run }) => {
      await run(step('run', { args: ['${workdir}', 'b'] }));
      await run(step('run', { args: ['x'] }));
      expect(ctx.runs.get('run-1')?.args).toEqual([ctx.workdir, 'b']);
      expect(ctx.runs.get('run-1')?.stdout).toBe(`${ctx.workdir} b\n`);
      expect(ctx.runs.get('run-2')?.stdout).toBe('x\n');
    });
  });

  it('runs with the workdir as cwd and accepts a null/empty parameter block', async () => {
    await withHarness('pwd', async ({ ctx, run }) => {
      expect((await run(step('run', null))).ok).toBe(true);
      // macOS /var is a symlink to /private/var, and pwd prints the physical path.
      expect(ctx.lastRun?.stdout.trim()).toBe(await realpath(ctx.workdir));
    });
  });

  it('feeds a string stdin (both lines)', async () => {
    await withHarness('read a; read b; echo "[$a][$b]"', async ({ ctx, run }) => {
      await run(step('run', { stdin: 'y\nn\n' }));
      expect(ctx.lastRun?.stdout).toBe('[y][n]\n');
    });
  });

  it("stdin: 'closed' makes a read loop end", async () => {
    await withHarness('n=0; while read l; do n=$((n+1)); done; echo done $n', async ({ ctx, run }) => {
      await run(step('run', { stdin: 'closed', timeout: 5 }));
      expect(ctx.lastRun).toMatchObject({ stdout: 'done 0\n', timedOut: false, exitCode: 0 });
    });
  });

  it('merges env', async () => {
    await withHarness('echo "$GREETING"', async ({ ctx, run }) => {
      await run(step('run', { env: { GREETING: 'hi' } }));
      expect(ctx.lastRun?.stdout).toBe('hi\n');
    });
  });

  it('timeout (seconds) overrides the default limit and the step still succeeds', async () => {
    await withHarness('sleep 30', async ({ ctx, run }) => {
      const result = await run(step('run', { timeout: 0.3 }));
      expect(result.ok).toBe(true);
      expect(ctx.lastRun?.timedOut).toBe(true);
    });
  });

  it('fails with build_failed without spawning when there is no binary', async () => {
    await withHarness(
      'touch spawned',
      async ({ ctx, run }) => {
        const result = await run(step('run', {}));
        expect(result).toMatchObject({ ok: false, message: 'build_failed' });
        expect(ctx.runs.size).toBe(0);
        expect(existsSync(join(ctx.workdir, 'spawned'))).toBe(false);
      },
      { binaryPath: undefined },
    );
  });

  it('fails the step when the program cannot be started', async () => {
    await withHarness(
      'true',
      async ({ run }) => {
        const result = await run(step('run', {}));
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/cannot start/);
      },
      { binaryPath: '/nonexistent/binary' },
    );
  });

  it('rejects invalid parameters', async () => {
    await withHarness('true', async ({ run }) => {
      expect((await run(step('run', { args: 'x' }))).message).toMatch(/invalid parameters/);
      expect((await run(step('run', { bogus: 1 }))).ok).toBe(false);
    });
  });
});

describe('script', () => {
  it('imports the module relative to the assignment dir and calls its default export', async () => {
    await withHarness('true', async ({ ctx, run, assignmentDir }) => {
      await mkdir(join(assignmentDir, 'scripts'), { recursive: true });
      await writeFile(
        join(assignmentDir, 'scripts', 'prep.mjs'),
        `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export default async (ctx, options) => { await writeFile(join(ctx.workdir, 'made.txt'), options.text); };
`,
      );
      const result = await run(step('script', { path: 'scripts/prep.mjs', options: { text: 'from script' } }));
      expect(result).toMatchObject({ ok: true });
      expect(await readFile(join(ctx.workdir, 'made.txt'), 'utf8')).toBe('from script');
    });
  });

  it('turns a throwing script into a step failure', async () => {
    await withHarness('true', async ({ run, assignmentDir }) => {
      await writeFile(join(assignmentDir, 'boom.mjs'), `export default async () => { throw new Error('script boom'); };\n`);
      const result = await run(step('script', { path: 'boom.mjs' }));
      expect(result).toMatchObject({ ok: false, message: 'script boom' });
    });
  });

  it('fails clearly for a missing file, a missing default export and an escaping path', async () => {
    await withHarness('true', async ({ run, assignmentDir }) => {
      await writeFile(join(assignmentDir, 'nodefault.mjs'), 'export const x = 1;\n');
      expect((await run(step('script', { path: 'absent.mjs' }))).message).toMatch(/script not found/);
      expect((await run(step('script', { path: 'nodefault.mjs' }))).message).toMatch(/default export/);
      expect((await run(step('script', { path: '../outside.mjs' }))).message).toMatch(/escapes/);
    });
  });

  it('validate requires the script file to exist', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'there.mjs'), 'export default () => {};\n');
      const def = (await makeApp()).lookup('step', 'script')!;
      expect(def.validate!({ path: 'there.mjs' }, validateCtx(() => true, dir))).toEqual([]);
      const bad = def.validate!({ path: 'gone.mjs' }, validateCtx(() => true, dir));
      expect(bad).toHaveLength(1);
      expect(bad[0]!.path).toBe('/path');
      expect(def.validate!({ path: '../x.mjs' }, validateCtx(() => true, dir))).toHaveLength(1);
    });
  });
});
