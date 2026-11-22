import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { App } from '../../src/core/app.ts';
import { runBuild } from '../../src/core/build.ts';
import type { AssignmentConfig, Submission } from '../../src/core/contracts.ts';
import { builderCmake } from '../../src/plugins/builder-cmake/index.ts';
import { builderCustom } from '../../src/plugins/builder-custom/index.ts';
import { builderGcc } from '../../src/plugins/builder-gcc/index.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

function makeConfig(build: AssignmentConfig['build'], over: Partial<AssignmentConfig> = {}): AssignmentConfig {
  return {
    name: 'test',
    max_points: 10,
    locale: 'en',
    build,
    project_root_marker: 'main.c',
    project_root_depth: 2,
    scoring: { use: 'proportional', rounding: 'none', cap: true },
    plugins: [],
    preset: 'none',
    limits: {
      build_timeout_sec: 60,
      run_timeout_sec: 10,
      output_limit_bytes: 10 * 1024 * 1024,
      unzip_max_bytes: 1024 * 1024,
      unzip_max_files: 100,
    },
    ...over,
  };
}

function makeSubmission(root: string | null): Submission {
  return {
    id: 's1',
    displayName: 's1',
    parts: {},
    sourcePath: root ?? '',
    kind: 'dir',
    workDir: root ?? '',
    root,
    warnings: [],
  };
}

async function makeApp(): Promise<App> {
  const app = new App();
  await app.register(builderGcc);
  await app.register(builderCmake);
  await app.register(builderCustom);
  return app;
}

const noLog = (): void => {};
const GOOD_C = 'int main(void) { return 0; }\n';

async function build(
  dir: string,
  files: Record<string, string>,
  cfg: AssignmentConfig,
  opts: { assignmentDir?: string; buildTimeoutMs?: number; app?: App } = {},
) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return runBuild(opts.app ?? (await makeApp()), cfg, makeSubmission(dir), noLog, {
    assignmentDir: opts.assignmentDir ?? dir,
    ...(opts.buildTimeoutMs !== undefined && { limits: { buildTimeoutMs: opts.buildTimeoutMs } }),
  });
}

const gccCfg = (over: Record<string, unknown> = {}): AssignmentConfig =>
  makeConfig({ type: 'gcc', sources: ['main.c'], output: 'out/app', ...over });

/** The first compiler invocation can exceed Jest's default 5 s on macOS CI (the grader's build timeout is 60 s). */
const SLOW_BUILD_MS = 60_000;

describe('runBuild with gcc', () => {
  const gcc = itIf(hasTool('gcc'));

  gcc('builds a valid C program into an executable binary', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, { 'main.c': GOOD_C }, gccCfg());
      expect(r.ok).toBe(true);
      expect(r.binaryPath).toBe(join(dir, 'out/app'));
      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);
      expect((await stat(join(dir, 'out/app'))).mode & 0o100).toBeTruthy();
    }),
    SLOW_BUILD_MS,
  );

  gcc('reports a syntax error as a failed build with the compiler output in the log', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, { 'main.c': 'int main(void) { return 0 }\n' }, gccCfg());
      expect(r.ok).toBe(false);
      expect(r.log).toContain('error');
      expect(r.message).toBe('build_failed');
      expect(r.binaryPath).toBeUndefined();
    }),
    SLOW_BUILD_MS,
  );

  gcc('counts warnings and still succeeds', () =>
    withTempDir(async (dir) => {
      const src = 'int main(void) { int unused; return 0; }\n';
      const r = await build(dir, { 'main.c': src }, gccCfg());
      expect(r.ok).toBe(true);
      expect(r.warnings).toBeGreaterThanOrEqual(1);
    }),
    SLOW_BUILD_MS,
  );

  gcc('reports a missing source file with a readable message', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, gccCfg({ sources: ['nope.c'] }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain('nope.c');
    }),
    SLOW_BUILD_MS,
  );

  gcc('refuses sources that escape the project directory', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, { 'main.c': GOOD_C }, gccCfg({ sources: ['../outside.c'] }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain('escapes');
    }),
    SLOW_BUILD_MS,
  );
});

describe('runBuild with cmake', () => {
  itIf(hasTool('cmake') && hasTool('gcc'))('configures, builds and verifies build/app', () =>
    withTempDir(async (dir) => {
      const cmake = 'cmake_minimum_required(VERSION 3.10)\nproject(app C)\nadd_executable(app main.c)\n';
      const r = await build(
        dir,
        { 'main.c': GOOD_C, 'CMakeLists.txt': cmake },
        makeConfig({ type: 'cmake', binary_path: 'build/app' }),
      );
      expect(r.log).toContain('Built target app');
      expect(r.ok).toBe(true);
      expect(r.binaryPath).toBe(join(dir, 'build/app'));
    }),
    SLOW_BUILD_MS,
  );
});

describe('runBuild with the custom builder (no compiler needed)', () => {
  const custom = (command: string, over: Partial<AssignmentConfig> = {}): AssignmentConfig =>
    makeConfig({ type: 'custom', command }, over);

  it('fails with the compiler output in the log when the command fails', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, custom('echo "main.c:1: error: boom" >&2; exit 2'));
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(2);
      expect(r.log).toContain('error: boom');
      expect(r.message).toBe('build_failed');
    }),
  );

  it('counts "warning:" lines', () =>
    withTempDir(async (dir) => {
      const cmd = 'printf "a.c:1: warning: x\\na.c:2: warning: y\\nok\\n" >&2; printf "#!/bin/sh\\n" > app; chmod +x app';
      const r = await build(dir, {}, custom(cmd, { binary: 'app' }));
      expect(r.ok).toBe(true);
      expect(r.warnings).toBe(2);
      expect(r.binaryPath).toBe(join(dir, 'app'));
    }),
  );

  it('reports binary_missing when the build succeeds without producing a binary', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, custom('true'));
      expect(r.ok).toBe(false);
      expect(r.message).toBe('binary_missing');
      expect(r.exitCode).toBe(0);
    }),
  );

  it('reports binary_missing when the configured binary does not exist', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, custom('true', { binary: 'bin/app' }));
      expect(r.ok).toBe(false);
      expect(r.message).toBe('binary_missing');
    }),
  );

  it('reports binary_not_executable when the binary lacks the executable bit', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, custom('echo hi > app', { binary: 'app' }));
      expect(r.ok).toBe(false);
      expect(r.message).toBe('binary_not_executable');
    }),
  );

  it('refuses a configured binary path that escapes the project', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, custom('true', { binary: '../elsewhere' }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain('escapes');
    }),
  );

  it('times out a build that runs too long', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, custom('sleep 30'), { buildTimeoutMs: 300 });
      expect(r.ok).toBe(false);
      expect(r.timedOut).toBe(true);
      expect(r.message).toBe('build_timeout');
    }),
  );

  it('truncates a 5 MB log to 64 KiB keeping the tail and adds a marker', () =>
    withTempDir(async (dir) => {
      const cmd = 'head -c 5000000 /dev/zero | tr "\\0" "x" >&2; echo; echo THE-END >&2; exit 1';
      const r = await build(dir, {}, custom(cmd));
      expect(r.ok).toBe(false);
      expect(r.log).toContain('THE-END');
      expect(r.log.length).toBeLessThanOrEqual(64 * 1024 + 200);
      expect(r.log).toMatch(/truncated/);
      expect(r.log.split('\n')[0]).toMatch(/truncated/);
    }),
  );

  it('stops a build that exceeds the output limit', () =>
    withTempDir(async (dir) => {
      const cfg = custom('yes x', { limits: { ...makeConfig({ type: 'custom' }).limits, output_limit_bytes: 4096 } });
      const r = await build(dir, {}, cfg);
      expect(r.ok).toBe(false);
      expect(r.message).toBe('build_output_limit');
    }),
  );

  it('returns project_root_not_found when the submission has no root', async () => {
    const r = await runBuild(await makeApp(), custom('true'), makeSubmission(null), noLog, { assignmentDir: '/' });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('project_root_not_found');
  });

  it('reports an unknown builder', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, makeConfig({ type: 'nope' }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain("unknown builder 'nope'");
    }),
  );

  it('reports invalid builder params', () =>
    withTempDir(async (dir) => {
      const r = await build(dir, {}, makeConfig({ type: 'custom' }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain('command');
    }),
  );

  it('does not reject when a builder throws', () =>
    withTempDir(async (dir) => {
      const app = new App();
      app.builder('boom', {
        description: 'throws',
        params: z.object({}),
        build: async () => {
          throw new Error('kaboom');
        },
      });
      const r = await build(dir, {}, makeConfig({ type: 'boom' }), { app });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('kaboom');
    }),
  );
});

describe('runBuild template overlay', () => {
  it('overwrites student-modified files before building', () =>
    withTempDir(async (dir) => {
      const assignmentDir = join(dir, 'assignment');
      const project = join(dir, 'project');
      await mkdir(join(assignmentDir, 'template', 'sub'), { recursive: true });
      await writeFile(join(assignmentDir, 'template', 'CMakeLists.txt'), 'ORIGINAL\n');
      await writeFile(join(assignmentDir, 'template', 'sub', 'deep.txt'), 'DEEP\n');
      const cfg = makeConfig({ type: 'custom', command: 'cp CMakeLists.txt app && chmod +x app' }, { binary: 'app', template: 'template' });
      const r = await build(project, { 'CMakeLists.txt': 'STUDENT HACK\n', 'keep.txt': 'kept\n' }, cfg, { assignmentDir });
      expect(r.ok).toBe(true);
      expect(await readFile(join(project, 'app'), 'utf8')).toBe('ORIGINAL\n');
      expect(await readFile(join(project, 'sub', 'deep.txt'), 'utf8')).toBe('DEEP\n');
      expect(await readFile(join(project, 'keep.txt'), 'utf8')).toBe('kept\n');
    }),
  );

  it('does not follow a symlink the student placed where a template file goes', () =>
    withTempDir(async (dir) => {
      const assignmentDir = join(dir, 'assignment');
      const project = join(dir, 'project');
      const victim = join(dir, 'victim.txt');
      await mkdir(join(assignmentDir, 'template'), { recursive: true });
      await writeFile(join(assignmentDir, 'template', 'CMakeLists.txt'), 'ORIGINAL\n');
      await writeFile(victim, 'untouched\n');
      await mkdir(project, { recursive: true });
      await symlink(victim, join(project, 'CMakeLists.txt'));
      const cfg = makeConfig({ type: 'custom', command: 'true' }, { binary: 'app', template: 'template' });
      await build(project, {}, cfg, { assignmentDir });
      expect(await readFile(victim, 'utf8')).toBe('untouched\n');
      expect(await readFile(join(project, 'CMakeLists.txt'), 'utf8')).toBe('ORIGINAL\n');
    }),
  );

  it('skips symlinks inside the template', () =>
    withTempDir(async (dir) => {
      const assignmentDir = join(dir, 'assignment');
      const project = join(dir, 'project');
      await mkdir(join(assignmentDir, 'template'), { recursive: true });
      await writeFile(join(assignmentDir, 'real.txt'), 'real\n');
      await symlink(join(assignmentDir, 'real.txt'), join(assignmentDir, 'template', 'link.txt'));
      await writeFile(join(assignmentDir, 'template', 'plain.txt'), 'plain\n');
      const cfg = makeConfig({ type: 'custom', command: 'true' }, { binary: 'app', template: 'template' });
      await build(project, {}, cfg, { assignmentDir });
      expect(await readFile(join(project, 'plain.txt'), 'utf8')).toBe('plain\n');
      await expect(stat(join(project, 'link.txt'))).rejects.toThrow();
    }),
  );

  it('fails cleanly when the template directory is missing', () =>
    withTempDir(async (dir) => {
      const cfg = makeConfig({ type: 'custom', command: 'true' }, { binary: 'app', template: 'missing' });
      const r = await build(dir, {}, cfg);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('template');
    }),
  );
});
