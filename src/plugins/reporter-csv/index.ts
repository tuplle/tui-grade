import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubmissionResult } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { writeFileAtomic } from '../../core/workspace.ts';
import { formatNumber } from '../reporter-shared.ts';

const SEPARATOR = ';';

/** Quotes a field when it holds the separator, a quote or a line break. */
const quote = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/**
 * A leading `=`, `+`, `-`, `@`, tab or CR would make spreadsheets evaluate the cell as a formula; student
 * ids come from untrusted file names, so such ids get a `'` prefix.
 */
const studentCell = (id: string): string => quote(/^[=+\-@\t\r]/.test(id) ? `'${id}` : id);

/** Group ids from the assignment, or - without groups - scenario ids in order of first appearance. */
function columns(results: SubmissionResult[], groupIds: string[]): { ids: string[]; grouped: boolean } {
  if (groupIds.length > 0) return { ids: groupIds, grouped: true };
  const ids = new Set<string>();
  for (const r of results) for (const line of r.score.ungrouped) ids.add(line.id);
  return { ids: [...ids], grouped: false };
}

function cell(result: SubmissionResult, id: string, grouped: boolean): string {
  if (grouped) {
    const group = result.score.groups.find((g) => g.id === id);
    return group === undefined || group.pending ? '' : formatNumber(group.points);
  }
  const line = result.score.ungrouped.find((l) => l.id === id);
  return line === undefined ? '' : formatNumber(line.points);
}

export function renderSummaryCsv(results: SubmissionResult[], groupIds: string[]): string {
  const { ids, grouped } = columns(results, groupIds);
  const rows = [...results].sort((a, b) => (a.student.id < b.student.id ? -1 : a.student.id > b.student.id ? 1 : 0));
  const lines = [['student', 'points', 'max', ...ids.map(quote)].join(SEPARATOR)];
  for (const r of rows) {
    lines.push(
      [studentCell(r.student.id), formatNumber(r.score.points), formatNumber(r.score.max), ...ids.map((id) => cell(r, id, grouped))].join(
        SEPARATOR,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function writeSummaryCsv(outDir: string, results: SubmissionResult[], groupIds: string[]): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFileAtomic(join(outDir, 'summary.csv'), renderSummaryCsv(results, groupIds));
}

export const reporterCsv = fp(
  (app) => {
    app.reporter('csv', {
      description: 'Writes <out>/summary.csv: one row per student with total points and one column per group (or per scenario when there are no groups); ";"-separated.',
      scope: 'run',
      async reportRun(ctx, results) {
        await writeSummaryCsv(ctx.outDir, results, (ctx.assignment.groups ?? []).map((g) => g.id));
      },
    });
  },
  { name: 'reporter-csv' },
);
