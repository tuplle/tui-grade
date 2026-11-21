// Re-scores an existing run (for example after manual points change) without rebuilding or rerunning student code.
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadAssignment } from './assignment.ts';
import type { Issue, SubmissionResult } from './contracts.ts';
import { ConfigError } from './errors.ts';
import { createTranslate } from './i18n.ts';
import { loadManualPoints } from './manual.ts';
import { readRunMetadata, writeRunMetadata } from './run-meta.ts';
import { writeSummaryCsv } from '../plugins/reporter-csv/index.ts';
import { FULL_RESULT_FILE, RESULT_FILE, writeResultFiles } from '../plugins/reporter-json/index.ts';
import { writeReport } from '../plugins/reporter-markdown/index.ts';
import { writeStudentZip } from '../plugins/reporter-zip/index.ts';

export interface RescoreOptions {
  assignmentDir: string;
  outDir: string;
  /** Default: `<outDir>/manual.yaml` when it exists. */
  manualFile?: string;
  locale?: string;
}

export interface RescoreResult {
  results: SubmissionResult[];
  issues: Issue[];
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function readStoredResult(dir: string): Promise<SubmissionResult | null> {
  for (const name of [FULL_RESULT_FILE, RESULT_FILE]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as SubmissionResult;
    } catch {
      // Try the next file (older runs have only results.json).
    }
  }
  return null;
}

/**
 * Recomputes every student's score from the stored results and rewrites the generated report files. No build, step,
 * check, hook or custom reporter runs. Throws when the assignment is unusable or the run has no results.
 */
export async function rescoreRun(opts: RescoreOptions): Promise<RescoreResult> {
  const assignmentDir = resolve(opts.assignmentDir);
  const outDir = resolve(opts.outDir);
  const loaded = await loadAssignment(assignmentDir);
  const errors = loaded.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new ConfigError(
      `assignment is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
      loaded.issues,
    );
  }

  const manualFile = resolve(opts.manualFile ?? join(outDir, 'manual.yaml'));
  const manual = (await exists(manualFile)) ? await loadManualPoints(manualFile) : undefined;
  const locale = opts.locale ?? loaded.config.locale;
  const t = createTranslate(locale, loaded.app.getCatalogs());
  const scorer = loaded.app.lookup('scorer', loaded.config.scoring.use);
  if (scorer === undefined) throw new Error(`unknown scorer '${loaded.config.scoring.use}'`);
  const scorerOptions: unknown = scorer.params.parse({
    rounding: loaded.config.scoring.rounding,
    cap: loaded.config.scoring.cap,
  });

  const issues: Issue[] = loaded.issues.filter((issue) => issue.severity === 'warning');
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const studentDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const stored: Array<{ dir: string; result: SubmissionResult }> = [];
  for (const studentId of studentDirs) {
    const result = await readStoredResult(join(outDir, studentId));
    if (result !== null) stored.push({ dir: join(outDir, studentId), result });
  }
  if (stored.length === 0) throw new Error(`no student results found in ${outDir}`);

  if (manual !== undefined) {
    const known = new Set(stored.map(({ result }) => result.student.id));
    for (const studentId of Object.keys(manual)) {
      if (!known.has(studentId)) issues.push({ path: manualFile, message: `manual points for unknown student '${studentId}'`, severity: 'warning' });
    }
  }

  for (const { dir, result } of stored) {
    const studentManual = manual?.[result.student.id];
    result.score = scorer.score(
      {
        assignment: loaded.config,
        buildOk: result.build.ok,
        scenarios: result.scenarios,
        ...(studentManual === undefined ? {} : { manual: studentManual }),
      },
      scorerOptions,
    );
    await writeResultFiles(dir, result, t);
    await writeReport(dir, result, locale, t);
    await writeStudentZip(outDir, result.student.id);
  }

  await writeSummaryCsv(outDir, stored.map(({ result }) => result), (loaded.config.groups ?? []).map((group) => group.id));
  const meta = await readRunMetadata(outDir);
  if (meta !== null) {
    await writeRunMetadata(outDir, {
      ...meta,
      ...(manual === undefined ? {} : { manualFile }),
    });
  }
  return { results: stored.map(({ result }) => result), issues };
}
