import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { writeFileAtomic } from '../core/workspace.ts';
import { HttpError } from './http-error.ts';
import { readHeader, validId, type RunHeader } from './results.ts';

export async function runDir(resultsRoot: string, id: string): Promise<string> {
  if (!validId(id)) throw new HttpError(400, 'invalid_run_id', 'Invalid run id');
  return join(resultsRoot, id);
}

export async function listRuns(resultsRoot: string, limit = 50): Promise<RunHeader[]> {
  const entries = await readdir(resultsRoot, { withFileTypes: true }).catch(() => []);
  const found: RunHeader[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const header = await readHeader(join(resultsRoot, entry.name), entry.name);
    if (header !== null) found.push(header);
    if (found.length >= limit) break;
  }
  found.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return found;
}

export async function loadRun(resultsRoot: string, id: string): Promise<RunHeader> {
  const header = await readHeader(await runDir(resultsRoot, id), id);
  if (header === null) throw new HttpError(404, 'run_not_found', `Run '${id}' not found`);
  return header;
}

export async function writeManual(outDir: string, points: Record<string, Record<string, number>>): Promise<void> {
  await writeFileAtomic(join(outDir, 'manual.yaml'), stringify(points));
}
