import { dirname, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { resolveUserPath } from '../core/paths.ts';
import { HttpError } from './http-error.ts';

export type BrowseMode = 'assignment' | 'submissions';

export interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export async function browse(path: string | undefined, mode: BrowseMode): Promise<BrowseResult> {
  const target = resolveUserPath(path === undefined || path === '' ? process.cwd() : path);
  const info = await stat(target).catch(() => null);
  if (info === null || !info.isDirectory()) throw new HttpError(400, 'not_a_directory', `${target} is not a directory`);

  const entries: BrowseEntry[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory() && !entry.isFile()) continue;
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, path: join(target, entry.name), kind: 'dir' });
    } else if (mode === 'submissions' && entry.name.toLowerCase().endsWith('.zip')) {
      entries.push({ name: entry.name, path: join(target, entry.name), kind: 'file' });
    }
    if (entries.length >= 1000) break;
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  const parent = dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries };
}
