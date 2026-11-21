import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli/main.ts';
import { __setShuttingDown } from '../../src/core/shutdown.ts';
import { VERSION } from '../../src/index.ts';
import { BAD, GOOD, addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';
import { makeZip } from '../helpers/zip.ts';

const fixture = (name: string): string => new URL(`../fixtures/assignments/${name}`, import.meta.url).pathname;
const repoRoot = new URL('../..', import.meta.url).pathname;

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(argv: string[], cwd?: string): Promise<Outcome> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { code, stdout, stderr };
}

describe('tui-grade check', () => {
  it('(a) accepts a valid assignment and never starts a student process or a build', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = await cli(['check', env.assignment]);
      expect(out).toEqual({ code: 0, stdout: expect.stringContaining('valid'), stderr: '' });
      expect(existsSync(env.marker)).toBe(false);
      // sanity: the marker really is written once a build happens
      await cli(['run', env.assignment, env.input, '--out', join(root, 'out')]);
      expect(existsSync(env.marker)).toBe(true);
    });
  });

  it('(b) --json reports an invalid assignment with pointers and exits 1', async () => {
    const out = await cli(['check', fixture('bad-unknown-step'), '--json']);
    expect(out.code).toBe(1);
    const json = JSON.parse(out.stdout) as { ok: boolean; issues: Array<{ path: string; message: string; severity: string }>; scenarios: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.issues).toEqual(
      expect.arrayContaining([{ path: 'scenarios/s.yaml#/0/steps/0', message: expect.stringContaining("unknown step 'bogus'"), severity: 'error' }]),
    );
    expect(json.scenarios).toEqual([{ id: 'one', title: 'One', file: 'scenarios/s.yaml' }]);
  });

  it('--json of a valid assignment has the documented shape', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const out = await cli(['check', env.assignment, '--json']);
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({
        ok: true,
        issues: [],
        scenarios: [
          { id: '1-1', title: 'Clean exit', group: 'structure', file: 'scenarios/s.yaml' },
          { id: '2-fast', title: 'Mode fast', group: 'behaviour', file: 'scenarios/s.yaml' },
          { id: '2-slow', title: 'Mode slow', group: 'behaviour', file: 'scenarios/s.yaml' },
        ],
      });
    });
  });

  it('prints path: message lines to stderr in text mode and exits 1', async () => {
    const out = await cli(['check', fixture('bad-unknown-step')]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/^scenarios\/s\.yaml#\/0\/steps\/0: unknown step 'bogus'/m);
  });

  it('(c) --list prints the expanded scenario ids and titles (localized)', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const out = await cli(['check', env.assignment, '--list']);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('2-fast');
      expect(out.stdout).toContain('2-slow');
      expect(out.stdout).toContain('Mode slow');
      expect(out.stdout).not.toContain('${mode}');
    });
  });

  it('warnings alone do not make the assignment invalid, but they are printed', async () => {
    await withTempDir(async (root) => {
      const scenarios = `- id: only\n  title: { sk: Len slovensky }\n  group: structure\n  steps:\n    - write_file: { path: a.txt, content: x }\n  expect:\n    - file_exists: a.txt\n`;
      const env = await fakeAssignment(root, { scenarios });
      const out = await cli(['check', env.assignment]);
      expect(out.code).toBe(0);
      expect(out.stderr).toMatch(/has no 'en' translation/);
    });
  });

  it('(h) a missing assignment directory exits 1 with a message', async () => {
    const out = await cli(['check', '/definitely/not/here']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('not found');
  });
});

describe('tui-grade describe / schema', () => {
  it('(d) describe --json includes exit_code with a JSON Schema object and an example', async () => {
    const out = await cli(['describe', '--json']);
    expect(out.code).toBe(0);
    const entries = JSON.parse(out.stdout) as Array<{ kind: string; name: string; description: string; example?: string; params: object }>;
    const exitCode = entries.find((e) => e.kind === 'check' && e.name === 'exit_code');
    expect(exitCode?.example).toContain('exit_code');
    expect(typeof exitCode?.params).toBe('object');
    expect(exitCode?.params).not.toBeNull();
    expect(entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['step', 'check', 'builder', 'reporter', 'scorer']));
  });

  it('describe in text mode is a compact list; with a directory it includes the assignment plugins', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await writeFile(
        join(env.assignment, 'extra.ts'),
        // no zod import: a temp dir cannot resolve it; the placeholder params also exercise the JSON Schema fallback
        "export default { meta: { name: 'extra' }, shared: true, fn: (app) => { app.check('extra_check', { description: 'from the assignment', params: {}, source: 'none', describe: () => 'x', run: async () => ({ pass: true }) }); } };\n",
      );
      await writeFile(join(env.assignment, 'assignment.yaml'), `${await readFile(join(env.assignment, 'assignment.yaml'), 'utf8')}plugins: ["./extra.ts"]\n`);
      const plain = await cli(['describe']);
      expect(plain.stdout).toContain('exit_code');
      expect(plain.stdout).not.toContain('extra_check');
      const withDir = await cli(['describe', env.assignment]);
      expect(withDir.stderr).toBe('');
      expect(withDir.code).toBe(0);
      expect(withDir.stdout).toContain('extra_check');
      expect(withDir.stdout).toContain('from the assignment');
    });
  });

  it('describe of a broken assignment directory exits 1', async () => {
    const out = await cli(['describe', '/definitely/not/here']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('not found');
  });

  it('(e) schema prints valid JSON that names every registered check', async () => {
    const described = JSON.parse((await cli(['describe', '--json'])).stdout) as Array<{ kind: string; name: string }>;
    const out = await cli(['schema']);
    expect(out.code).toBe(0);
    const schema = JSON.parse(out.stdout) as { $defs: { check: { properties: Record<string, unknown> }; assignment: object } };
    const checks = described.filter((e) => e.kind === 'check').map((e) => e.name);
    expect(checks.length).toBeGreaterThan(5);
    for (const name of checks) expect(schema.$defs.check.properties).toHaveProperty(name);
    expect(typeof schema.$defs.assignment).toBe('object');
  });
});

describe('tui-grade run', () => {
  it('(f) exits 0 even when a student scores 0, writes summary.csv and the summary table', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      await addStudent(env, 'broken', null);
      const out = join(root, 'out');
      const result = await cli(['run', env.assignment, env.input, '--out', out]);
      expect(result.code).toBe(0);
      expect(await readFile(join(out, 'summary.csv'), 'utf8')).toContain('alice;16;20');
      expect(result.stdout).toMatch(/alice\s+16\s*\/\s*20/);
      expect(result.stdout).toMatch(/broken\s+0\s*\/\s*20/);
      // progress goes to stderr and never into the student output
      expect(result.stderr).toContain('[alice] building');
      expect(result.stdout).not.toContain('[alice] building');
      const files = (await readdir(join(out, 'alice'), { recursive: true })).join('\n');
      expect(files).not.toMatch(/progress|\.log$/);
    });
  });

  it('(g) --fail-under N exits 2 when any student is below N', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      await addStudent(env, 'bob', BAD);
      const run = (n: string): Promise<Outcome> => cli(['run', env.assignment, env.input, '--out', join(root, `out-${n}`), '--fail-under', n]);
      expect((await run('15')).code).toBe(2); // bob has 0 points
      expect((await run('0')).code).toBe(0); // nobody is below 0
    });
  });

  it('(h) a missing assignment directory exits 1 with a message', async () => {
    await withTempDir(async (root) => {
      const out = await cli(['run', join(root, 'nope'), root, '--out', join(root, 'out')]);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('assignment.yaml#/: assignment.yaml not found');
    });
  });

  it('an invalid assignment prints each issue as path: message and exits 1', async () => {
    await withTempDir(async (root) => {
      const out = await cli(['run', fixture('bad-unknown-step'), root, '--out', join(root, 'out')]);
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/^scenarios\/s\.yaml#\/0\/steps\/0: unknown step 'bogus'/m);
      expect(existsSync(join(root, 'out'))).toBe(false);
    });
  });

  it('a missing input path exits 1 with a message', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const out = await cli(['run', env.assignment, join(root, 'no-input'), '--out', join(root, 'out')]);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('input path does not exist');
    });
  });

  it('(j) --locale sk yields a Slovak report.md', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      expect((await cli(['run', env.assignment, env.input, '--out', out, '--locale', 'sk'])).code).toBe(0);
      const report = await readFile(join(out, 'alice', 'report.md'), 'utf8');
      expect(report).toContain('Správa o hodnotení');
      expect(report).toContain('Rezim fast');
    });
  });

  it('rejects an unknown locale', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const out = await cli(['run', env.assignment, env.input, '--locale', 'de', '--out', join(root, 'out')]);
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/locale/);
    });
  });

  it('defaults --out to the platform data directory', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const cwd = join(root, 'cwd');
      await mkdir(cwd);
      const data = join(root, 'data');
      const previous = process.env['TUI_GRADE_DATA_DIR'];
      process.env['TUI_GRADE_DATA_DIR'] = data;
      try {
        const out = await cli(['run', env.assignment, env.input], cwd);
        expect(out.code).toBe(0);
        const dirs = await readdir(data);
        expect(dirs).toHaveLength(1);
        expect(dirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
        expect(existsSync(join(data, dirs[0] as string, 'summary.csv'))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env['TUI_GRADE_DATA_DIR'];
        else process.env['TUI_GRADE_DATA_DIR'] = previous;
      }
    });
  });

  it('--only restricts the scenarios; an unknown id is a warning, not a failure', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      const result = await cli(['run', env.assignment, env.input, '--out', out, '--only', '1-1,nope']);
      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(/no scenario with id 'nope'/);
      const json = JSON.parse(await readFile(join(out, 'alice', 'results.json'), 'utf8')) as { scenarios: Array<{ id: string }> };
      expect(json.scenarios.map((s) => s.id)).toEqual(['1-1']);
    });
  });

  it('--manual awards points; an unknown group is a warning, not a failure', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const manual = join(root, 'manual.yaml');
      await writeFile(manual, 'alice: { review: 3, nope: 1 }\n');
      const result = await cli(['run', env.assignment, env.input, '--out', join(root, 'out'), '--manual', manual]);
      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(/unknown group 'nope'/);
      expect(result.stdout).toMatch(/alice\s+19\s*\/\s*20/);
    });
  });

  it('--keep-workdirs keeps the work directory and reports its path; without it nothing is kept', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const plain = await cli(['run', env.assignment, env.input, '--out', join(root, 'out-plain')]);
      expect(plain.stderr).not.toContain('workdir kept');

      const result = await cli(['run', env.assignment, env.input, '--out', join(root, 'out'), '--keep-workdirs']);
      expect(result.code).toBe(0);
      const kept = /^\[alice\] workdir kept: (.+)$/m.exec(result.stderr)?.[1];
      expect(kept).toBeDefined();
      try {
        expect(existsSync(join(kept as string, 'src', 'prog.sh'))).toBe(true);
      } finally {
        // only the path this very run reported; never glob the shared temp directory
        await rm(kept as string, { recursive: true, force: true });
      }
    });
  });

  describe('--only validation', () => {
    const attempt = async (only: string): Promise<{ out: Outcome; outDir: string }> => {
      let result: { out: Outcome; outDir: string } | undefined;
      await withTempDir(async (root) => {
        const env = await fakeAssignment(root);
        await addStudent(env, 'alice', GOOD);
        const outDir = join(root, 'out');
        result = { out: await cli(['run', env.assignment, env.input, '--out', outDir, '--only', only]), outDir };
        expect(existsSync(outDir)).toBe(false);
      });
      return result as { out: Outcome; outDir: string };
    };

    it.each(['', ','])('rejects %j: at least one id is needed, nothing is created', async (only) => {
      const { out } = await attempt(only);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('--only needs at least one scenario id');
      expect(out.stdout).toBe('');
    });

    it('rejects ids that match no scenario, naming the available ones', async () => {
      const { out } = await attempt('nosuch, alsonot');
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('--only matches no scenario');
      expect(out.stderr).toContain('nosuch, alsonot');
      expect(out.stderr).toContain('2-fast');
      expect(out.stdout).toBe('');
    });

    it('still runs when at least one requested id exists', async () => {
      await withTempDir(async (root) => {
        const env = await fakeAssignment(root);
        await addStudent(env, 'alice', GOOD);
        const outDir = join(root, 'out');
        const out = await cli(['run', env.assignment, env.input, '--out', outDir, '--only', ' 2-fast ,']);
        expect(out.code).toBe(0);
        const json = JSON.parse(await readFile(join(outDir, 'alice', 'results.json'), 'utf8')) as { scenarios: Array<{ id: string }> };
        expect(json.scenarios.map((s) => s.id)).toEqual(['2-fast']);
      });
    });

    it('leaves an invalid assignment to the normal issue report', async () => {
      await withTempDir(async (root) => {
        const out = await cli(['run', fixture('bad-unknown-step'), root, '--out', join(root, 'out'), '--only', 'nosuch']);
        expect(out.code).toBe(1);
        expect(out.stderr).toMatch(/^scenarios\/s\.yaml#\/0\/steps\/0: unknown step 'bogus'/m);
      });
    });
  });
});

describe('tui-grade run --events and rescore', () => {
  it('writes one JSON event per line and no human table', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = await cli(['run', env.assignment, env.input, '--out', join(root, 'out'), '--events']);
      expect(out.code).toBe(0);
      expect(out.stdout).not.toContain('Student');
      const events = out.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; schemaVersion: number });
      expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
      expect(events.map((event) => event.type)).toContain('run-start');
      expect(events.at(-1)?.type).toBe('run-end');
    });
  });

  it('rescoring applies a manual points file without a new build', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      expect((await cli(['run', env.assignment, env.input, '--out', out])).code).toBe(0);
      const marker = await readFile(env.marker, 'utf8');
      const manual = join(root, 'manual.yaml');
      await writeFile(manual, 'alice:\n  review: 3.5\n');
      const rescored = await cli(['rescore', env.assignment, out, '--manual', manual]);
      expect(rescored.code).toBe(0);
      expect(rescored.stdout).toContain('19.5 / 20');
      const result = JSON.parse(await readFile(join(out, 'alice', 'results.json'), 'utf8')) as { score: { points: number } };
      expect(result.score.points).toBe(19.5);
      expect(await readFile(env.marker, 'utf8')).toBe(marker);
    });
  });
});

describe('tui-grade usage', () => {
  it('(i) an unknown flag exits 1 with usage on stderr', async () => {
    const out = await cli(['check', '--bogus', 'x']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/--bogus/);
    expect(out.stderr).toMatch(/Usage:/);
    expect(out.stdout).toBe('');
  });

  it('an unknown command and missing arguments exit 1 with usage', async () => {
    for (const argv of [['frobnicate'], ['check'], ['run', 'only-one'], ['rescore', 'only-one'], ['run', 'a', 'b', 'c']]) {
      const out = await cli(argv);
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/Usage:/);
    }
  });

  it('--help prints usage on stdout and exits 0', async () => {
    const out = await cli(['--help']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/Usage:/);
  });

  it.each(['lots', ' ', '', '-1', '0x10', '1e3', '.5', '5.', '+3', 'Infinity', 'NaN', '1,5'])('rejects --fail-under %j (only non-negative decimals are numbers)', async (value) => {
    const out = await cli(['run', 'a', 'b', `--fail-under=${value}`]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/--fail-under needs a non-negative decimal number/);
    expect(out.stderr).toMatch(/Usage:/);
  });

  it('accepts decimal --fail-under values', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const run = (n: string): Promise<Outcome> => cli(['run', env.assignment, env.input, '--out', join(root, `out-${n}`), '--fail-under', n]);
      expect((await run('15.5')).code).toBe(0); // 16 points
      expect((await run('16.5')).code).toBe(2);
      expect((await run('00016')).code).toBe(0);
    });
  });

  it('--version and -v print the package version and exit 0', async () => {
    for (const flag of ['--version', '-v']) {
      const out = await cli([flag]);
      expect(out).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
    }
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect((await cli(['--help'])).stdout).toContain('--version');
  });

  it('never prints control characters taken from a student-chosen entry name (terminal and report.md)', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await writeFile(
        join(env.input, 'alice.zip'),
        await makeZip([
          { name: 'src/prog.sh', content: GOOD },
          { name: '../\u001b[2J\u001b]0;pwned\u0007evil.txt', content: 'x' },
        ]),
      );
      const out = await cli(['run', env.assignment, env.input, '--out', join(root, 'out')]);
      expect(out.code).toBe(0);
      expect(out.stderr).toContain('[alice] warning: skipped unsafe ZIP entry: ../?[2J?]0;pwned?evil.txt');
      expect(out.stderr + out.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      const report = await readFile(join(root, 'out', 'alice', 'report.md'), 'utf8');
      expect(report).toContain('skipped unsafe ZIP entry');
      expect(report).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    });
  });

  it('runs when the entry file is executed directly', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const proc = spawnSync(process.execPath, ['src/cli/main.ts', 'check', env.assignment, '--json'], { cwd: repoRoot, encoding: 'utf8' });
      expect(proc.status).toBe(0);
      expect((JSON.parse(proc.stdout) as { ok: boolean }).ok).toBe(true);
      const bad = spawnSync(process.execPath, ['src/cli/main.ts', 'check', '--nope'], { cwd: repoRoot, encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/Usage:/);
    });
  });
});

describe('tui-grade run after Ctrl-C / SIGTERM (shutdown flag set mid-run)', () => {
  afterEach(() => __setShuttingDown(false));

  /** An assignment plugin that raises the flag, as the signal handler would, when the first scenario ends. */
  const flagPlugin = (signal: 'SIGINT' | 'SIGTERM'): string => {
    const shutdown = new URL('../../src/core/shutdown.ts', import.meta.url).href;
    return `import { __setShuttingDown } from '${shutdown}';\nexport default { meta: { name: 'flag' }, shared: true, fn: (app) => { app.hook('onScenarioEnd', () => { __setShuttingDown(true, '${signal}'); }); } };\n`;
  };

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s: prints no table and no "graded" line, skips --fail-under and returns %i', async (signal, expected) => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      await addStudent(env, 'bob', GOOD);
      await addStudent(env, 'carol', GOOD);
      await writeFile(join(env.assignment, 'flag.ts'), flagPlugin(signal));
      await writeFile(join(env.assignment, 'assignment.yaml'), `${await readFile(join(env.assignment, 'assignment.yaml'), 'utf8')}plugins: ["./flag.ts"]\n`);
      const out = await cli(['run', env.assignment, env.input, '--out', join(root, 'out'), '--fail-under', '20']); // 0 points would otherwise give 2
      expect(out.code).toBe(expected);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('interrupted: results are incomplete');
      expect(out.stderr).toMatch(/\[alice\] warning: interrupted/);
      expect(out.stderr).not.toContain('--fail-under');
      expect(out.stderr).not.toContain('bob'); // never started
    });
  });

  it('a normal run is unaffected (flag cleared): table, graded line and the --fail-under verdict', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = await cli(['run', env.assignment, env.input, '--out', join(root, 'out'), '--fail-under', '20']);
      expect(out.code).toBe(2);
      expect(out.stdout).toContain('1 submission graded; results in');
    });
  });
});
