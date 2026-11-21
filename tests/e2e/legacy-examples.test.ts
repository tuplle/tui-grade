// Acceptance suite of the examples `examples/sentinel` and `examples/vindex`: ports of two hand-written tui-test
// projects whose setup helpers became USER PLUGINS (steps insert_device, insert_incident, index_file).
// Each assignment is checked, described through the CLI and graded against its reference solution plus
// small mutated copies of it that must lose exactly the expected scenarios.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DescribeEntry, SubmissionResult } from '../../src/index.ts';
import { createGrader } from '../../src/index.ts';
import { hasTool, itIf } from '../helpers/tmp.ts';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repo, 'src', 'cli', 'main.ts');

const hasGpp = hasTool('g++');
const runIf = itIf(hasGpp);

const failedIds = (r: SubmissionResult): string[] => r.scenarios.filter((s) => s.status !== 'passed').map((s) => s.id).sort();
const group = (r: SubmissionResult, id: string) => {
  const found = r.score.groups.find((g) => g.id === id);
  if (found === undefined) throw new Error(`no group ${id}`);
  return found;
};

/** `source` with `from` replaced by `to`; fails loudly when the mutation no longer applies to the solution. */
function mutate(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`mutation target not found in the solution: ${from}`);
  return source.replace(from, to);
}

interface Example {
  name: string;
  dir: string;
  steps: string[];
  /** name of the variant -> edited main.cpp */
  variants(solution: string): Record<string, string>;
}

const examples: Example[] = [
  {
    name: 'sentinel',
    dir: fileURLToPath(new URL('../../examples/sentinel', import.meta.url)),
    steps: ['insert_device', 'insert_incident'],
    variants: (solution) => ({
      // `y` no longer removes the incident from the queue
      'no-pop': mutate(solution, 'queue.pop();', ''),
      // a device with a taken IP address is overwritten instead of rejected
      'dup-ip': mutate(solution, 'if (devices.count(ip) > 0) return', 'if (false) return'),
      // `new` always fails: the setup steps of the scenarios cannot work
      'new-broken': mutate(solution, 'if (!isValidIp(ip)) return', 'if (true) return'),
      // an invalid answer ends the program instead of asking again
      'invalid-exits': mutate(solution, 'std::cout << "Invalid input, answer Y or N.\\n";', 'std::cout << "Invalid input, answer Y or N.\\n";\n        return 0;'),
      // the question is printed once and never repeated (and the invalid-input message carries no hint)
      'prompt-once': mutate(
        mutate(solution, '    while (true) {\n        std::cout << "Was the incident resolved? [Y/N]: " << std::flush;', '    std::cout << "Was the incident resolved? [Y/N]: " << std::flush;\n    while (true) {'),
        'Invalid input, answer Y or N.',
        'Invalid input.',
      ),
      // another spelling of the question: the scenarios must not insist on "Y/N"
      'alt-prompt': mutate(mutate(solution, '[Y/N]', '(A/N)'), 'answer Y or N', 'answer A alebo N'),
    }),
  },
  {
    name: 'vindex',
    dir: fileURLToPath(new URL('../../examples/vindex', import.meta.url)),
    steps: ['index_file'],
    variants: (solution) => ({
      // an already indexed file is counted again
      'reindex-doubles': mutate(solution, 'if (indexedFiles(trie).count(path) > 0) {', 'if (false) {'),
      // the total line of `search` is gone
      'no-total': mutate(solution, 'std::cout << "Total occurrences: " << total(*node) << "\\n";', ''),
      // the top list holds one word only
      'top-one': mutate(solution, 'i < words.size() && i < 5;', 'i < words.size() && i < 1;'),
    }),
  },
];

describe.each(examples)('support.js loader of $name', (example) => {
  const modulePath = join(example.dir, 'plugins', 'support.js');
  const stubPackage = { definePlugin: 'pkg', runProcess: 'pkg', z: 'pkg' };
  const notFound = (message: string, code = 'ERR_MODULE_NOT_FOUND'): Error => Object.assign(new Error(message), { code });
  const load = async (): Promise<{ loadFramework(sources: () => Promise<unknown>, pkg: () => Promise<unknown>): Promise<unknown> }> =>
    (await import(modulePath)) as never;

  it('uses the repository sources when they exist', async () => {
    const { loadFramework } = await load();
    const sources = { definePlugin: 'src' };
    expect(await loadFramework(async () => sources, async () => stubPackage)).toBe(sources);
  });

  it('falls back to the package only when src/index.ts itself is missing', async () => {
    const { loadFramework } = await load();
    const missing = notFound("Cannot find module '/somewhere/src/index.ts' imported from /somewhere/examples/x/plugins/support.js");
    expect(await loadFramework(() => Promise.reject(missing), async () => stubPackage)).toBe(stubPackage);
  });

  it.each([
    ['a syntax error inside src/', new SyntaxError('Unexpected token')],
    ['a missing dependency of src/', notFound("Cannot find package 'zod' imported from /repo/src/core/scenario.ts")],
    ['another missing file of src/', notFound("Cannot find module '/repo/src/core/app.ts' imported from /repo/src/index.ts")],
    ['an unrelated error code', Object.assign(new Error("Cannot read src/index.ts"), { code: 'EACCES' })],
  ])('rethrows %s without touching the package', async (_label, error) => {
    const { loadFramework } = await load();
    let packageImports = 0;
    const pkg = async (): Promise<unknown> => {
      packageImports++;
      return stubPackage;
    };
    await expect(loadFramework(() => Promise.reject(error), pkg)).rejects.toBe(error);
    expect(packageImports).toBe(0);
  });
});

describe.each(examples)('legacy example $name', (example) => {
  const solutionDir = join(example.dir, 'solution');

  it('passes `check` without any issue and keeps the group points at max_points', async () => {
    const report = await createGrader({ assignmentDir: example.dir }).inspect();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.locale).toBe('sk');
    expect(report.scenarios.length).toBeGreaterThan(25);
  });

  it('lists its plugin-provided steps in `describe --json`', async () => {
    const { stdout } = await run('node', [cli, 'describe', example.dir, '--json']);
    const entries = JSON.parse(stdout) as DescribeEntry[];
    for (const step of example.steps) {
      const entry = entries.find((e) => e.kind === 'step' && e.name === step);
      expect(entry).toBeDefined();
      expect(entry?.description).toEqual(expect.any(String));
      expect(entry?.example).toContain(`- ${step}:`);
      expect(entry?.params).toMatchObject({ type: 'object' });
    }
    // the built-in steps are still there; a plain `describe` (without the directory) does not know the plugin steps
    expect(entries.some((e) => e.kind === 'step' && e.name === 'run')).toBe(true);
    const { stdout: plain } = await run('node', [cli, 'describe', '--json']);
    const names = (JSON.parse(plain) as DescribeEntry[]).map((e) => e.name);
    for (const step of example.steps) expect(names).not.toContain(step);
  });

  describe('graded together', () => {
    let root: string;
    let out: string;
    const byId = new Map<string, SubmissionResult>();
    const variantNames: string[] = [];

    beforeAll(async () => {
      if (!hasGpp) return;
      root = await mkdtemp(join(tmpdir(), `tui-grade-${example.name}-`));
      const input = join(root, 'input');
      out = join(root, 'out');
      await mkdir(input);
      await cp(solutionDir, join(input, 'solution'), { recursive: true });
      const solution = await readFile(join(solutionDir, 'src', 'main.cpp'), 'utf8');
      for (const [name, source] of Object.entries(example.variants(solution))) {
        variantNames.push(name);
        await mkdir(join(input, name, 'src'), { recursive: true });
        await writeFile(join(input, name, 'src', 'main.cpp'), source);
      }
      const { results } = await createGrader({ assignmentDir: example.dir }).run({ inputPath: input, outDir: out });
      for (const r of results) byId.set(r.student.id, r);
    }, 240_000);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    const result = (id: string): SubmissionResult => {
      const r = byId.get(id);
      if (r === undefined) throw new Error(`no result for ${id}`);
      return r;
    };

    runIf('the reference solution compiles cleanly and scores all 16 automatic points', () => {
      const r = result('solution');
      expect(r.build.ok).toBe(true);
      expect(r.build.warnings).toBe(0);
      expect(failedIds(r)).toEqual([]);
      expect(r.score.automaticPoints).toBe(16);
      expect(r.score.points).toBe(16);
      expect(r.score.max).toBe(20);
      expect(group(r, 'quality')).toMatchObject({ pending: true, manual: true, max: 4, points: 0 });
      const automatic = r.score.groups.filter((g) => !g.manual);
      expect(automatic.reduce((sum, g) => sum + g.points, 0)).toBeCloseTo(16, 9);
    });

    runIf('the setup steps of the user plugins leave no trace in the checked runs', () => {
      const ids = result('solution').scenarios.map((s) => s.id);
      expect(ids.length).toBeGreaterThan(25);
      const steps = result('solution').scenarios.flatMap((s) => s.steps.map((step) => step.name));
      for (const step of example.steps) expect(steps).toContain(step);
    });

    if (example.name === 'sentinel') {
      runIf('a queue that ignores the answer y fails exactly the scenarios that resolve an incident', () => {
        expect(failedIds(result('no-pop'))).toEqual(['q-fix-fifo', 'q-fix-invalid-answer', 'q-fix-yes-Y', 'q-fix-yes-y']);
        expect(group(result('no-pop'), 'devices').points).toBeCloseTo(5, 9);
        expect(group(result('no-pop'), 'queue').points).toBeLessThan(4); // the total is rounded up, so only the group shows it
      });

      runIf('a duplicate IP address that is accepted fails only the duplicate scenario', () => {
        expect(failedIds(result('dup-ip'))).toEqual(['dev-new-duplicate-ip']);
        expect(group(result('dup-ip'), 'incidents').points).toBeCloseTo(5, 9);
      });

      runIf('an invalid answer that is not followed by the question again fails only the invalid-answer scenario', () => {
        expect(failedIds(result('invalid-exits'))).toEqual(['q-fix-invalid-answer']); // the valid answer is never read
        expect(failedIds(result('prompt-once'))).toEqual(['q-fix-invalid-answer']); // the question is not asked again
      });

      runIf('another spelling of the question (A/N) is accepted', () => {
        expect(failedIds(result('alt-prompt'))).toEqual([]);
      });

      runIf('a failing setup step is reported clearly and does not fail the batch', () => {
        const r = result('new-broken');
        expect(r.build.ok).toBe(true);
        const scenario = r.scenarios.find((s) => s.id === 'q-count-three');
        expect(scenario?.status).toBe('error');
        expect(scenario?.error).toContain("insert_device: 'sentinel new --name PC --ip 192.168.10.1' exited with code 1");
        expect(scenario?.error).toContain('invalid IP address');
        // static scenarios do not depend on the setup
        expect(r.scenarios.find((s) => s.id === 'build-structure')?.status).toBe('passed');
        expect(group(r, 'queue').points).toBeLessThan(group(result('solution'), 'queue').points);
      });
    } else {
      runIf('a file that is indexed twice is counted twice: only the "indexed twice" scenario fails', () => {
        expect(failedIds(result('reindex-doubles'))).toEqual(['idx-twice']);
        expect(group(result('reindex-doubles'), 'search').points).toBeCloseTo(4, 9);
      });

      runIf('a search without the total fails only the scenario with several files', () => {
        expect(failedIds(result('no-total'))).toEqual(['search-multiple-files']);
        expect(group(result('no-total'), 'stats').points).toBeCloseTo(3, 9);
      });

      runIf('a top list of one word fails only the ranking scenario', () => {
        expect(failedIds(result('top-one'))).toEqual(['stats-top-words']);
        expect(group(result('top-one'), 'index').points).toBeCloseTo(5, 9);
      });
    }

    runIf('grades the solution and every variant exactly once', () => {
      expect([...byId.keys()].sort()).toEqual(['solution', ...variantNames].sort());
    });
  });
});
