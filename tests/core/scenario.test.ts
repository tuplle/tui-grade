import type { Issue, ScenarioIR } from '../../src/core/contracts.ts';
import {
  expandMatrix,
  normalizeScenario,
  parseScenarioFile,
  type RawScenario,
} from '../../src/core/scenario.ts';

/** Parses, expands and normalizes every scenario in a YAML text. */
function load(text: string, file = 'f.yaml'): { scenarios: ScenarioIR[]; issues: Issue[] } {
  const parsed = parseScenarioFile(text, file);
  const issues = [...parsed.issues];
  const scenarios: ScenarioIR[] = [];
  parsed.raw.forEach((raw, position) => {
    const index = parsed.indices[position] as number;
    const expanded = expandMatrix(raw, index, file);
    issues.push(...expanded.issues);
    for (const item of expanded.scenarios) {
      const normalized = normalizeScenario(item, index, file);
      issues.push(...normalized.issues);
      if (normalized.scenario) scenarios.push(normalized.scenario);
    }
  });
  return { scenarios, issues };
}

describe('parseScenarioFile', () => {
  it('reports invalid YAML as an issue with line info instead of throwing', () => {
    const { raw, issues } = parseScenarioFile('- id: a\n  title: [unclosed\n', 'bad.yaml');
    expect(raw).toEqual([]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ severity: 'error' });
    expect(issues[0]?.path).toBe('bad.yaml#/');
    expect(issues[0]?.message).toMatch(/line \d+, col \d+/);
  });

  it('reports a non-array document and empty files', () => {
    expect(parseScenarioFile('id: a\n', 'f.yaml').issues[0]?.message).toMatch(/array/);
    expect(parseScenarioFile('', 'f.yaml').issues[0]?.message).toMatch(/array/);
  });

  it('accepts a localized title', () => {
    const { raw, issues } = parseScenarioFile(
      '- id: a\n  title: { en: a, sk: b }\n  run: { args: [] }\n  expect: []\n',
      'f.yaml',
    );
    expect(issues).toEqual([]);
    expect(raw[0]?.title).toEqual({ en: 'a', sk: 'b' });
  });

  it('reports structural problems with a pointer into the scenario', () => {
    const { raw, issues } = parseScenarioFile(
      '- id: ok\n  title: t\n  run: {}\n  expect: []\n- id: 5\n  title: t\n  expect: []\n- id: x\n  title: t\n  bogus: 1\n  expect: []\n',
      'f.yaml',
    );
    expect(raw.map((r) => r.id)).toEqual(['ok']);
    expect(issues.map((i) => i.path).sort()).toEqual(['f.yaml#/1/id', 'f.yaml#/2']);
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });

  it('keeps original file indices in pointers after a dropped scenario', () => {
    const text = [
      '- id: ok',
      '  title: t',
      '  run: {}',
      '  expect: []',
      '- id: 5', // invalid: dropped from raw
      '  title: t',
      '  expect: []',
      '- id: later',
      '  title: t',
      '  run: {}',
      '  expect:',
      '    - { stdout_contains: x, exit_code: 0 }', // bad check
      '',
    ].join('\n');
    const parsed = parseScenarioFile(text, 'f.yaml');
    expect(parsed.raw.map((r) => r.id)).toEqual(['ok', 'later']);
    expect(parsed.indices).toEqual([0, 2]);
    expect(parsed.issues.map((i) => i.path)).toEqual(['f.yaml#/1/id']);

    const { issues } = load(text);
    expect(issues.map((i) => i.path)).toEqual(['f.yaml#/1/id', 'f.yaml#/2/expect/0']);
  });

  it('returns empty indices when the file cannot be parsed', () => {
    expect(parseScenarioFile('id: a\n', 'f.yaml').indices).toEqual([]);
    expect(parseScenarioFile('- [unclosed\n', 'f.yaml').indices).toEqual([]);
  });

  it('rejects an empty matrix value list', () => {
    const { issues } = parseScenarioFile('- id: a\n  title: t\n  matrix: { type: [] }\n  run: {}\n  expect: []\n', 'f.yaml');
    expect(issues[0]?.path).toBe('f.yaml#/0/matrix/type');
  });
});

describe('normalizeScenario', () => {
  it('splits a check into name, params and modifiers', () => {
    const { scenarios, issues } = load(
      '- id: a\n  title: t\n  run: { args: [] }\n  expect:\n    - { stdout_contains: x, weight: 2, hidden: true, not: true, from: first }\n    - exit_code: 0\n',
    );
    expect(issues).toEqual([]);
    expect(scenarios[0]?.expect).toEqual([
      {
        name: 'stdout_contains',
        params: 'x',
        weight: 2,
        hidden: true,
        not: true,
        from: 'first',
        pointer: 'f.yaml#/0/expect/0',
      },
      { name: 'exit_code', params: 0, weight: 1, hidden: false, not: false, pointer: 'f.yaml#/0/expect/1' },
    ]);
  });

  it('reports a check with two non-reserved keys at its pointer', () => {
    const { scenarios, issues } = load(
      '- id: a\n  title: t\n  run: { args: [] }\n  expect:\n    - { stdout_contains: x, exit_code: 0 }\n',
    );
    expect(scenarios).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'f.yaml#/0/expect/0', severity: 'error' });
  });

  it('reports a check with only reserved keys and non-object entries', () => {
    const { issues } = load('- id: a\n  title: t\n  run: {}\n  expect:\n    - { weight: 2 }\n    - just text\n');
    expect(issues.map((i) => i.path)).toEqual(['f.yaml#/0/expect/0', 'f.yaml#/0/expect/1']);
  });

  it('reports invalid modifier types', () => {
    const { issues } = load('- id: a\n  title: t\n  run: {}\n  expect:\n    - { exit_code: 0, weight: heavy, hidden: 1 }\n');
    expect(issues.map((i) => i.path)).toEqual(['f.yaml#/0/expect/0/weight', 'f.yaml#/0/expect/0/hidden']);
  });

  it('normalizes steps with their id and reserved modifiers removed', () => {
    const { scenarios, issues } = load(
      '- id: a\n  title: t\n  group: g\n  weight: 3\n  steps:\n    - { write_file: { path: a, content: b }, id: w }\n    - { wait: 5 }\n  expect: []\n',
    );
    expect(issues).toEqual([]);
    expect(scenarios[0]).toMatchObject({
      id: 'a',
      group: 'g',
      weight: 3,
      file: 'f.yaml',
      pointer: 'f.yaml#/0',
      vars: {},
    });
    expect(scenarios[0]?.steps).toEqual([
      { name: 'write_file', params: { path: 'a', content: 'b' }, id: 'w', pointer: 'f.yaml#/0/steps/0' },
      { name: 'wait', params: 5, pointer: 'f.yaml#/0/steps/1' },
    ]);
  });

  it('orders setup, steps, run and session', () => {
    const { scenarios, issues } = load(
      [
        '- id: a',
        '  title: t',
        '  session: { args: [] }',
        '  run: { args: [--x] }',
        '  steps: [ { wait: 1 } ]',
        '  setup: [ { write_file: { path: p, content: c } } ]',
        '  expect: []',
        '',
      ].join('\n'),
    );
    expect(issues).toEqual([]);
    expect(scenarios[0]?.steps.map((s) => [s.name, s.pointer])).toEqual([
      ['write_file', 'f.yaml#/0/setup/0'],
      ['wait', 'f.yaml#/0/steps/0'],
      ['run', 'f.yaml#/0/run'],
      ['session', 'f.yaml#/0/session'],
    ]);
    expect(scenarios[0]?.steps[2]?.params).toEqual({ args: ['--x'] });
  });

  it('normalizes setup plus run to [setup..., run]', () => {
    const { scenarios, issues } = load(
      '- id: a\n  title: t\n  setup: [ { write_file: { path: p, content: c } } ]\n  run: { args: [] }\n  expect: []\n',
    );
    expect(issues).toEqual([]);
    expect(scenarios[0]?.steps.map((s) => s.name)).toEqual(['write_file', 'run']);
  });

  it('accepts an expect-only scenario (no steps, run or session) with an empty step list', () => {
    const { scenarios, issues } = load('- id: a\n  title: t\n  expect:\n    - no_compiler_warnings: true\n');
    expect(issues).toEqual([]);
    expect(scenarios[0]?.steps).toEqual([]);
    expect(scenarios[0]?.expect.map((c) => c.name)).toEqual(['no_compiler_warnings']);
  });

  it('rejects a scenario with neither a step nor an expect check', () => {
    const { scenarios, issues } = load('- id: a\n  title: t\n  expect: []\n');
    expect(scenarios).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'f.yaml#/0', severity: 'error' });
    expect(issues[0]?.message).toMatch(/at least one step.*expect check/);
  });

  it('reports a step with two non-reserved keys', () => {
    const { issues } = load('- id: a\n  title: t\n  steps:\n    - { wait: 1, run: {} }\n  expect: []\n');
    expect(issues.map((i) => i.path)).toEqual(['f.yaml#/0/steps/0']);
  });

  it('does not look up plugin registries (unknown names are fine)', () => {
    const { scenarios, issues } = load('- id: a\n  title: t\n  steps: [ { no_such_step: 1 } ]\n  expect:\n    - no_such_check: 1\n');
    expect(issues).toEqual([]);
    expect(scenarios[0]?.steps[0]?.name).toBe('no_such_step');
  });

  it('defaults the weight of a directly normalized scenario to 1', () => {
    const raw: RawScenario = { id: 'a', title: 't', run: {}, expect: [] };
    const { scenario } = normalizeScenario(raw, 4, 'g.yaml');
    expect(scenario).toMatchObject({ weight: 1, pointer: 'g.yaml#/4', vars: {} });
  });
});

describe('expandMatrix', () => {
  it('expands the cartesian product into unique ids and interpolates all nested strings', () => {
    const { scenarios, issues } = load(
      [
        '- id: x-${type}',
        '  title: { en: "Type ${type}", sk: "Typ ${type}" }',
        '  matrix: { type: [a, b] }',
        '  setup: [ { write_file: { path: "${type}.txt", content: "${type}" } } ]',
        '  run: { args: ["--type", "${type}", "${workdir}/${type}"] }',
        '  expect:',
        '    - stdout_contains: "${type}"',
        '',
      ].join('\n'),
    );
    expect(issues).toEqual([]);
    expect(scenarios.map((s) => s.id)).toEqual(['x-a', 'x-b']);
    expect(scenarios.map((s) => s.vars)).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(scenarios[1]?.title).toEqual({ en: 'Type b', sk: 'Typ b' });
    const run = scenarios[1]?.steps.find((s) => s.name === 'run');
    expect(run?.params).toEqual({ args: ['--type', 'b', '${workdir}/b'] }); // runtime variable survives
    expect(scenarios[1]?.steps[0]?.params).toEqual({ path: 'b.txt', content: 'b' });
    expect(scenarios[1]?.expect[0]?.params).toBe('b');
    expect(scenarios[1]?.pointer).toBe('f.yaml#/0'); // original index kept
    expect(scenarios[1]?.expect[0]?.pointer).toBe('f.yaml#/0/expect/0');
  });

  it('expands multiple keys as a cartesian product', () => {
    const { scenarios, issues } = load(
      '- id: ${a}-${b}\n  title: ${a}\n  matrix: { a: ["1", "2"], b: [x, y] }\n  run: {}\n  expect: []\n',
    );
    expect(issues).toEqual([]);
    expect(scenarios.map((s) => s.id)).toEqual(['1-x', '1-y', '2-x', '2-y']);
  });

  it('reports ids that are not unique across combinations', () => {
    const { scenarios, issues } = load('- id: x\n  title: t\n  matrix: { type: [a, b] }\n  run: {}\n  expect: []\n');
    expect(scenarios).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'f.yaml#/0/id', severity: 'error' });
    expect(issues[0]?.message).toMatch(/ids not unique/);
  });

  it('returns the scenario unchanged when there is no matrix', () => {
    const raw: RawScenario = { id: 'a', title: 't', run: { args: ['${binary}'] }, expect: [] };
    const { scenarios, issues } = expandMatrix(raw, 0, 'f.yaml');
    expect(issues).toEqual([]);
    expect(scenarios).toEqual([raw]);
  });

  it('keeps ${binary} untouched when expanding a matrix', () => {
    const raw: RawScenario = {
      id: 'a-${t}',
      title: 't',
      matrix: { t: ['1', '2'] },
      run: { args: ['${binary}', '${t}'] },
      expect: [],
    };
    const { scenarios, issues } = expandMatrix(raw, 0, 'f.yaml');
    expect(issues).toEqual([]);
    expect((scenarios[0]?.run as { args: string[] }).args).toEqual(['${binary}', '1']);
  });
});
