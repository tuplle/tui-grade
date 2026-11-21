import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubmissionResult } from '../core/contracts.ts';
import { loadManualPoints } from '../core/manual.ts';
import { readRunMetadata, type RunMetadata } from '../core/run-meta.ts';
import { safeJoin } from '../core/workspace.ts';
import { FULL_RESULT_FILE, RESULT_FILE } from '../plugins/reporter-json/index.ts';
import { HttpError } from './http-error.ts';

const ID = /^[A-Za-z0-9._-]+$/;
const ARTIFACT_LIMIT = 2 * 1024 * 1024;

export const validId = (id: string): boolean => id !== '.' && id !== '..' && ID.test(id);

export interface StudentRow {
  studentId: string;
  displayName: string;
  points: number;
  max: number;
}

export interface RunHeader {
  id: string;
  outDir: string;
  assignment: string;
  startedAt: string;
  locale: string;
  manualFile?: string;
  completed: boolean;
  students: StudentRow[];
}

export async function readStudentResult(outDir: string, studentId: string): Promise<SubmissionResult | null> {
  if (!validId(studentId)) throw new HttpError(400, 'invalid_student_id', 'Invalid student id');
  for (const name of [FULL_RESULT_FILE, RESULT_FILE]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(outDir, studentId, name), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as SubmissionResult;
    } catch {
      // Fall back to the student-facing result (older runs).
    }
  }
  return null;
}

export async function listStudents(outDir: string): Promise<SubmissionResult[]> {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const results: SubmissionResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const result = await readStudentResult(outDir, entry.name);
    if (result !== null) results.push(result);
  }
  results.sort((a, b) => a.student.id.localeCompare(b.student.id));
  return results;
}

export function rows(results: SubmissionResult[]): StudentRow[] {
  return results.map((result) => ({
    studentId: result.student.id,
    displayName: result.student.displayName,
    points: result.score.points,
    max: result.score.max,
  }));
}

export async function readHeader(outDir: string, id: string): Promise<RunHeader | null> {
  const meta: RunMetadata | null = await readRunMetadata(outDir);
  const results = await listStudents(outDir);
  if (meta === null && results.length === 0) return null;
  const first = results[0];
  return {
    id,
    outDir,
    assignment: meta?.assignment ?? first?.assignment ?? id,
    startedAt: meta?.startedAt ?? first?.startedAt ?? id,
    locale: meta?.locale ?? first?.locale ?? 'en',
    ...(meta?.manualFile === undefined ? {} : { manualFile: meta.manualFile }),
    completed: await readFile(join(outDir, 'summary.csv'), 'utf8').then(
      () => true,
      () => false,
    ),
    students: rows(results),
  };
}

export async function readArtifact(outDir: string, studentId: string, rel: string): Promise<string> {
  const result = await readStudentResult(outDir, studentId);
  if (result === null) throw new HttpError(404, 'result_not_found', 'Student result not found');
  const allowed = new Set<string>(['build.log', ...result.scenarios.flatMap((scenario) => scenario.artifacts)]);
  if (!allowed.has(rel)) throw new HttpError(404, 'artifact_not_found', 'Artifact not found');
  const path = safeJoin(join(outDir, studentId), rel);
  const data = await readFile(path).catch(() => null);
  if (data === null) throw new HttpError(404, 'artifact_not_found', 'Artifact not found');
  if (data.length > ARTIFACT_LIMIT) throw new HttpError(413, 'artifact_too_large', 'Artifact is too large to display');
  return data.toString('utf8');
}

export async function readManual(outDir: string): Promise<Record<string, Record<string, number>>> {
  const file = join(outDir, 'manual.yaml');
  return readFile(file, 'utf8').then(
    () => loadManualPoints(file),
    () => ({}),
  );
}
