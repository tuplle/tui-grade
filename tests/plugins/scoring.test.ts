import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/core/app.ts';
import type { AssignmentConfig, CheckResult, ScenarioResult, ScoreInput, ScoreResult } from '../../src/core/contracts.ts';
import { loadManualPoints } from '../../src/core/manual.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { scoringProportional } from '../../src/plugins/scoring-proportional/index.ts';
import { withTempDir } from '../helpers/tmp.ts';

type Group = NonNullable<AssignmentConfig['groups']>[number];

const assignment = (over: Partial<AssignmentConfig> = {}): AssignmentConfig =>
  ({
    name: 'test',
    max_points: 20,
    locale: 'en',
    build: { type: 'gcc' },
    project_root_marker: 'src/main.c',
    project_root_depth: 2,
    scoring: { use: 'proportional', rounding: 'none', cap: true },
    plugins: [],
    preset: 'default',
    ...over,
  }) as AssignmentConfig;

const check = (pass: boolean, weight = 1): CheckResult => ({ name: 'c', description: 'c', pass, weight, hidden: false });

/** A scenario whose checks pass/fail as listed in `passes` (each weight 1). */
const scenario = (id: string, group: string | undefined, passes: boolean[], weight = 1): ScenarioResult => ({
  id,
  title: id,
  ...(group === undefined ? {} : { group }),
  weight,
  status: passes.every(Boolean) ? 'passed' : 'failed',
  steps: [],
  checks: passes.map((p) => check(p)),
  durationMs: 0,
  artifacts: [],
});

async function scorer() {
  const app = new App();
  await app.register(scoringProportional);
  return app.lookup('scorer', 'proportional')!;
}

async function score(input: ScoreInput, opts: unknown = {}): Promise<ScoreResult> {
  const def = await scorer();
  return def.score(input, def.params.parse(opts));
}

const missionGroups: Group[] = [
  { id: 'structure', title: 'Structure', points: 2 },
  { id: 'build', title: 'Build', points: 3, requires_build: true },
  { id: 'basic', title: 'Basic', points: 5, requires_build: true },
  { id: 'errors', title: 'Errors', points: 3, requires_build: true },
  { id: 'menu', title: 'Menu', points: 3, requires_build: true },
  { id: 'review', title: 'Review', points: 4, manual: true },
];
const missionScenarios = (): ScenarioResult[] => [
  scenario('s-structure', 'structure', [true, true]),
  scenario('s-build', 'build', [true]),
  scenario('s-basic', 'basic', [true, true]),
  scenario('s-errors', 'errors', [true]),
  scenario('s-menu', 'menu', [true]),
];

describe('scoring-proportional registration', () => {
  it('registers the scorer under "proportional" and is a builtin and part of the default preset', async () => {
    expect((await scorer()).description).toBeTruthy();
    expect(builtinPlugins['scoring-proportional']).toBe(scoringProportional);
    const app = new App();
    await app.register(defaultPreset);
    expect(app.lookup('scorer', 'proportional')).toBeDefined();
  });

  it('validates the option schema', async () => {
    const def = await scorer();
    expect(def.params.parse({})).toEqual({});
    expect(def.params.parse({ rounding: 'ceil', cap: false })).toEqual({ rounding: 'ceil', cap: false });
    expect(() => def.params.parse({ rounding: 'up' })).toThrow();
    expect(() => def.params.parse({ extra: 1 })).toThrow();
  });
});

describe('scoring-proportional with groups', () => {
  it('(a) mission-like groups, all passing: 16 automatic, manual group pending', async () => {
    const r = await score({ assignment: assignment({ groups: missionGroups }), buildOk: true, scenarios: missionScenarios() });
    expect(r.points).toBe(16);
    expect(r.automaticPoints).toBe(16);
    expect(r.max).toBe(20);
    expect(r.groups.map((g) => g.points)).toEqual([2, 3, 5, 3, 3, 0]);
    const review = r.groups.find((g) => g.id === 'review')!;
    expect(review).toMatchObject({ manual: true, pending: true, max: 4, points: 0 });
    expect(r.groups.find((g) => g.id === 'basic')).toMatchObject({ manual: false, pending: false, requiresBuild: true });
    expect(r.ungrouped).toEqual([]);
  });

  it('(b) half of the checks of a 5-point group pass → 2.5', async () => {
    const scenarios = missionScenarios();
    scenarios[2] = scenario('s-basic', 'basic', [true, false]);
    const r = await score({ assignment: assignment({ groups: missionGroups }), buildOk: true, scenarios });
    expect(r.groups.find((g) => g.id === 'basic')!.points).toBe(2.5);
    expect(r.groups.find((g) => g.id === 'basic')!.scenarios).toEqual([{ id: 's-basic', points: 2.5, max: 5 }]);
    expect(r.points).toBe(13.5);
  });

  it('(c) requires_build groups score 0 on a failed build, other groups keep their points', async () => {
    const r = await score({ assignment: assignment({ groups: missionGroups }), buildOk: false, scenarios: missionScenarios() });
    expect(r.groups.find((g) => g.id === 'structure')!.points).toBe(2);
    for (const id of ['build', 'basic', 'errors', 'menu']) expect(r.groups.find((g) => g.id === id)!.points).toBe(0);
    expect(r.groups.find((g) => g.id === 'basic')!.scenarios).toEqual([{ id: 's-basic', points: 0, max: 5 }]);
    expect(r.points).toBe(2);
    expect(r.automaticPoints).toBe(2);
  });

  it('(d) manual points: supplied value clears pending and counts toward the total, clamped to the group max', async () => {
    const input = { assignment: assignment({ groups: missionGroups }), buildOk: true, scenarios: missionScenarios() };
    const supplied = await score({ ...input, manual: { review: 3 } });
    expect(supplied.groups.find((g) => g.id === 'review')).toMatchObject({ points: 3, pending: false, manual: true });
    expect(supplied.points).toBe(19);
    expect(supplied.automaticPoints).toBe(16);

    const clamped = await score({ ...input, manual: { review: 99 } });
    expect(clamped.groups.find((g) => g.id === 'review')!.points).toBe(4);
    expect(clamped.points).toBe(20);

    const negative = await score({ ...input, manual: { review: -5 } });
    expect(negative.groups.find((g) => g.id === 'review')).toMatchObject({ points: 0, pending: false });
  });

  it('ignores manual values for groups that are not manual', async () => {
    const r = await score({
      assignment: assignment({ groups: missionGroups }),
      buildOk: true,
      scenarios: missionScenarios(),
      manual: { basic: 0 },
    });
    expect(r.groups.find((g) => g.id === 'basic')!.points).toBe(5);
  });

  it('(g) scenario weights 2:1 shift the group points', async () => {
    const groups: Group[] = [{ id: 'g', title: 'G', points: 9 }];
    const scenarios = [scenario('heavy', 'g', [true], 2), scenario('light', 'g', [false], 1)];
    const r = await score({ assignment: assignment({ groups, max_points: 9 }), buildOk: true, scenarios });
    expect(r.groups[0]!.points).toBe(6);
    expect(r.groups[0]!.scenarios).toEqual([
      { id: 'heavy', points: 6, max: 6 },
      { id: 'light', points: 0, max: 3 },
    ]);

    const flipped = [scenario('heavy', 'g', [false], 2), scenario('light', 'g', [true], 1)];
    const r2 = await score({ assignment: assignment({ groups, max_points: 9 }), buildOk: true, scenarios: flipped });
    expect(r2.groups[0]!.points).toBe(3);
  });

  it('uses check weights for the per-scenario ratio', async () => {
    const groups: Group[] = [{ id: 'g', title: 'G', points: 4 }];
    const s: ScenarioResult = { ...scenario('s', 'g', []), checks: [check(true, 3), check(false, 1)] };
    const r = await score({ assignment: assignment({ groups, max_points: 4 }), buildOk: true, scenarios: [s] });
    expect(r.groups[0]!.points).toBe(3);
  });

  it('(h) a scenario with zero checks scores 0, never NaN (also when a step threw)', async () => {
    const groups: Group[] = [{ id: 'g', title: 'G', points: 4 }];
    const broken: ScenarioResult = { ...scenario('broken', 'g', []), status: 'error', error: 'step failed' };
    const r = await score({
      assignment: assignment({ groups, max_points: 4 }),
      buildOk: true,
      scenarios: [broken, scenario('ok', 'g', [true])],
    });
    expect(r.groups[0]!.scenarios).toEqual([
      { id: 'broken', points: 0, max: 2 },
      { id: 'ok', points: 2, max: 2 },
    ]);
    expect(r.points).toBe(2);
    expect(Number.isNaN(r.points)).toBe(false);

    const only = await score({ assignment: assignment({ groups, max_points: 4 }), buildOk: true, scenarios: [broken] });
    expect(only.points).toBe(0);
  });

  it('an errored scenario keeps the points its passed checks earned', async () => {
    const groups: Group[] = [{ id: 'g', title: 'G', points: 4 }];
    const s: ScenarioResult = { ...scenario('s', 'g', [true, false]), status: 'error', error: 'late failure' };
    const r = await score({ assignment: assignment({ groups, max_points: 4 }), buildOk: true, scenarios: [s] });
    expect(r.points).toBe(2);
  });

  it('a group without scenarios scores 0 without NaN', async () => {
    const r = await score({ assignment: assignment({ groups: missionGroups }), buildOk: true, scenarios: [] });
    expect(r.points).toBe(0);
    expect(r.groups.every((g) => g.points === 0)).toBe(true);
  });

  it('a group whose scenario weights sum to zero scores 0 without NaN', async () => {
    const groups: Group[] = [{ id: 'g', title: 'G', points: 4 }];
    const r = await score({
      assignment: assignment({ groups, max_points: 4 }),
      buildOk: true,
      scenarios: [scenario('z', 'g', [true], 0)],
    });
    expect(r.points).toBe(0);
    expect(r.groups[0]!.scenarios).toEqual([{ id: 'z', points: 0, max: 0 }]);
  });

  it('lists scenarios without a group or with an unknown group id as ungrouped, scoring 0', async () => {
    const r = await score({
      assignment: assignment({ groups: missionGroups }),
      buildOk: true,
      scenarios: [...missionScenarios(), scenario('loose', undefined, [true]), scenario('typo', 'no-such-group', [true])],
    });
    expect(r.ungrouped).toEqual([
      { id: 'loose', points: 0, max: 0 },
      { id: 'typo', points: 0, max: 0 },
    ]);
    expect(r.points).toBe(16);
  });
});

describe('scoring-proportional without groups (legacy)', () => {
  const four = (lastHalf: boolean): ScenarioResult[] => [
    scenario('a', undefined, [true, true]),
    scenario('b', undefined, [true]),
    scenario('c', undefined, [true]),
    scenario('d', undefined, lastHalf ? [true, false] : [true]),
  ];

  it('(e) splits max_points equally by scenario weight: 3 full + one half = 17.5, ceil → 18', async () => {
    const input: ScoreInput = { assignment: assignment(), buildOk: true, scenarios: four(true) };
    const plain = await score(input);
    expect(plain.points).toBe(17.5);
    expect(plain.automaticPoints).toBe(17.5);
    expect(plain.max).toBe(20);
    expect(plain.groups).toEqual([]);
    expect(plain.ungrouped).toEqual([
      { id: 'a', points: 5, max: 5 },
      { id: 'b', points: 5, max: 5 },
      { id: 'c', points: 5, max: 5 },
      { id: 'd', points: 2.5, max: 5 },
    ]);
    expect((await score(input, { rounding: 'ceil' })).points).toBe(18);
    expect((await score(input, { rounding: 'floor' })).points).toBe(17);
    expect((await score(input, { rounding: 'round' })).points).toBe(18);
    expect((await score(input, { rounding: 'ceil' })).rounding).toBe('ceil');
  });

  it('treats an empty groups array like no groups', async () => {
    const r = await score({ assignment: assignment({ groups: [] }), buildOk: true, scenarios: four(false) });
    expect(r.points).toBe(20);
  });

  it('weights scenarios when splitting', async () => {
    const scenarios = [scenario('x', undefined, [true], 3), scenario('y', undefined, [false], 1)];
    const r = await score({ assignment: assignment({ max_points: 20 }), buildOk: true, scenarios });
    expect(r.points).toBe(15);
  });

  it('scores 0 with no scenarios', async () => {
    const r = await score({ assignment: assignment(), buildOk: true, scenarios: [] });
    expect(r.points).toBe(0);
  });
});

describe('scoring-proportional rounding and cap', () => {
  const groups: Group[] = [{ id: 'g', title: 'G', points: 20 }];

  it('takes rounding and cap defaults from assignment.scoring; options override them', async () => {
    const input: ScoreInput = {
      assignment: assignment({ scoring: { use: 'proportional', rounding: 'ceil', cap: true } }),
      buildOk: true,
      scenarios: [scenario('a', undefined, [true, false])],
    };
    const fromConfig = await score(input);
    expect(fromConfig.rounding).toBe('ceil');
    expect(fromConfig.points).toBe(10);
    expect((await score(input, { rounding: 'none' })).rounding).toBe('none');
  });

  it('applies rounding to the total only; group and scenario values stay unrounded', async () => {
    const g: Group[] = [
      { id: 'a', title: 'A', points: 1 },
      { id: 'b', title: 'B', points: 1 },
    ];
    const scenarios = [scenario('sa', 'a', [true, false, false]), scenario('sb', 'b', [true, false, false])];
    const r = await score(
      { assignment: assignment({ groups: g, max_points: 2 }), buildOk: true, scenarios },
      { rounding: 'ceil' },
    );
    expect(r.groups[0]!.points).toBeCloseTo(1 / 3, 12);
    expect(r.points).toBe(1);
  });

  it('(f) cap never lets the total exceed max_points; cap:false allows it', async () => {
    const manualGroups: Group[] = [
      { id: 'auto', title: 'Auto', points: 20 },
      { id: 'extra', title: 'Extra', points: 5, manual: true },
    ];
    const input: ScoreInput = {
      assignment: assignment({ groups: manualGroups, max_points: 20 }),
      buildOk: true,
      scenarios: [scenario('s', 'auto', [true])],
      manual: { extra: 5 },
    };
    expect((await score(input)).points).toBe(20);
    expect((await score(input, { cap: true })).points).toBe(20);
    expect((await score(input, { cap: false })).points).toBe(25);
    expect((await score(input, { cap: false })).max).toBe(20);
  });

  it('cap clamps after rounding', async () => {
    const r = await score(
      {
        assignment: assignment({ groups, max_points: 10 }),
        buildOk: true,
        scenarios: [scenario('s', 'g', [true, true, true])],
      },
      { rounding: 'ceil' },
    );
    expect(r.points).toBe(10);
  });

  it('is not fooled by float noise: 17.000000000000004 with ceil gives 17, not 18', async () => {
    // 0.1 + 0.2 + ... style drift: three groups of 5.666…/…, summing to a hair above 17.
    const noisy = 17.000000000000004;
    expect(Math.ceil(noisy)).toBe(18); // sanity: the naive implementation is wrong here
    const g: Group[] = [
      { id: 'a', title: 'A', points: 10 },
      { id: 'b', title: 'B', points: 7.000000000000004 },
    ];
    const scenarios = [scenario('sa', 'a', [true]), scenario('sb', 'b', [true])];
    const input: ScoreInput = { assignment: assignment({ groups: g, max_points: 20 }), buildOk: true, scenarios };
    const ceil = await score(input, { rounding: 'ceil' });
    expect(ceil.points).toBe(17);
    expect((await score(input, { rounding: 'floor' })).points).toBe(17);
    expect((await score(input, { rounding: 'round' })).points).toBe(17);
    expect((await score(input, { rounding: 'none' })).points).toBe(17);
  });

  it('is not fooled by float noise just below an integer either (floor)', async () => {
    const g: Group[] = [
      { id: 'a', title: 'A', points: 10 },
      { id: 'b', title: 'B', points: 6.999999999999996 },
    ];
    expect(Math.floor(10 + 6.999999999999996)).toBe(16); // sanity: the naive implementation is wrong here
    const scenarios = [scenario('sa', 'a', [true]), scenario('sb', 'b', [true])];
    const r = await score(
      { assignment: assignment({ groups: g, max_points: 20 }), buildOk: true, scenarios },
      { rounding: 'floor' },
    );
    expect(r.points).toBe(17);
  });
});

describe('loadManualPoints', () => {
  it('(i) reads YAML: { studentId: { groupId: number } }', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'manual.yaml');
      await writeFile(file, 'xnovak:\n  review: 3\n  style: 1.5\nxkral:\n  review: 0\n');
      expect(await loadManualPoints(file)).toEqual({ xnovak: { review: 3, style: 1.5 }, xkral: { review: 0 } });
    });
  });

  it('reads JSON', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'manual.json');
      await writeFile(file, JSON.stringify({ xnovak: { review: 4 } }));
      expect(await loadManualPoints(file)).toEqual({ xnovak: { review: 4 } });
    });
  });

  it('treats an empty file as no manual points', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'manual.yaml');
      await writeFile(file, '');
      expect(await loadManualPoints(file)).toEqual({});
    });
  });

  it('rejects non-numeric values with a clear error', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'manual.yaml');
      await writeFile(file, 'xnovak:\n  review: lots\n');
      await expect(loadManualPoints(file)).rejects.toThrow(/xnovak.*review.*number/i);
      await writeFile(file, 'xnovak:\n  review: "3"\n');
      await expect(loadManualPoints(file)).rejects.toThrow(/xnovak.*review.*number/i);
      await writeFile(file, 'xnovak:\n  review: .nan\n');
      await expect(loadManualPoints(file)).rejects.toThrow(/xnovak.*review.*number/i);
    });
  });

  it('rejects wrong shapes', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'manual.yaml');
      for (const body of ['- a\n- b\n', 'just text\n', 'xnovak: 3\n', 'xnovak:\n  - 1\n']) {
        await writeFile(file, body);
        await expect(loadManualPoints(file)).rejects.toThrow(/manual/i);
      }
    });
  });

  it('rejects unparseable YAML and missing files with a message naming the file', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'manual.yaml');
      await writeFile(file, 'a: [unclosed\n');
      await expect(loadManualPoints(file)).rejects.toThrow(/manual\.yaml/);
      await expect(loadManualPoints(join(dir, 'missing.yaml'))).rejects.toThrow(/missing\.yaml/);
    });
  });
});
