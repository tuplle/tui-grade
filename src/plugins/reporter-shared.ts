// Helpers shared by the built-in reporters.
import { basename } from 'node:path';
import type { CheckResult, ScenarioResult, SubmissionResult, Translate } from '../core/contracts.ts';

/** Up to two decimals, trailing zeros trimmed (`16`, `2.5`, `13.33`). */
export const formatNumber = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(2)) + 0) : '0'); // `+ 0` turns -0 into 0

/**
 * Hidden checks keep only name, verdict and weight; the description (built from the check's parameters) is
 * replaced by a generic label, and expected/actual/message are dropped: none of it may reach students.
 */
function publicCheck(check: CheckResult, t: Translate): CheckResult {
  if (!check.hidden) return check;
  const { name, pass, weight, hidden } = check;
  return { name, description: t('report.check.hidden'), pass, weight, hidden };
}

function publicScenario(scenario: ScenarioResult, t: Translate): ScenarioResult {
  // screens and run logs are delivered as files under `screens/` and `logs/` (see `artifacts`)
  const { screens: _screens, logs: _logs, ...rest } = scenario;
  return { ...rest, checks: scenario.checks.map((c) => publicCheck(c, t)) };
}

/**
 * The result as handed to students: no hidden-check details, no inline screen texts or run logs, and no paths of the
 * instructor's machine (`source.path` is reduced to its file name, `source.root` is dropped). The input is not modified.
 */
export function publicResult(result: SubmissionResult, t: Translate): SubmissionResult {
  const { kind, path } = result.source;
  return {
    ...result,
    source: { path: basename(path), kind, root: null },
    scenarios: result.scenarios.map((s) => publicScenario(s, t)),
  };
}
