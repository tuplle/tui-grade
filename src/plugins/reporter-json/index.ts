import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubmissionResult, Translate } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { writeFileAtomic } from '../../core/workspace.ts';
import { publicResult } from '../reporter-shared.ts';

export const RESULT_FILE = 'results.json';
export const FULL_RESULT_FILE = 'results.full.json';

/** The teacher-only result: hidden checks keep their details; inline screens/logs stay in their artifact files. */
export function fullResult(result: SubmissionResult): SubmissionResult {
  return {
    ...result,
    scenarios: result.scenarios.map(({ screens: _screens, logs: _logs, ...scenario }) => scenario),
  };
}

export async function writeResultFiles(dir: string, result: SubmissionResult, t: Translate): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, RESULT_FILE), `${JSON.stringify(publicResult(result, t), null, 2)}\n`);
  await writeFileAtomic(join(dir, FULL_RESULT_FILE), `${JSON.stringify(fullResult(result), null, 2)}\n`);
}

export const reporterJson = fp(
  (app) => {
    app.reporter('json', {
      description:
        'Writes the student-facing result to <out>/<student>/results.json and a teacher-only results.full.json (hidden checks included, never packed into the student ZIP).',
      scope: 'submission',
      async reportSubmission(ctx, result) {
        await writeResultFiles(join(ctx.outDir, result.student.id), result, ctx.t);
      },
    });
  },
  { name: 'reporter-json' },
);
