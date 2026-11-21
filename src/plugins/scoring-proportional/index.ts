import { z } from 'zod';
import type { CheckResult, GroupScore, ScenarioResult, ScoreInput, ScoreResult } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';

const params = z.strictObject({
  rounding: z.enum(['none', 'floor', 'round', 'ceil']).optional(), // default: assignment.scoring.rounding
  cap: z.boolean().optional(), // default: assignment.scoring.cap
});

type Rounding = 'none' | 'floor' | 'round' | 'ceil';
type Line = { id: string; points: number; max: number };

/** Removes float noise (17.000000000000004 → 17; resolution 1e-9) so floor/ceil/round act on the intended value. */
const snap = (value: number): number => Number(value.toFixed(9)) + 0; // `+ 0` turns -0 into 0

const roundTotal = (value: number, mode: Rounding): number => {
  const v = snap(value);
  if (mode === 'floor') return Math.floor(v);
  if (mode === 'ceil') return Math.ceil(v);
  if (mode === 'round') return Math.round(v);
  return v;
};

/** Passed check weight ÷ total check weight; 0 for a scenario without (weighted) checks. */
function ratio(checks: CheckResult[]): number {
  let total = 0;
  let passed = 0;
  for (const c of checks) {
    total += c.weight;
    if (c.pass) passed += c.weight;
  }
  return total > 0 ? passed / total : 0;
}

/**
 * Splits `pool` points over `scenarios` by scenario weight; each scenario earns its share × its check ratio.
 * With a zero total weight nothing can be distributed, so everything scores 0.
 */
function distribute(pool: number, scenarios: ScenarioResult[], earn: boolean): Line[] {
  const totalWeight = scenarios.reduce((sum, s) => sum + s.weight, 0);
  return scenarios.map((s) => {
    const max = totalWeight > 0 ? (pool * s.weight) / totalWeight : 0;
    return { id: s.id, max, points: earn ? max * ratio(s.checks) : 0 };
  });
}

const sum = (lines: Array<{ points: number }>): number => lines.reduce((total, l) => total + l.points, 0);

function score(input: ScoreInput, opts: z.output<typeof params>): ScoreResult {
  const { assignment, scenarios } = input;
  const rounding: Rounding = opts.rounding ?? assignment.scoring.rounding;
  const cap = opts.cap ?? assignment.scoring.cap;
  const max = assignment.max_points;

  let automatic: number;
  let manualTotal = 0;
  let groups: GroupScore[] = [];
  let ungrouped: Line[] = [];

  if (assignment.groups === undefined || assignment.groups.length === 0) {
    // Legacy: max_points split equally by scenario weight.
    ungrouped = distribute(max, scenarios, true);
    automatic = sum(ungrouped);
  } else {
    const known = new Set(assignment.groups.map((g) => g.id));
    groups = assignment.groups.map((group): GroupScore => {
      const manual = group.manual === true;
      const requiresBuild = group.requires_build === true;
      const base = { id: group.id, title: group.title, max: group.points, manual, requiresBuild };
      const members = scenarios.filter((s) => s.group === group.id);

      if (manual) {
        // Scenarios of a manual group do not contribute; they are listed with 0/0 for completeness.
        const supplied = input.manual?.[group.id];
        const given = typeof supplied === 'number' && Number.isFinite(supplied);
        const points = given ? Math.min(Math.max(supplied, 0), group.points) : 0;
        manualTotal += points;
        return {
          ...base,
          points,
          pending: !given,
          scenarios: members.map((s) => ({ id: s.id, points: 0, max: 0 })),
        };
      }

      const lines = distribute(group.points, members, !(requiresBuild && !input.buildOk));
      return { ...base, points: sum(lines), pending: false, scenarios: lines };
    });
    ungrouped = scenarios.filter((s) => s.group === undefined || !known.has(s.group)).map((s) => ({ id: s.id, points: 0, max: 0 }));
    automatic = sum(groups.filter((g) => !g.manual));
  }

  let points = roundTotal(automatic + manualTotal, rounding);
  if (cap) points = Math.min(points, max);

  return { points, max, automaticPoints: snap(automatic), groups, ungrouped, rounding };
}

export const scoringProportional = fp(
  (app) => {
    app.scorer('proportional', {
      description:
        'Proportional scoring: group points are split by scenario weight and earned by the passed share of check weights; rounding applies to the total.',
      params,
      score,
    });
  },
  { name: 'scoring-proportional' },
);
