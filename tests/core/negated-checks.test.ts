// `not: true` checks are labelled as negated in results.json and report.md (catalog key check.not).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult } from '../../src/core/contracts.ts';
import { gradeAll } from '../../src/core/lifecycle.ts';
import { addStudent, fakeAssignment, GOOD } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';

const SCENARIOS = `- id: neg
  title: Negation
  group: behaviour
  steps:
    - run: { args: [] }
  expect:
    - stdout_contains: ok
    - stdout_contains: nope
      not: true
    - stdout_contains: ok
      not: true
      hidden: true
    - any_of:
        - stdout_contains: nope
        - stdout_contains: zzz
          not: true
    - all_of:
        - stdout_contains: ok
          not: true
`;

interface Graded {
  checks: CheckResult[];
  report: string;
  json: string;
}

async function grade(locale: 'en' | 'sk'): Promise<Graded> {
  return withTempDir(async (root) => {
    const env = await fakeAssignment(root, { scenarios: SCENARIOS });
    await addStudent(env, 'good', GOOD);
    const out = join(root, 'out');
    const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: out, locale });
    const scenario = results[0]?.scenarios[0];
    if (scenario === undefined) throw new Error('no scenario result');
    return {
      checks: scenario.checks,
      report: await readFile(join(out, 'good', 'report.md'), 'utf8'),
      json: await readFile(join(out, 'good', 'results.json'), 'utf8'),
    };
  });
}

describe('negated checks in results and reports', () => {
  it('en: a negated check is prefixed with NOT, a plain one is unchanged', async () => {
    const { checks, report } = await grade('en');
    expect(checks[0]?.description).toBe('Standard output contains "ok"');
    expect(checks[1]).toMatchObject({ pass: true, description: 'NOT: Standard output contains "nope"' });
    expect(report).toContain('- ✔ Standard output contains "ok": passed');
    expect(report).toContain('- ✔ NOT: Standard output contains "nope": passed');
    expect(report).not.toContain('- ✔ Standard output contains "nope"');
  });

  it('sk: the prefix is Slovak', async () => {
    const { checks, report } = await grade('sk');
    expect(checks[1]?.description).toBe('NIE: Štandardný výstup obsahuje „nope“');
    expect(report).toContain('- ✔ NIE: Štandardný výstup obsahuje „nope“: prešlo');
    expect(report).not.toMatch(/^- . NOT:/m); // (the English "expected NOT" of failure messages is a separate, older wording)
  });

  it('a hidden negated check shows only the hidden label and leaks nothing', async () => {
    for (const locale of ['en', 'sk'] as const) {
      const { checks, report, json } = await grade(locale);
      expect(checks[2]).toMatchObject({ hidden: true, pass: false }); // the plain description is kept in memory, never prefixed
      expect(checks[2]?.description).not.toMatch(/^(?:NOT|NIE):/);
      const label = locale === 'en' ? 'Hidden check' : 'Skrytá kontrola';
      expect(report).toContain(`- ✘ ${label}:`);
      const hidden = (JSON.parse(json) as { scenarios: Array<{ checks: Array<{ hidden: boolean; description: string }> }> }).scenarios[0]?.checks.find((c) => c.hidden);
      expect(hidden?.description).toBe(label);
    }
  });

  it('a negated child is prefixed in the composite description and in its failure detail; no double negation', async () => {
    const { checks, report } = await grade('en');
    // any_of passes through its negated second child; the composite itself is not negated
    expect(checks[3]).toMatchObject({ pass: true, description: 'At least one of: stdout_contains: nope, NOT: stdout_contains: zzz' });
    // all_of fails: its only child is negated and fails, the detail reads with the already negated child description
    const all = checks[4];
    expect(all).toMatchObject({ pass: false, description: 'All of: NOT: stdout_contains: ok' });
    expect(all?.message).toBe('failed: NOT: Standard output contains "ok" (expected NOT: Standard output contains "ok")');
    expect(report).not.toContain('NOT: NOT:');
  });
});
