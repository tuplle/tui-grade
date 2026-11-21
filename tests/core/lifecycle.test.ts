import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { SubmissionResult } from '../../src/core/contracts.ts';
import { ConfigError, gradeAll } from '../../src/core/lifecycle.ts';
import { fp } from '../../src/core/plugin.ts';
import { __setShuttingDown } from '../../src/core/shutdown.ts';
import { withTempDir } from '../helpers/tmp.ts';

const ASSIGNMENT = `name: Fake
max_points: 10
build:
  type: custom
  command: mkdir -p bin && cp src/prog.sh bin/prog && chmod +x bin/prog
binary: bin/prog
project_root_marker: src/prog.sh
limits: { run_timeout_sec: 0.3, build_timeout_sec: 20 }
groups:
  - { id: structure, title: Structure, points: 2 }
  - { id: behaviour, title: Behaviour, points: 6, requires_build: true }
  - { id: review, title: Review, points: 2, manual: true }
`;

const SCENARIOS = `- id: "1-1"
  title: T1-1
  group: structure
  steps:
    - write_file: { path: a.txt, content: hi }
  expect:
    - file_exists: a.txt
- id: "2-1"
  title: T2-1
  group: behaviour
  steps:
    - run: { args: [] }
  expect:
    - stdout_contains: ok
    - exit_code: 0
- id: "2-2"
  title: T2-2
  group: behaviour
  steps:
    - run: { args: [] }
  expect:
    - stdout_contains: ok
`;

interface Env {
  root: string;
  assignment: string;
  input: string;
  out: string;
}

async function setup(root: string, over: { assignment?: string; scenarios?: string } = {}): Promise<Env> {
  const assignment = join(root, 'assignment');
  await mkdir(join(assignment, 'scenarios'), { recursive: true });
  await writeFile(join(assignment, 'assignment.yaml'), over.assignment ?? ASSIGNMENT);
  await writeFile(join(assignment, 'scenarios', 's.yaml'), over.scenarios ?? SCENARIOS);
  const input = join(root, 'input');
  await mkdir(input, { recursive: true });
  return { root, assignment, input, out: join(root, 'out') };
}

async function student(env: Env, name: string, script: string | null): Promise<void> {
  const dir = join(env.input, name);
  await mkdir(join(dir, 'src'), { recursive: true });
  if (script !== null) await writeFile(join(dir, 'src', 'prog.sh'), script);
}

const GOOD = '#!/bin/sh\necho ok\n';
const HANG = '#!/bin/sh\nsleep 60\n';

function recorder(order: string[], captured: SubmissionResult[] = []) {
  return fp(
    (app) => {
      for (const name of ['onRunStart', 'onSubmission', 'onBuild', 'onScenarioStart', 'onScore', 'onReport', 'onRunEnd'] as const) {
        app.hook(name, () => {
          order.push(name);
        });
      }
      app.reporter('capture', {
        description: 'captures results',
        scope: 'submission',
        reportSubmission: async (_ctx, result) => {
          captured.push(result);
        },
      });
    },
    { name: 'recorder' },
  );
}

/** Workdirs in the OS temp dir whose project holds `marker` (unique per test): never matches other tests' dirs. */
async function workdirsContaining(marker: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(tmpdir())) {
    if (!name.startsWith('tui-grade-sub-')) continue;
    const file = join(tmpdir(), name, 'src', 'prog.sh');
    try {
      if ((await readFile(file, 'utf8')).includes(marker)) found.push(join(tmpdir(), name));
    } catch (error) {
      // another worker may remove its own dir at any moment; only a vanished entry is expected
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found;
}

/** Records every submission's workDir as seen by `onSubmission`. */
const workdirSpy = (seen: string[]) =>
  fp(
    (app) => {
      app.hook('onSubmission', ({ submission }) => {
        seen.push(submission.workDir);
      });
    },
    { name: 'workdir-spy' },
  );

/** A step that records one session whose final screen is 'SCREEN TEXT'. */
const sessionPlugin = fp(
  (app) => {
    app.step('fake_session', {
      description: 'records a session',
      params: z.unknown(),
      produces: 'session',
      run: async (ctx) => {
        const id = ctx.currentStepId ?? 'session-1';
        const record = { id, screen: 'SCREEN TEXT', exitCode: null, exited: false, timedOut: false, durationMs: 1 };
        ctx.sessions.set(id, record);
        ctx.lastSession = record;
      },
    });
  },
  { name: 'screens' },
);

const itNotRoot = process.getuid?.() === 0 ? it.skip : it;

const byId = (results: SubmissionResult[], id: string): SubmissionResult => {
  const found = results.find((r) => r.student.id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
};

describe('gradeAll', () => {
  it('grades every submission and takes ids from folder names (a)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      await student(env, 'bob', GOOD);
      const { results, outDir } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out });
      expect(outDir).toBe(env.out);
      expect(results.map((r) => r.student.id)).toEqual(['alice', 'bob']);
      const alice = byId(results, 'alice');
      expect(alice).toMatchObject({ schemaVersion: 1, assignment: 'Fake', locale: 'en', structure: { rootFound: true } });
      expect(alice.build).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
      expect(alice.scenarios.map((s) => s.status)).toEqual(['passed', 'passed', 'passed']);
      expect(alice.score.points).toBe(8);
      expect(alice.score.groups.find((g) => g.id === 'review')?.pending).toBe(true);
    });
  });

  it('marks a hanging program as failed without hurting the other submission (b)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'hang', HANG);
      await student(env, 'good', GOOD);
      const started = Date.now();
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out });
      expect(Date.now() - started).toBeLessThan(20_000);
      const hang = byId(results, 'hang');
      expect(hang.scenarios.find((s) => s.id === '2-1')?.status).toBe('failed');
      expect(hang.score.points).toBe(2);
      expect(byId(results, 'good').scenarios.every((s) => s.status === 'passed')).toBe(true);
    });
  });

  it('turns a throwing step into an error for that scenario only (c)', async () => {
    await withTempDir(async (root) => {
      const scenarios = `${SCENARIOS}- id: "3-1"
  title: T3-1
  group: structure
  steps:
    - boom: {}
  expect:
    - file_exists: a.txt
`;
      const env = await setup(root, { scenarios });
      await student(env, 'alice', GOOD);
      const boom = fp(
        (app) => {
          app.step('boom', {
            description: 'throws',
            params: z.unknown(),
            run: async () => {
              throw new Error('kaboom');
            },
          });
        },
        { name: 'boom' },
      );
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [boom] });
      const alice = byId(results, 'alice');
      const statuses = Object.fromEntries(alice.scenarios.map((s) => [s.id, s.status]));
      expect(statuses).toEqual({ '1-1': 'passed', '2-1': 'passed', '2-2': 'passed', '3-1': 'error' });
      expect(alice.scenarios.find((s) => s.id === '3-1')?.error).toContain('kaboom');
    });
  });

  it('runs scenarios without a binary after a build failure (d)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root, { assignment: ASSIGNMENT.replace('cp src/prog.sh bin/prog', 'false') });
      await student(env, 'alice', GOOD);
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out });
      const alice = byId(results, 'alice');
      expect(alice.build.ok).toBe(false);
      expect(alice.build.exitCode).not.toBe(0);
      const run = alice.scenarios.find((s) => s.id === '2-1');
      expect(run?.status).toBe('error');
      expect(run?.error).toContain('build_failed');
      const groups = Object.fromEntries(alice.score.groups.map((g) => [g.id, g.points]));
      expect(groups).toMatchObject({ structure: 2, behaviour: 0 });
      expect(alice.score.points).toBe(2);
    });
  });

  it('handles a missing project root without crashing (e)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'empty', null);
      await student(env, 'good', GOOD);
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out });
      const empty = byId(results, 'empty');
      expect(empty.structure.rootFound).toBe(false);
      expect(empty.source.root).toBeNull();
      expect(empty.build).toMatchObject({ ok: false, message: 'project_root_not_found', exitCode: null, log: '' });
      expect(empty.scenarios).toHaveLength(3);
      expect(empty.scenarios.find((s) => s.id === '1-1')?.status).toBe('passed');
      expect(empty.scenarios.find((s) => s.id === '2-1')?.status).toBe('error');
      expect(empty.warnings.some((w) => w.includes('project root not found'))).toBe(true);
      expect(byId(results, 'good').build.ok).toBe(true);
    });
  });

  it('--only runs just the selected scenario (f)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const { results, issues } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, only: ['2-1', 'nope'] });
      expect(byId(results, 'alice').scenarios.map((s) => s.id)).toEqual(['2-1']);
      expect(issues).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('nope') })]);
    });
  });

  it('fires hooks in the documented order (g)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root, { scenarios: SCENARIOS.split('- id: "2-1"')[0] as string });
      await student(env, 'alice', GOOD);
      const order: string[] = [];
      await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [recorder(order)] });
      expect(order).toEqual(['onRunStart', 'onSubmission', 'onBuild', 'onScenarioStart', 'onScore', 'onReport', 'onRunEnd']);
    });
  });

  it('records a throwing onReport hook as a warning (h)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const captured: SubmissionResult[] = [];
      const bad = fp(
        (app) => {
          app.hook('onReport', () => {
            throw new Error('report hook broke');
          });
        },
        { name: 'bad-report' },
      );
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [bad, recorder([], captured)] });
      expect(results).toHaveLength(1);
      expect(byId(results, 'alice').warnings).toContain('hook onReport failed: report hook broke');
    });
  });

  it('removes workdirs unless keepWorkdirs is set (i)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      await student(env, 'bob', GOOD);

      const removed: string[] = [];
      await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [workdirSpy(removed)] });
      expect(removed).toHaveLength(2);
      for (const dir of removed) expect(existsSync(dir)).toBe(false);

      const kept: string[] = [];
      await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, keepWorkdirs: true, extraPlugins: [workdirSpy(kept)] });
      try {
        expect(kept).toHaveLength(2);
        for (const dir of kept) expect(existsSync(dir)).toBe(true);
      } finally {
        await Promise.all(kept.map((dir) => rm(dir, { recursive: true, force: true })));
      }
    });
  });

  it('rejects with ConfigError when the assignment has error issues (j)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root, { scenarios: SCENARIOS.replace('write_file', 'no_such_step') });
      await student(env, 'alice', GOOD);
      const err = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.some((i) => i.severity === 'error' && i.message.includes('no_such_step'))).toBe(true);
      expect((err as ConfigError).message).toContain('no_such_step');
    });
  });

  it('rejects with ConfigError when assignment.yaml is missing', async () => {
    await withTempDir(async (root) => {
      const err = await gradeAll({ assignmentDir: join(root, 'nothing'), inputPath: root, outDir: join(root, 'out') }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
    });
  });

  it('writes build.log and screens and sets artifacts before reporters run', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const scenarios = `- id: "s/1"
  title: Ts/1
  group: structure
  steps:
    - fake_session: {}
      id: main
  expect:
    - file_exists: nothing.txt
`;
      await writeFile(join(env.assignment, 'scenarios', 's.yaml'), scenarios);
      const seen: string[][] = [];
      const spy = fp(
        (app) => {
          app.reporter('spy', {
            description: 'spy',
            scope: 'submission',
            reportSubmission: async (_c, r) => {
              seen.push(r.scenarios.flatMap((s) => s.artifacts));
            },
          });
        },
        { name: 'spy' },
      );
      const cmd = ASSIGNMENT.replace('mkdir -p bin', 'echo compiling && mkdir -p bin');
      await writeFile(join(env.assignment, 'assignment.yaml'), cmd);
      await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [sessionPlugin, spy] });
      expect(seen).toEqual([['screens/s_1-main.txt']]);
      expect(await readFile(join(env.out, 'alice', 'screens', 's_1-main.txt'), 'utf8')).toBe('SCREEN TEXT');
      expect(await readFile(join(env.out, 'alice', 'build.log'), 'utf8')).toContain('compiling');
    });
  });

  it('applies manual points and reports unknown groups, missing and unknown students', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      await student(env, 'bob', GOOD);
      const manualFile = join(root, 'manual.yaml');
      await writeFile(manualFile, 'alice: { review: 2, bogus: 1 }\nghost: { review: 1 }\n');
      const { results, issues } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, manualFile });
      const alice = byId(results, 'alice');
      expect(alice.score.points).toBe(10);
      expect(alice.score.groups.find((g) => g.id === 'review')).toMatchObject({ points: 2, pending: false });
      expect(alice.warnings.some((w) => w.includes("unknown group 'bogus'"))).toBe(true);
      expect(byId(results, 'bob').warnings.some((w) => w.includes('not listed in the manual points file'))).toBe(true);
      expect(issues.some((i) => i.severity === 'warning' && i.message.includes("unknown student 'ghost'"))).toBe(true);
    });
  });

  it('runs reporters per submission then per run and survives a throwing reporter', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const calls: string[] = [];
      const reporters = fp(
        (app) => {
          app.reporter('broken', {
            description: 'broken',
            scope: 'submission',
            reportSubmission: async () => {
              throw new Error('nope');
            },
            reportRun: async () => {
              throw new Error('nope-run');
            },
          });
          app.reporter('ok', {
            description: 'ok',
            scope: 'run',
            reportSubmission: async (ctx) => {
              calls.push(`sub:${ctx.outDir}`);
            },
            reportRun: async (_ctx, results) => {
              calls.push(`run:${results.length}`);
            },
          });
        },
        { name: 'reporters' },
      );
      const { results, issues } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [reporters] });
      expect(calls).toEqual([`sub:${env.out}`, 'run:1']);
      expect(byId(results, 'alice').warnings).toContain('reporter broken failed: nope');
      expect(issues.some((i) => i.message.includes('nope-run'))).toBe(true);
    });
  });

  it('aborts the run when an onRunStart hook fails and still removes the workdirs', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      const marker = `# marker-${process.pid}-${Date.now()}`;
      await student(env, 'alice', `${GOOD}${marker}\n`);
      const bad = fp(
        (app) => {
          app.hook('onRunStart', () => {
            throw new Error('no start');
          });
        },
        { name: 'bad-start' },
      );
      await expect(gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [bad] })).rejects.toThrow('no start');
      expect(await workdirsContaining(marker)).toEqual([]);
    });
  });

  it('lets onScore hooks mutate the score and passes the translator on', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const keys: string[] = [];
      const plugin = fp(
        (app) => {
          app.hook('onScore', ({ score }) => {
            score.points = 1;
          });
          app.reporter('t', {
            description: 't',
            scope: 'submission',
            reportSubmission: async (ctx) => {
              keys.push(ctx.t('some.key'));
            },
          });
        },
        { name: 'mutate' },
      );
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [plugin], translate: (k) => `T(${k})` });
      expect(results[0]?.score.points).toBe(1);
      expect(keys).toEqual(['T(some.key)']);
    });
  });

  it('replaces build.log and screens of a previous run in the same outDir', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const withScreen = `- id: "s1"
  title: S1
  group: structure
  steps:
    - fake_session: {}
      id: main
  expect:
    - file_exists: nothing.txt
`;
      await writeFile(join(env.assignment, 'scenarios', 's.yaml'), withScreen);
      await writeFile(join(env.assignment, 'assignment.yaml'), ASSIGNMENT.replace('mkdir -p bin', 'echo compiling && mkdir -p bin'));
      const opts = { assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [sessionPlugin] };
      await gradeAll(opts);
      const studentDir = join(env.out, 'alice');
      expect(existsSync(join(studentDir, 'build.log'))).toBe(true);
      expect(existsSync(join(studentDir, 'screens', 's1-main.txt'))).toBe(true);

      // second run: no build output, no session
      await writeFile(join(env.assignment, 'scenarios', 's.yaml'), SCENARIOS);
      await writeFile(join(env.assignment, 'assignment.yaml'), ASSIGNMENT);
      const { results } = await gradeAll(opts);
      expect(results[0]?.build.log).toBe('');
      expect(existsSync(join(studentDir, 'build.log'))).toBe(false);
      expect(existsSync(join(studentDir, 'screens'))).toBe(false);
    });
  });

  itNotRoot('reports a workdir that cannot be removed as a warning of that submission', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      await student(env, 'bob', GOOD);
      // `inner` cannot be unlinked from its read-only parent, and no chmod of the tree itself can change that
      const locked = join(root, 'locked');
      const inner = join(locked, 'inner');
      await mkdir(inner, { recursive: true });
      await writeFile(join(inner, 'file'), 'x');
      await chmod(locked, 0o500);

      const originals: string[] = [];
      const sabotage = fp(
        (app) => {
          app.hook('onSubmission', ({ submission }) => {
            if (submission.id !== 'alice') return;
            originals.push(submission.workDir);
            submission.workDir = inner;
          });
        },
        { name: 'sabotage' },
      );
      try {
        const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [sabotage] });
        const alice = byId(results, 'alice');
        expect(alice.warnings.some((w) => w.startsWith(`cannot remove workdir ${inner}: `))).toBe(true);
        expect(byId(results, 'bob').warnings.some((w) => w.includes('cannot remove workdir'))).toBe(false);
      } finally {
        await chmod(locked, 0o700);
        await Promise.all(originals.map((dir) => rm(dir, { recursive: true, force: true })));
      }
    });
  });
});

describe('gradeAll while the grader is shutting down', () => {
  afterEach(() => __setShuttingDown(false));

  /** Sets the shutdown flag when the first scenario of the first submission ends, as a signal handler would mid-run. */
  const signalAfterFirstScenario = fp(
    (app) => {
      app.hook('onScenarioEnd', () => {
        __setShuttingDown(true);
      });
    },
    { name: 'signal-mid-run' },
  );

  it('stops cleanly: no artifact, no report, no further submission, no leftover workdir', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      const marker = `marker-${Date.now()}-${Math.random()}`;
      await student(env, 'alice', `${GOOD}# ${marker}\n`);
      await student(env, 'bob', `${GOOD}# ${marker}\n`);
      const logs: string[] = [];
      const { results, issues } = await gradeAll({
        assignmentDir: env.assignment,
        inputPath: env.input,
        outDir: env.out,
        extraPlugins: [signalAfterFirstScenario],
        log: (m) => logs.push(m),
      });

      expect(results.map((r) => r.student.id)).toEqual(['alice']); // bob was never graded
      const alice = byId(results, 'alice');
      expect(alice.warnings.some((w) => w.startsWith('interrupted'))).toBe(true);
      expect(alice.scenarios.map((s) => s.id)).toEqual(['1-1']); // the remaining scenarios were not started
      expect(issues.some((i) => i.message.startsWith('interrupted'))).toBe(true);
      expect(logs.some((m) => m.includes('[bob]'))).toBe(false);
      expect(await readdir(env.out)).toEqual(['run.json']); // no results.json, report.md, zip, logs/, screens/, summary.csv
      expect(await workdirsContaining(marker)).toEqual([]);
    });
  });

  it('starts no submission when the signal arrives before the first one (no onRunEnd, no summary)', async () => {
    await withTempDir(async (root) => {
      const env = await setup(root);
      await student(env, 'alice', GOOD);
      const order: string[] = [];
      const early = fp(
        (app) => {
          app.hook('onRunStart', () => {
            __setShuttingDown(true);
          });
        },
        { name: 'signal-early' },
      );
      const { results, issues } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: env.out, extraPlugins: [early, recorder(order)] });
      expect(results).toEqual([]);
      expect(issues.some((i) => i.message.startsWith('interrupted'))).toBe(true);
      expect(order).not.toContain('onSubmission');
      expect(order).not.toContain('onRunEnd');
      expect(await readdir(env.out)).toEqual(['run.json']);
    });
  });
});
