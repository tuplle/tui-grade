// Acceptance suite: the example assignment `examples/mission` against the reference solution and a set of
// deliberately broken submissions, through the programmatic API (what the CLI wraps).
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { SubmissionResult } from '../../src/index.ts';
import { createGrader } from '../../src/index.ts';
import { makeZip, type ZipEntrySpec } from '../helpers/zip.ts';
import { hasTool, itIf } from '../helpers/tmp.ts';

const example = fileURLToPath(new URL('../../examples/mission', import.meta.url));
const solutionDir = join(example, 'solution');
const fixture = (name: string): string => join(example, 'submissions-fixtures', name);

const hasGcc = hasTool('gcc');
const runIf = itIf(hasGcc);

/** Every regular file below `dir` as ZIP entries named `<prefix><relative path>`. */
async function zipEntries(dir: string, prefix: string): Promise<ZipEntrySpec[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  return Promise.all(
    files.map(async (e) => {
      const full = join(e.parentPath, e.name);
      return { name: `${prefix}${full.slice(dir.length + 1)}`, content: await readFile(full) };
    }),
  );
}

const failedIds = (r: SubmissionResult): string[] => r.scenarios.filter((s) => s.status !== 'passed').map((s) => s.id);
const group = (r: SubmissionResult, id: string) => {
  const found = r.score.groups.find((g) => g.id === id);
  if (found === undefined) throw new Error(`no group ${id}`);
  return found;
};

describe('mission example assignment', () => {
  it('passes `check` without any issue', async () => {
    const report = await createGrader({ assignmentDir: example }).inspect();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.locale).toBe('sk');
    expect(new Set(report.scenarios.map((s) => s.group))).toEqual(
      new Set(['build', 'args', 'simulation', 'interactive', 'statistics']),
    );
  });

  describe('graded together', () => {
    let root: string;
    let out: string;
    const byId = new Map<string, SubmissionResult>();

    beforeAll(async () => {
      if (!hasGcc) return;
      root = await mkdtemp(join(tmpdir(), 'tui-grade-mission-'));
      const input = join(root, 'input');
      out = join(root, 'out');
      await mkdir(input);

      await cp(solutionDir, join(input, 'solution'), { recursive: true });
      for (const name of ['no-compile', 'no-help', 'wrong-storm', 'hangs']) {
        await cp(fixture(name), join(input, name), { recursive: true });
      }
      // The whole project one folder deeper, as students zip it from the parent directory.
      await writeFile(
        join(input, 'Novak_Jan_xnovak_project1.zip'),
        await makeZip(await zipEntries(solutionDir, 'proj/')),
      );
      await writeFile(
        join(input, 'Kral_Peter_pkral_project1.zip'),
        await makeZip(await zipEntries(fixture('no-marker'), '')),
      );

      const { results } = await createGrader({ assignmentDir: example }).run({ inputPath: input, outDir: out });
      for (const r of results) byId.set(r.student.id, r);
    }, 180_000);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    const result = (id: string): SubmissionResult => {
      const r = byId.get(id);
      if (r === undefined) throw new Error(`no result for ${id}`);
      return r;
    };

    runIf('grades every submission once', () => {
      expect([...byId.keys()].sort()).toEqual(['hangs', 'no-compile', 'no-help', 'pkral', 'solution', 'wrong-storm', 'xnovak']);
    });

    runIf('the solution scores all 16 automatic points and awaits the manual 4', async () => {
      const r = result('solution');
      expect(r.build.ok).toBe(true);
      expect(r.build.warnings).toBe(0);
      expect(failedIds(r)).toEqual([]);
      const ids = r.scenarios.map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining(['args-accept-max-crew-days', 'args-accept-max-supplies', 'sim-storm-random-last', 'sim-storm-random-first']));
      expect(r.score.automaticPoints).toBe(16);
      expect(r.score.points).toBe(16);
      expect(r.score.max).toBe(20);
      expect(group(r, 'quality')).toMatchObject({ pending: true, manual: true, max: 4, points: 0 });
      for (const [id, max] of [['build', 2], ['args', 3], ['simulation', 5], ['interactive', 3], ['statistics', 3]] as const) {
        expect(group(r, id).points).toBeCloseTo(max, 9);
      }
      const report = await readFile(join(out, 'solution', 'report.md'), 'utf8');
      expect(report).toContain('16 / 20');
      expect(report).toContain('čaká na ručné hodnotenie');
    });

    runIf('hidden checks do not reveal their expected values in results.json', async () => {
      const raw = await readFile(join(out, 'solution', 'results.json'), 'utf8');
      const json = JSON.parse(raw) as { scenarios: Array<{ id: string; checks: Array<{ hidden: boolean; expected?: string; actual?: string }> }> };
      const hidden = json.scenarios.flatMap((s) => s.checks).filter((c) => c.hidden);
      expect(hidden.length).toBeGreaterThan(0);
      for (const c of hidden) expect(c).not.toHaveProperty('expected');
    });

    runIf('a program that does not compile keeps the structure points only', async () => {
      const r = result('no-compile');
      expect(r.build.ok).toBe(false);
      expect(r.build.message).toBe('build_failed');
      expect(r.build.log).toContain('main.c');
      const build = group(r, 'build');
      expect(build.points).toBeGreaterThan(0);
      expect(build.points).toBeLessThan(build.max);
      expect(r.scenarios.find((s) => s.id === 'build-structure')?.status).toBe('passed');
      for (const id of ['args', 'simulation', 'interactive', 'statistics']) {
        expect(group(r, id)).toMatchObject({ requiresBuild: true, points: 0 });
      }
      expect(r.score.points).toBe(Math.ceil(build.points));
      const report = await readFile(join(out, 'no-compile', 'report.md'), 'utf8');
      expect(report).toContain('neúspešné');
    });

    runIf('a program without help fails only the help scenario', () => {
      const r = result('no-help');
      expect(failedIds(r)).toEqual(['args-help']);
      expect(group(r, 'args').points).toBeLessThan(3);
      expect(group(r, 'simulation').points).toBeCloseTo(5, 9);
    });

    runIf('a storm that does not double the oxygen fails only storm scenarios', () => {
      const r = result('wrong-storm');
      const failed = failedIds(r);
      expect(failed).toEqual(expect.arrayContaining(['sim-storm-day-1', 'sim-storm-day-2', 'sim-storm-day-3', 'sim-storm-fail']));
      for (const id of failed) expect(id).toMatch(/storm/);
      expect(group(r, 'args').points).toBeCloseTo(3, 9);
      expect(group(r, 'interactive').points).toBeCloseTo(3, 9);
      expect(r.scenarios.find((s) => s.id === 'sim-basic')?.status).toBe('passed');
    });

    runIf('a program that hangs fails only the scenarios that trigger it, within the time limit', () => {
      const r = result('hangs');
      expect(failedIds(r).sort()).toEqual(['sim-long', 'stat-fail-food']);
      for (const id of ['sim-long', 'stat-fail-food']) {
        const scenario = r.scenarios.find((s) => s.id === id);
        expect(scenario?.status).toBe('failed'); // a timeout fails the checks; it is no executor error
        expect(scenario?.durationMs).toBeGreaterThanOrEqual(4500);
        expect(scenario?.durationMs).toBeLessThan(15_000);
      }
      expect(r.durationMs).toBeLessThan(40_000);
      expect(r.score.automaticPoints).toBeGreaterThan(13);
      expect(r.score.automaticPoints).toBeLessThan(16);
    });

    runIf('a ZIP with an extra root folder scores like the solution and takes the login as id', () => {
      const r = result('xnovak');
      expect(r.student).toMatchObject({ id: 'xnovak', displayName: 'Novak Jan', parts: { surname: 'Novak', name: 'Jan', login: 'xnovak' } });
      expect(r.source.kind).toBe('zip');
      expect(r.structure.rootFound).toBe(true);
      expect(r.warnings).toEqual([]);
      expect(failedIds(r)).toEqual([]);
      expect(r.score.automaticPoints).toBe(result('solution').score.automaticPoints);
      expect(r.score.points).toBe(16);
    });

    runIf('a project without src/main.c is reported as project_root_not_found', async () => {
      const r = result('pkral');
      expect(r.structure.rootFound).toBe(false);
      expect(r.build).toMatchObject({ ok: false, message: 'project_root_not_found' });
      expect(r.score.points).toBe(0);
      const report = await readFile(join(out, 'pkral', 'report.md'), 'utf8');
      expect(report).toContain('Koreň projektu sa nenašiel');
    });

    runIf('summary.csv has one row per submission', async () => {
      const lines = (await readFile(join(out, 'summary.csv'), 'utf8')).trim().split('\n');
      expect(lines[0]).toBe('student;points;max;build;args;simulation;interactive;statistics;quality');
      const rows = lines.slice(1).map((l) => l.split(';'));
      expect(rows.map((r) => r[0])).toEqual(['hangs', 'no-compile', 'no-help', 'pkral', 'solution', 'wrong-storm', 'xnovak']);
      expect(rows.find((r) => r[0] === 'solution')?.slice(1, 3)).toEqual(['16', '20']);
      expect(rows.find((r) => r[0] === 'solution')?.[8]).toBe(''); // quality is pending
    });

    runIf('report.md is in Slovak', async () => {
      const report = await readFile(join(out, 'solution', 'report.md'), 'utf8');
      expect(report.startsWith('# Správa o hodnotení: mission')).toBe(true);
      expect(report).toContain('**Študent:** solution');
      expect(report).toContain('| Skupina | Body |');
      expect(report).toContain('Spracovanie argumentov, --help a validácia');
      expect(report).not.toMatch(/Grading report|Student:/);
    });

    runIf('the student archive unpacks to results.json and report.md', async () => {
      const zip = await JSZip.loadAsync(await readFile(join(out, 'solution', 'solution-results.zip')));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir);
      expect(names).toEqual(expect.arrayContaining(['results.json', 'report.md']));
      expect(names.some((n) => n.startsWith('screens/int-session-continue'))).toBe(true);
      const json = JSON.parse((await zip.file('results.json')?.async('string')) ?? '{}') as { score: { points: number } };
      expect(json.score.points).toBe(16);
    });
  });
});
