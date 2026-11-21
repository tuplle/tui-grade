// Teacher-side metadata for a run directory; never packed into a student's results ZIP.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './workspace.ts';

export const RUN_META_FILE = 'run.json';

export interface RunMetadata {
  schemaVersion: 1;
  assignment: string;
  assignmentDir: string;
  inputPath: string;
  outDir: string;
  startedAt: string;
  locale: string;
  version: string;
  manualFile?: string;
}

export async function writeRunMetadata(outDir: string, meta: RunMetadata): Promise<void> {
  await writeFileAtomic(join(outDir, RUN_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Missing or malformed metadata is not an error: older runs simply have less context. */
export async function readRunMetadata(outDir: string): Promise<RunMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(outDir, RUN_META_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RunMetadata;
  } catch {
    return null;
  }
}
