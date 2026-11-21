import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadAssignment, type LoadedAssignment } from '../../src/core/assignment.ts';
import type { Issue } from '../../src/core/contracts.ts';
import { validateAssignment } from '../../src/core/validate.ts';
import { withTempDir } from '../helpers/tmp.ts';
import { stubPlugin } from '../helpers/stub-plugin.ts';

const fixture = (name: string): string => new URL(`../fixtures/assignments/${name}`, import.meta.url).pathname;
const load = (name: string): Promise<LoadedAssignment> => loadAssignment(fixture(name), { extraPlugins: [stubPlugin] });
const errors = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === 'error');

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

describe('validateAssignment', () => {
  it('accepts the valid fixture (nested checks, from ids, fixtures and runtime variables included)', async () => {
    const loaded = await load('valid');
    expect(loaded.issues).toEqual([]);
    expect(validateAssignment(loaded)).toEqual([]);
  });

  it('reports an unknown step with its pointer', async () => {
    const issues = validateAssignment(await load('bad-unknown-step'));
    expect(errors(issues)).toEqual([
      { path: 'scenarios/s.yaml#/0/steps/0', message: expect.stringMatching(/unknown step 'bogus'.*available: .*noop/), severity: 'error' },
    ]);
  });

  describe('source scoping', () => {
    it('rejects a run check in a session-only scenario, an unknown from and a from of the wrong kind', async () => {
      const issues = errors(validateAssignment(await load('bad-source')));
      expect(issues).toEqual([
        { path: 'scenarios/s.yaml#/0/expect/0', message: expect.stringMatching(/source: run.*no step that produces a run/), severity: 'error' },
        { path: 'scenarios/s.yaml#/1/expect/0/from', message: "from 'nope' does not match any step id", severity: 'error' },
        { path: 'scenarios/s.yaml#/2/expect/0/from', message: expect.stringMatching(/step 's1' produces a session/), severity: 'error' },
      ]);
    });

    it('validates nested checks recursively, inheriting from', async () => {
      await withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n',
          'scenarios/s.yaml': [
            '- id: a',
            '  title: A',
            '  steps:',
            '    - mksession: {}',
            '  expect:',
            '    - any_of:',
            '        - stdout_x: { contains: a }',
            '        - nonexistent: {}',
            '',
          ].join('\n'),
        });
        const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
        expect(issues.map((i) => [i.path, i.message])).toEqual([
          ['scenarios/s.yaml#/0/expect/0/nested/0', expect.stringMatching(/source: run/)],
          ['scenarios/s.yaml#/0/expect/0/nested/1', expect.stringMatching(/unknown check 'nonexistent'/)],
        ]);
      });
    });

    it('flags duplicate step ids and a from that names a step producing no record', async () => {
      await withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n',
          'scenarios/s.yaml': [
            '- id: a',
            '  title: A',
            '  steps:',
            '    - mkrun: {}',
            '      id: r',
            '    - noop:',
            '      id: r',
            '    - noop:',
            '      id: plain',
            '  expect:',
            '    - stdout_x: {}',
            '      from: plain',
            '',
          ].join('\n'),
        });
        const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
        expect(issues.map((i) => [i.path, i.message])).toEqual([
          ['scenarios/s.yaml#/0/steps/1/id', "duplicate step id 'r'"],
          ['scenarios/s.yaml#/0/expect/0/from', "from 'plain' is a step that produces no run or session"],
        ]);
      });
    });
  });

  describe('from on composite checks', () => {
    const validate = (scenarios: string[]): Promise<Array<[string, string]>> =>
      withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n',
          'scenarios/s.yaml': `${scenarios.join('\n')}\n`,
        });
        const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
        return issues.map((i): [string, string] => [i.path, i.message]);
      });

    it('accepts from on a composite whose run-source children read a run step', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - mkrun: {}',
        '      id: r',
        '    - mksession: {}',
        '      id: s',
        '  expect:',
        '    - any_of:',
        '        - stdout_x: {}',
        '        - nothing: {}',
        '      from: r',
      ]);
      expect(issues).toEqual([]);
    });

    it('rejects a session-kind from over run-source children, at the child', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - mkrun: {}',
        '    - mksession: {}',
        '      id: s',
        '  expect:',
        '    - all_of:',
        '        - stdout_x: {}',
        '      from: s',
      ]);
      expect(issues).toEqual([
        ['scenarios/s.yaml#/0/expect/0/nested/0', expect.stringMatching(/check 'stdout_x' reads a run.*step 's' produces a session/)],
      ]);
    });

    it('lets a nested check override the inherited from', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - mkrun: {}',
        '      id: r',
        '    - mksession: {}',
        '      id: s',
        '  expect:',
        '    - any_of:',
        '        - stdout_x: {}',
        '          from: r',
        '        - screen_x: {}',
        '      from: s',
      ]);
      expect(issues).toEqual([]);
    });

    it('reports an unknown from on a composite', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - mkrun: {}',
        '  expect:',
        '    - any_of:',
        '        - nothing: {}',
        '      from: nope',
      ]);
      expect(issues).toEqual([['scenarios/s.yaml#/0/expect/0/from', "from 'nope' does not match any step id"]]);
    });

    it('reports a from that names a step producing no record', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - noop:',
        '      id: plain',
        '  expect:',
        '    - any_of:',
        '        - nothing: {}',
        '      from: plain',
      ]);
      expect(issues).toEqual([['scenarios/s.yaml#/0/expect/0/from', "from 'plain' is a step that produces no run or session"]]);
    });

    it('accepts a composite from over source:none children', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - mkrun: {}',
        '      id: r',
        '  expect:',
        '    - all_of:',
        '        - nothing: {}',
        '      from: r',
      ]);
      expect(issues).toEqual([]);
    });

    it('still rejects from on a non-composite source:none check', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - mkrun: {}',
        '      id: r',
        '  expect:',
        '    - nothing: {}',
        '      from: r',
      ]);
      expect(issues).toEqual([['scenarios/s.yaml#/0/expect/0/from', "check 'nothing' does not read a record; remove from"]]);
    });
  });

  describe('expect-only scenarios', () => {
    const validate = (scenarios: string[]): Promise<Array<[string, string]>> =>
      withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n',
          'scenarios/s.yaml': `${scenarios.join('\n')}\n`,
        });
        const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
        return [...loaded.issues, ...errors(validateAssignment(loaded))].map((i): [string, string] => [i.path, i.message]);
      });

    it('validates a scenario with only static checks and no step', async () => {
      const issues = await validate(['- id: a', '  title: A', '  expect:', '    - nothing: {}']);
      expect(issues).toEqual([]);
    });

    it('rejects a run-source check when the scenario has no step that produces a run', async () => {
      const issues = await validate(['- id: a', '  title: A', '  expect:', '    - nothing: {}', '    - stdout_x: {}']);
      expect(issues).toEqual([
        ['scenarios/s.yaml#/0/expect/1', expect.stringMatching(/check 'stdout_x' reads a run.*no step that produces a run/)],
      ]);
    });

    it('rejects an either-source check in a scenario with no producing step', async () => {
      const issues = await validate(['- id: a', '  title: A', '  expect:', '    - any_x: {}']);
      expect(issues).toEqual([['scenarios/s.yaml#/0/expect/0', expect.stringMatching(/source: either.*no step that produces one/)]]);
    });

    it('rejects an expect-only scenario with an empty expect', async () => {
      const issues = await validate(['- id: a', '  title: A', '  expect: []']);
      expect(issues).toEqual([['scenarios/s.yaml#/0', expect.stringMatching(/at least one step.*expect check/)]]);
    });
  });

  describe('ids given inside the params of a producing step', () => {
    const header = 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n';
    const validate = (scenarios: string[]): Promise<Array<[string, string]>> =>
      withTempDir(async (dir) => {
        await write(dir, { 'assignment.yaml': header, 'scenarios/s.yaml': `${scenarios.join('\n')}\n` });
        const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
        return issues.map((i): [string, string] => [i.path, i.message]);
      });

    it('accepts a from that names a session id set in the session params', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  session: { id: menu, steps: [{ send: x }] }',
        '  expect:',
        '    - screen_contains: x',
        '      from: menu',
        '    - exit_code: 0',
        '      from: menu',
      ]);
      expect(issues).toEqual([]);
    });

    it('still checks the kind of a params-level id, and unknown ids', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  session: { id: menu }',
        '  expect:',
        '    - stdout_contains: x',
        '      from: menu',
        '    - screen_contains: x',
        '      from: other',
      ]);
      expect(issues).toEqual([
        ['scenarios/s.yaml#/0/expect/0/from', expect.stringMatching(/step 'menu' produces a session/)],
        ['scenarios/s.yaml#/0/expect/1/from', "from 'other' does not match any step id"],
      ]);
    });

    it('flags duplicates between step-level and params-level ids', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - session: {}',
        '      id: dup',
        '    - session: { id: dup }',
        '    - session: { id: other }',
        '    - session: { id: other }',
        '  expect: []',
      ]);
      expect(issues).toEqual([
        ['scenarios/s.yaml#/0/steps/1/id', "duplicate step id 'dup'"],
        ['scenarios/s.yaml#/0/steps/3/id', "duplicate step id 'other'"],
      ]);
    });

    it('does not report one id that is given both ways on the same step', async () => {
      const issues = await validate([
        '- id: a',
        '  title: A',
        '  steps:',
        '    - session: { id: same }',
        '      id: same',
        '  expect:',
        '    - screen_contains: x',
        '      from: same',
      ]);
      expect(issues).toEqual([]);
    });
  });

  it('reports group points that do not sum to max_points', async () => {
    const issues = errors(validateAssignment(await load('bad-group-sum')));
    expect(issues).toEqual([
      { path: 'assignment.yaml#/groups', message: 'group points sum to 9, but max_points is 10', severity: 'error' },
    ]);
  });

  it('reports a missing fixture through the step validate() hook', async () => {
    const issues = errors(validateAssignment(await load('bad-fixture')));
    expect(issues).toEqual([
      { path: 'scenarios/s.yaml#/0/steps/1/file', message: "fixture 'missing.txt' does not exist", severity: 'error' },
    ]);
  });

  it('reports unknown variables but not runtime ones, and variables in a group', async () => {
    const issues = errors(validateAssignment(await load('bad-var')));
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      ['scenarios/s.yaml#/0/group', 'group is not interpolated: variables are not allowed in a group id'],
      ['scenarios/s.yaml#/0/run', expect.stringMatching(/unknown variable \$\{zzz\}/)],
      ['scenarios/s.yaml#/0/expect/0', expect.stringMatching(/unknown variable \$\{other\}/)],
    ]);
  });

  it('reports duplicate scenario ids across files and unknown groups', async () => {
    await withTempDir(async (dir) => {
      const scenario = (group: string): string => `- id: same\n  title: S\n  group: ${group}\n  run: {}\n  expect: []\n`;
      await write(dir, {
        'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\ngroups:\n  - { id: g, title: G, points: 1 }\n',
        'scenarios/a.yaml': scenario('g'),
        'scenarios/b.yaml': scenario('missing'),
      });
      const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
      expect(issues.map((i) => [i.path, i.message])).toEqual([
        ['scenarios/b.yaml#/0/id', "duplicate scenario id 'same' (first defined at scenarios/a.yaml#/0)"],
        ['scenarios/b.yaml#/0/group', expect.stringMatching(/unknown group 'missing'/)],
      ]);
    });
  });

  it('reports unknown builder and scorer, bad builder params and a missing template', async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: nope }\nproject_root_marker: m\nscoring: { use: nada }\ntemplate: tpl\n',
        'scenarios/a.yaml': '- id: a\n  title: A\n  run: {}\n  expect: []\n',
      });
      const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
      expect(issues.map((i) => i.path)).toEqual([
        'assignment.yaml#/build/type',
        'assignment.yaml#/scoring/use',
        'assignment.yaml#/template',
      ]);

      await write(dir, { 'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build, extra: 1 }\nproject_root_marker: m\n' });
      const strict = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
      expect(strict).toEqual([]); // stub builder params are a plain z.object: unknown keys are stripped
    });
  });

  it('validates params against the registered schema, reporting the zod message at the pointer', async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n',
        'scenarios/a.yaml': '- id: a\n  title: A\n  steps:\n    - feed: { file: 5 }\n  run: {}\n  expect:\n    - stdout_x: { contains: 7 }\n',
      });
      const issues = errors(validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] })));
      expect(issues.map((i) => i.path)).toEqual(['scenarios/a.yaml#/0/steps/0/file', 'scenarios/a.yaml#/0/expect/0/contains']);
    });
  });

  it('warns when a localized title lacks the assignment locale', async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\ngroups:\n  - { id: g, title: { sk: Skupina }, points: 1 }\n',
        'scenarios/a.yaml': '- id: a\n  title: { sk: Ahoj }\n  group: g\n  run: {}\n  expect: []\n',
      });
      const issues = validateAssignment(await loadAssignment(dir, { extraPlugins: [stubPlugin] }));
      expect(issues).toEqual([
        { path: 'assignment.yaml#/groups/0/title', message: "title has no 'en' translation", severity: 'warning' },
        { path: 'scenarios/a.yaml#/0/title', message: "title has no 'en' translation", severity: 'warning' },
      ]);
    });
  });

  it('reports a matrix scenario problem once', async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: m\n',
        'scenarios/a.yaml': '- id: a-${n}\n  title: A\n  matrix: { n: ["1", "2", "3"] }\n  steps:\n    - bogus: {}\n  expect: []\n',
      });
      const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
      expect(loaded.scenarios).toHaveLength(3);
      expect(errors(validateAssignment(loaded))).toHaveLength(1);
    });
  });
});
