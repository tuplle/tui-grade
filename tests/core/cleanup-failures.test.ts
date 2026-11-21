// Cleanup problems (a directory that cannot be removed) must never replace a result or hide the original error.
// The failure is injected by mocking the removal functions, so the test does not depend on file system permissions.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ScenarioIR, Submission } from '../../src/core/contracts.ts';
import { withTempDir } from '../helpers/tmp.ts';

// `unstable_mockModule` is missing from @types/jest.
const jestApi = (import.meta as unknown as { jest: { unstable_mockModule(name: string, factory: () => unknown): void } }).jest;

const realFs = process.getBuiltinModule('node:fs/promises');
const leaked: string[] = [];
let failing = '';

// Only the modules imported below see the mock; `rm` of a directory whose name contains `failing` throws.
jestApi.unstable_mockModule('node:fs/promises', () => ({
  ...realFs,
  rm: async (path: string, options?: Parameters<typeof realFs.rm>[1]): Promise<void> => {
    if (failing !== '' && path.includes(failing)) {
      leaked.push(path);
      throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
    }
    await realFs.rm(path, options);
  },
}));

const { App } = await import('../../src/core/app.ts');
const { runScenario } = await import('../../src/core/execute.ts');
const { gradeAll } = await import('../../src/core/lifecycle.ts');
const { fp } = await import('../../src/core/plugin.ts');

afterEach(async () => {
  failing = '';
  await Promise.all(leaked.splice(0).map((dir) => realFs.rm(dir, { recursive: true, force: true })));
});

describe('a failing cleanup', () => {
  it('never replaces the computed result of a scenario: it is logged', async () => {
    failing = 'tui-grade-scn-';
    const app = new App();
    app.step('noop', { description: 'noop', params: z.unknown(), async run() {} });
    app.check('always', { description: 'always', params: z.unknown(), source: 'none', describe: () => 'always', async run() { return { pass: true }; } });
    const lines: string[] = [];
    const env = {
      app,
      submission: { id: 'stu' } as Submission,
      binaryPath: undefined,
      projectDir: undefined,
      build: undefined,
      locale: 'en',
      t: (key: string) => key,
      assignmentDir: '/assignment',
      limits: { runTimeoutMs: 1000, outputLimitBytes: 1024 },
      log: (m: string) => lines.push(m),
    };
    const scenario: ScenarioIR = {
      id: 's1',
      title: 'S',
      weight: 1,
      steps: [{ name: 'noop', params: {}, pointer: '#/steps/0' }],
      expect: [{ name: 'always', params: {}, weight: 1, hidden: false, not: false, pointer: '#/expect/0' }],
      file: 'f.yaml',
      pointer: '#/0',
      vars: {},
    };
    const result = await runScenario(env, scenario);
    expect(result).toMatchObject({ status: 'passed', checks: [expect.objectContaining({ name: 'always', pass: true })] });
    expect(lines).toEqual([expect.stringMatching(/^cannot remove scenario workdir \S+tui-grade-scn-\S+: EBUSY: simulated$/)]);
  });

  it('is logged when the run aborts, and the original error is thrown', async () => {
    await withTempDir(async (root) => {
      const assignment = join(root, 'assignment');
      await mkdir(join(assignment, 'scenarios'), { recursive: true });
      await writeFile(
        join(assignment, 'assignment.yaml'),
        'name: Fake\nmax_points: 1\nbuild: { type: custom, command: "true" }\nbinary: bin/prog\nproject_root_marker: src/prog.sh\n',
      );
      await writeFile(join(assignment, 'scenarios', 's.yaml'), '- id: one\n  title: One\n  steps:\n    - write_file: { path: a.txt, content: hi }\n  expect:\n    - file_exists: a.txt\n');
      const input = join(root, 'input');
      await mkdir(join(input, 'alice', 'src'), { recursive: true });
      await writeFile(join(input, 'alice', 'src', 'prog.sh'), '#!/bin/sh\n');
      const bad = fp(
        (a) => {
          a.hook('onRunStart', () => {
            throw new Error('no start');
          });
        },
        { name: 'bad-start' },
      );
      const lines: string[] = [];
      failing = 'tui-grade-sub-';
      await expect(
        gradeAll({ assignmentDir: assignment, inputPath: input, outDir: join(root, 'out'), extraPlugins: [bad], log: (m) => lines.push(m) }),
      ).rejects.toThrow('no start');
      const stuck = leaked[0] as string;
      expect(stuck).toMatch(/tui-grade-sub-/);
      expect(existsSync(stuck)).toBe(true);
      expect(lines).toContainEqual(`cannot remove workdir ${stuck}: EBUSY: simulated`);
    });
  });
});
