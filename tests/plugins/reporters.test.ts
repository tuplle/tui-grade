import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { App } from '../../src/core/app.ts';
import type { AssignmentConfig, CheckResult, ReporterContext, ReporterDef, ScenarioResult, SubmissionResult } from '../../src/core/contracts.ts';
import { createTranslate } from '../../src/core/i18n.ts';
import { gradeAll } from '../../src/core/lifecycle.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { formatNumber, publicResult } from '../../src/plugins/reporter-shared.ts';
import { withTempDir } from '../helpers/tmp.ts';

const check = (over: Partial<CheckResult> = {}): CheckResult => ({ name: 'stdout_contains', description: 'stdout contains "ok"', pass: true, weight: 1, hidden: false, ...over });

const scenario = (id: string, over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  id,
  title: { en: `Title ${id}`, sk: `Nazov ${id}` },
  weight: 1,
  status: 'passed',
  steps: [],
  checks: [check()],
  durationMs: 5,
  artifacts: [],
  ...over,
});

function result(id: string, over: Partial<SubmissionResult> = {}): SubmissionResult {
  return {
    schemaVersion: 1,
    assignment: 'Demo',
    locale: 'en',
    student: { id, displayName: id, parts: {} },
    source: { path: `/in/${id}`, kind: 'dir', root: `/in/${id}` },
    startedAt: '2026-11-17T10:00:00.000Z',
    durationMs: 1234,
    structure: { rootFound: true },
    build: { ok: true, exitCode: 0, timedOut: false, warnings: 0, durationMs: 10, log: 'compiling\n' },
    scenarios: [scenario('1-1', { group: 'beh' })],
    score: {
      points: 8,
      max: 10,
      automaticPoints: 8,
      groups: [
        { id: 'beh', title: { en: 'Behaviour', sk: 'Správanie' }, max: 8, points: 8, manual: false, pending: false, requiresBuild: false, scenarios: [{ id: '1-1', points: 8, max: 8 }] },
        { id: 'review', title: { en: 'Review', sk: 'Revízia' }, max: 2, points: 0, manual: true, pending: true, requiresBuild: false, scenarios: [] },
      ],
      ungrouped: [],
      rounding: 'none',
    },
    warnings: [],
    ...over,
  };
}

const config = { name: 'Demo', locale: 'en', groups: [{ id: 'beh', title: 'Behaviour', points: 8 }, { id: 'review', title: 'Review', points: 2, manual: true }] } as unknown as AssignmentConfig;

async function ctxFor(outDir: string, locale = 'en', assignment: AssignmentConfig = config): Promise<{ ctx: ReporterContext; reporter: (name: string) => ReporterDef }> {
  const app = new App();
  await app.register(defaultPreset);
  const reporter = (name: string): ReporterDef => {
    const def = app.lookup('reporter', name);
    if (def === undefined) throw new Error(`no reporter ${name}`);
    return def;
  };
  return { ctx: { app, locale, t: createTranslate(locale), outDir, assignment }, reporter };
}

const readJson = async (path: string): Promise<SubmissionResult> => JSON.parse(await readFile(path, 'utf8')) as SubmissionResult;

describe('shared helpers', () => {
  it('formats numbers with up to two decimals and no trailing zeros', () => {
    expect([16, 2.5, 13.333333, 0.005, 0, 1.999].map(formatNumber)).toEqual(['16', '2.5', '13.33', '0.01', '0', '2']);
  });

  it('publicResult strips hidden details and screens without mutating the input', () => {
    const input = result('a', {
      scenarios: [
        scenario('s', {
          screens: { main: 'SECRET SCREEN' },
          artifacts: ['screens/s-main.txt'],
          checks: [
            check({ pass: false, expected: 'e', actual: 'a', message: 'm' }),
            check({ name: 'file_exists', description: 'File secret.txt exists', hidden: true, pass: false, expected: 'HIDDEN-E', actual: 'HIDDEN-A', message: 'HIDDEN-M' }),
          ],
        }),
      ],
    });
    const snapshot = structuredClone(input);
    for (const locale of ['en', 'sk']) {
      const t = createTranslate(locale);
      const out = publicResult(input, t);
      expect(input).toEqual(snapshot);
      const s = out.scenarios[0] as ScenarioResult;
      expect('screens' in s).toBe(false);
      expect(s.artifacts).toEqual(['screens/s-main.txt']);
      expect(s.checks[0]).toMatchObject({ description: 'stdout contains "ok"', expected: 'e', actual: 'a', message: 'm' });
      expect(s.checks[1]).toEqual({ name: 'file_exists', description: t('report.check.hidden'), pass: false, weight: 1, hidden: true });
      expect(t('report.check.hidden')).not.toBe('report.check.hidden');
    }
    expect(createTranslate('en')('report.check.hidden')).not.toBe(createTranslate('sk')('report.check.hidden'));
  });
});

describe('publicResult paths and logs', () => {
  it('reduces source to the base name without a root, and drops inline run logs', () => {
    const input = result('a', {
      source: { path: '/home/teacher/submissions/a.zip', kind: 'zip', root: '/tmp/tui-grade-sub-x/proj' },
      scenarios: [scenario('s', { logs: { 'run-1': { stdout: 'S', stderr: '', exitCode: 0, timedOut: false } }, artifacts: ['logs/s-run-1.txt'] })],
    });
    const out = publicResult(input, createTranslate('en'));
    expect(out.source).toEqual({ path: 'a.zip', kind: 'zip', root: null });
    expect('logs' in (out.scenarios[0] as ScenarioResult)).toBe(false);
    expect(out.scenarios[0]?.artifacts).toEqual(['logs/s-run-1.txt']);
    expect(input.source.root).toBe('/tmp/tui-grade-sub-x/proj'); // the input is not modified
    expect(JSON.stringify(out)).not.toContain('/home/teacher');
  });
});

describe('json reporter', () => {
  it('writes valid results.json with schemaVersion 1 and no hidden details', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out);
      const r = result('alice', {
        scenarios: [scenario('s', { screens: { main: 'SCREEN' }, checks: [check({ description: 'HDESC', hidden: true, pass: false, expected: 'HX', actual: 'HY', message: 'HM' })] })],
      });
      await reporter('json').reportSubmission?.(ctx, r, {});
      const raw = await readFile(join(out, 'alice', 'results.json'), 'utf8');
      const parsed = JSON.parse(raw) as SubmissionResult;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.student.id).toBe('alice');
      expect(parsed.score.points).toBe(8);
      for (const secret of ['HDESC', 'HX', 'HY', 'HM', 'SCREEN']) expect(raw).not.toContain(secret);
      expect(parsed.scenarios[0]?.checks[0]).toMatchObject({ hidden: true, pass: false });
    });
  });
});

describe('markdown reporter', () => {
  it('renders an English report with pending manual groups', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      await reporter('markdown').reportSubmission?.(ctx, result('alice'), {});
      const md = await readFile(join(out, 'alice', 'report.md'), 'utf8');
      expect(md).toContain('# Grading report: Demo');
      expect(md).toContain('alice');
      expect(md).toContain('8 / 10');
      expect(md).toContain('Behaviour');
      expect(md).toContain('pending manual grading');
      expect(md).toContain('Title 1-1');
      expect(md).toContain('stdout contains "ok"');
      expect(md).toContain('2026-11-17');
    });
  });

  it('renders a Slovak report', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'sk');
      await reporter('markdown').reportSubmission?.(ctx, result('alice', { locale: 'sk' }), {});
      const md = await readFile(join(out, 'alice', 'report.md'), 'utf8');
      expect(md).toContain('Správa o hodnotení: Demo');
      expect(md).toContain('Body');
      expect(md).toContain('Správanie');
      expect(md).toContain('čaká na ručné hodnotenie');
      expect(md).toContain('Nazov 1-1');
      expect(md).toContain('Zostavenie programu');
      expect(md).toContain('prešlo');
    });
  });

  it('shows the build log excerpt and the translated message when the build failed', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const log = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}\nerror: boom\n`;
      const r = result('bob', { build: { ok: false, message: 'build_failed', exitCode: 2, timedOut: false, warnings: 0, durationMs: 1, log } });
      await reporter('markdown').reportSubmission?.(ctx, r, {});
      const md = await readFile(join(out, 'bob', 'report.md'), 'utf8');
      expect(md).toContain('error: boom');
      expect(md).toContain('line 199');
      expect(md).not.toContain('line 0\n');
      expect(md).toContain('The build failed.');
      expect(md).toContain('build.log');
    });
  });

  it('prints unknown build messages as-is and uses a fence longer than the log content', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const r = result('bob', { build: { ok: false, message: "cannot start 'gcc': ENOENT", exitCode: null, timedOut: false, warnings: 0, durationMs: 1, log: 'x\n```\ny\n' } });
      await reporter('markdown').reportSubmission?.(ctx, r, {});
      const md = await readFile(join(out, 'bob', 'report.md'), 'utf8');
      expect(md).toContain("cannot start 'gcc': ENOENT");
      expect(md).toContain('````');
    });
  });

  it('shows expected/actual for failed visible checks only and never hidden details or screens', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const r = result('alice', {
        scenarios: [
          scenario('s', {
            status: 'failed',
            screens: { main: 'SECRET SCREEN' },
            checks: [
              check({ pass: false, expected: 'EXPECTED-VISIBLE', actual: 'ACTUAL-VISIBLE' }),
              check({ description: 'hidden thing', hidden: true, pass: false, expected: 'HX', actual: 'HY', message: 'HM' }),
              check({ description: 'passing', pass: true, expected: 'PX' }),
            ],
          }),
        ],
      });
      await reporter('markdown').reportSubmission?.(ctx, r, {});
      const md = await readFile(join(out, 'alice', 'report.md'), 'utf8');
      expect(md).toContain('EXPECTED-VISIBLE');
      expect(md).toContain('ACTUAL-VISIBLE');
      expect(md).toContain('Hidden check');
      for (const secret of ['hidden thing', 'HX', 'HY', 'HM', 'SECRET SCREEN', 'PX']) expect(md).not.toContain(secret);
    });
  });

  it('warns about ungrouped scenarios only when groups exist, and lists result warnings', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const grouped = result('g', { warnings: ['intake said hi'] });
      grouped.score.ungrouped = [{ id: 'orphan', points: 0, max: 0 }];
      await reporter('markdown').reportSubmission?.(ctx, grouped, {});
      const md = await readFile(join(out, 'g', 'report.md'), 'utf8');
      expect(md).toContain('orphan');
      expect(md).toContain('intake said hi');

      const flat = result('f');
      flat.score = { points: 5, max: 10, automaticPoints: 5, groups: [], ungrouped: [{ id: '1-1', points: 5, max: 10 }], rounding: 'none' };
      await reporter('markdown').reportSubmission?.(ctx, flat, {});
      const flatMd = await readFile(join(out, 'f', 'report.md'), 'utf8');
      expect(flatMd).toContain('5 / 10');
      expect(flatMd).not.toContain('Scenarios not assigned');
    });
  });

  it('escapes pipes in table cells', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const r = result('a');
      (r.score.groups[0] as { title: string }).title = 'A | B';
      await reporter('markdown').reportSubmission?.(ctx, r, {});
      expect(await readFile(join(out, 'a', 'report.md'), 'utf8')).toContain('A \\| B');
    });
  });
});

describe('zip reporter', () => {
  it('packs the student directory (without the zip itself) preserving paths', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const dir = join(out, 'alice');
      await mkdir(join(dir, 'screens'), { recursive: true });
      await writeFile(join(dir, 'build.log'), 'compiling');
      await writeFile(join(dir, 'screens', 's-main.txt'), 'SCREEN');
      await reporter('json').reportSubmission?.(ctx, result('alice'), {});
      await reporter('markdown').reportSubmission?.(ctx, result('alice'), {});
      await reporter('zip').reportSubmission?.(ctx, result('alice'), {});
      await reporter('zip').reportSubmission?.(ctx, result('alice'), {}); // a second run must not pack the first zip
      const zip = await JSZip.loadAsync(await readFile(join(dir, 'alice-results.zip')));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir).sort();
      expect(names).toEqual(['build.log', 'report.md', 'results.json', 'screens/s-main.txt']);
      expect(await zip.file('screens/s-main.txt')?.async('string')).toBe('SCREEN');
    });
  });

  it('skips the temp files an interrupted atomic write left behind', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out, 'en');
      const dir = join(out, 'alice');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.results.json.1234.abcd.tmp'), '{"trunc');
      await writeFile(join(dir, '.tmp-but-a-real-file'), 'kept'); // not the temp pattern
      await reporter('json').reportSubmission?.(ctx, result('alice'), {});
      await reporter('zip').reportSubmission?.(ctx, result('alice'), {});
      const zip = await JSZip.loadAsync(await readFile(join(dir, 'alice-results.zip')));
      expect(Object.keys(zip.files).filter((n) => !zip.files[n]?.dir).sort()).toEqual(['.tmp-but-a-real-file', 'results.json']);
    });
  });
});

describe('csv reporter', () => {
  it('writes one row per student sorted by id with one column per group', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out);
      const a = result('zed');
      const b = result('al;ice "x"');
      b.score.points = 2.5;
      b.score.groups[0] = { ...(b.score.groups[0] as SubmissionResult['score']['groups'][number]), points: 13.333333 };
      await reporter('csv').reportRun?.(ctx, [a, b], {});
      const lines = (await readFile(join(out, 'summary.csv'), 'utf8')).trimEnd().split('\n');
      expect(lines).toEqual(['student;points;max;beh;review', '"al;ice ""x""";2.5;10;13.33;', 'zed;8;10;8;']);
    });
  });

  it('uses scenario ids as columns when there are no groups', async () => {
    await withTempDir(async (out) => {
      const assignment = { ...config, groups: undefined } as unknown as AssignmentConfig;
      const { ctx, reporter } = await ctxFor(out, 'en', assignment);
      const mk = (id: string, ungrouped: Array<{ id: string; points: number; max: number }>): SubmissionResult => {
        const r = result(id);
        r.score = { points: 3, max: 10, automaticPoints: 3, groups: [], ungrouped, rounding: 'none' };
        return r;
      };
      await reporter('csv').reportRun?.(ctx, [mk('b', [{ id: '1-1', points: 1, max: 5 }, { id: '1-2', points: 2, max: 5 }]), mk('a', [{ id: '1-1', points: 3, max: 5 }])], {});
      const lines = (await readFile(join(out, 'summary.csv'), 'utf8')).trimEnd().split('\n');
      expect(lines).toEqual(['student;points;max;1-1;1-2', 'a;3;10;3;', 'b;3;10;1;2']);
    });
  });

  it('neutralizes spreadsheet formulas in the student column', async () => {
    await withTempDir(async (out) => {
      const { ctx, reporter } = await ctxFor(out);
      await reporter('csv').reportRun?.(ctx, [result('=cmd()')], {});
      const text = await readFile(join(out, 'summary.csv'), 'utf8');
      expect(text.split('\n')[1]?.startsWith("'=cmd();")).toBe(true);
    });
  });
});

describe('integration through gradeAll', () => {
  const ASSIGNMENT = `name: Demo
max_points: 10
build:
  type: custom
  command: mkdir -p bin && cp src/prog.sh bin/prog && chmod +x bin/prog
binary: bin/prog
project_root_marker: src/prog.sh
limits: { run_timeout_sec: 2, build_timeout_sec: 20 }
locale: sk
groups:
  - { id: behaviour, title: { en: Behaviour, sk: Správanie }, points: 8 }
  - { id: review, title: Review, points: 2, manual: true }
`;
  const SCENARIOS = `- id: "1-1"
  title: T1
  group: behaviour
  steps:
    - run: { args: [] }
  expect:
    - stdout_contains: ok
    - stdout_contains: { text: nothere }
      hidden: true
`;

  it('registers the reporters in order and the zip contains results.json and report.md', async () => {
    const app = new App();
    await app.register(defaultPreset);
    expect(app.list('reporter').map((r) => r.name)).toEqual(['json', 'markdown', 'zip', 'csv']);
    for (const name of ['reporter-json', 'reporter-markdown', 'reporter-zip', 'reporter-csv']) {
      expect(builtinPlugins[name]).toMatchObject({ shared: true, meta: { name } });
    }

    await withTempDir(async (root) => {
      const assignment = join(root, 'assignment');
      await mkdir(join(assignment, 'scenarios'), { recursive: true });
      await writeFile(join(assignment, 'assignment.yaml'), ASSIGNMENT);
      await writeFile(join(assignment, 'scenarios', 's.yaml'), SCENARIOS);
      const input = join(root, 'input');
      await mkdir(join(input, 'alice', 'src'), { recursive: true });
      await writeFile(join(input, 'alice', 'src', 'prog.sh'), '#!/bin/sh\necho ok\n');
      const out = join(root, 'out');
      const { results } = await gradeAll({ assignmentDir: assignment, inputPath: input, outDir: out });

      expect(results[0]?.locale).toBe('sk');
      expect(results[0]?.warnings).toEqual([]);
      const files = (await readdir(join(out, 'alice'))).sort();
      expect(files).toEqual(['alice-results.zip', 'logs', 'report.md', 'results.full.json', 'results.json']); // the build prints nothing, so there is no build.log
      const zip = await JSZip.loadAsync(await readFile(join(out, 'alice', 'alice-results.zip')));
      const names = Object.keys(zip.files);
      expect(names).toEqual(expect.arrayContaining(['results.json', 'report.md']));
      expect(names).not.toContain('alice-results.zip');
      const md = await zip.file('report.md')?.async('string');
      expect(md).toContain('Správa o hodnotení: Demo');
      expect(md).toContain('čaká na ručné hodnotenie');
      expect(md).toContain('Štandardný výstup obsahuje „ok“');
      expect(await readFile(join(out, 'summary.csv'), 'utf8')).toBe('student;points;max;behaviour;review\nalice;4;10;4;\n');
      const json = await readJson(join(out, 'alice', 'results.json'));
      expect(json.scenarios[0]?.checks[1]).toMatchObject({ hidden: true, pass: false });
      expect(json.scenarios[0]?.checks[1]).not.toHaveProperty('expected');
    });
  });

  it('removes leftover atomic-write temp files of an earlier killed run from the student directory', async () => {
    await withTempDir(async (root) => {
      const assignment = join(root, 'assignment');
      await mkdir(join(assignment, 'scenarios'), { recursive: true });
      await writeFile(join(assignment, 'assignment.yaml'), ASSIGNMENT);
      await writeFile(join(assignment, 'scenarios', 's.yaml'), SCENARIOS);
      const input = join(root, 'input');
      await mkdir(join(input, 'alice', 'src'), { recursive: true });
      await writeFile(join(input, 'alice', 'src', 'prog.sh'), '#!/bin/sh\necho ok\n');
      const out = join(root, 'out');
      const stale = join(out, 'alice', '.results.json.1234.abcd.tmp');
      await mkdir(join(out, 'alice'), { recursive: true });
      await writeFile(stale, '{"trunc');
      await gradeAll({ assignmentDir: assignment, inputPath: input, outDir: out });
      expect(await readdir(join(out, 'alice'))).not.toContain('.results.json.1234.abcd.tmp');
      const zip = await JSZip.loadAsync(await readFile(join(out, 'alice', 'alice-results.zip')));
      expect(Object.keys(zip.files).some((n) => n.endsWith('.tmp'))).toBe(false);
    });
  });
  const LEAKY_SCENARIO = '- id: "1-2"\n  title: T2\n  group: behaviour\n  steps:\n    - run: { args: [] }\n  expect:\n    - script: { path: scripts/leak-IDENT-throw.mjs }\n      hidden: true\n';

  it.each(['en', 'sk'])('does not leak a hidden check through results.json, report.md or the zip (%s)', async (locale) => {
    await withTempDir(async (root) => {
      const assignment = join(root, 'assignment');
      await mkdir(join(assignment, 'scenarios'), { recursive: true });
      await mkdir(join(assignment, 'scripts'), { recursive: true });
      await writeFile(join(assignment, 'scripts', 'leak-IDENT-throw.mjs'), "export default () => { throw new Error('IDENT-thrown-secret'); };\n");
      await writeFile(join(assignment, 'assignment.yaml'), ASSIGNMENT.replace('locale: sk', `locale: ${locale}`));
      await writeFile(join(assignment, 'scenarios', 's.yaml'), `${SCENARIOS.replace('nothere', 'IDENT-nothere')}${LEAKY_SCENARIO}`);
      const input = join(root, 'input');
      await mkdir(join(input, 'alice', 'src'), { recursive: true });
      await writeFile(join(input, 'alice', 'src', 'prog.sh'), '#!/bin/sh\necho ok\n');
      const out = join(root, 'out');
      const { results } = await gradeAll({ assignmentDir: assignment, inputPath: input, outDir: out });
      expect(results[0]?.locale).toBe(locale);

      const hiddenLabel = createTranslate(locale)('report.check.hidden');
      const dir = join(out, 'alice');
      const json = await readFile(join(dir, 'results.json'), 'utf8');
      const md = await readFile(join(dir, 'report.md'), 'utf8');
      expect(md).toContain(hiddenLabel);
      expect(json).toContain(hiddenLabel);
      const texts = [json, md];
      const zip = await JSZip.loadAsync(await readFile(join(dir, 'alice-results.zip')));
      for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) texts.push(`${name}\n${await entry.async('string')}`);
      expect(texts.length).toBeGreaterThanOrEqual(4);
      for (const text of texts) expect(text).not.toMatch(/IDENT|nothere/);
    });
  });
  it.each([
    ['en', 'any_of'],
    ['en', 'all_of'],
    ['sk', 'any_of'],
    ['sk', 'all_of'],
  ])('does not leak a hidden child of a visible composite (%s, %s)', async (locale, composite) => {
    await withTempDir(async (root) => {
      const assignment = join(root, 'assignment');
      await mkdir(join(assignment, 'scenarios'), { recursive: true });
      await writeFile(join(assignment, 'assignment.yaml'), ASSIGNMENT.replace('locale: sk', `locale: ${locale}`));
      await writeFile(
        join(assignment, 'scenarios', 's.yaml'),
        `- id: "1-1"
  title: T1
  group: behaviour
  steps:
    - run: { args: [] }
  expect:
    - ${composite}:
        - stdout_contains: VISIBLE-sibling
        - stdout_contains: IDENT-hidden-child
          hidden: true
        - file_exists: IDENT-hidden-file.txt
          hidden: true
`,
      );
      const input = join(root, 'input');
      await mkdir(join(input, 'alice', 'src'), { recursive: true });
      await writeFile(join(input, 'alice', 'src', 'prog.sh'), '#!/bin/sh\necho ok\n');
      const out = join(root, 'out');
      await gradeAll({ assignmentDir: assignment, inputPath: input, outDir: out });

      const dir = join(out, 'alice');
      const json = await readFile(join(dir, 'results.json'), 'utf8');
      const md = await readFile(join(dir, 'report.md'), 'utf8');
      const texts = [json, md];
      const zip = await JSZip.loadAsync(await readFile(join(dir, 'alice-results.zip')));
      for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) texts.push(`${name}\n${await entry.async('string')}`);
      expect(texts.length).toBeGreaterThanOrEqual(4);
      for (const text of texts) expect(text).not.toMatch(/IDENT|hidden-child|hidden-file/);
      const parsed = JSON.parse(json) as SubmissionResult;
      const parent = parsed.scenarios[0]?.checks[0] as CheckResult;
      expect(parent.hidden).toBe(false);
      expect(parent.description).toContain('VISIBLE-sibling');
      expect(parent.description).toContain(createTranslate(locale)('report.check.hidden'));
      expect(md).toContain('VISIBLE-sibling');
    });
  });
});
