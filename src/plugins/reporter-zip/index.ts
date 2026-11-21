import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { fp } from '../../core/plugin.ts';
import { isAtomicTempName, writeFileAtomic } from '../../core/workspace.ts';

const FIXED_DATE = new Date('2000-01-01T00:00:00Z'); // keeps the archive bytes independent of the run time
/** Teacher-only files: they contain hidden-check details and must never reach a student. */
const TEACHER_ONLY = new Set(['results.full.json']);

/** Regular files below `dir` as `/`-separated relative paths, sorted; symlinks and special files are skipped. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  const entries = (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(dir, rel)));
    else if (entry.isFile() && !isAtomicTempName(entry.name) && !TEACHER_ONLY.has(rel)) found.push(rel); // leftover of an interrupted atomic write
  }
  return found;
}

export async function writeStudentZip(outDir: string, studentId: string): Promise<void> {
  const dir = join(outDir, studentId);
  const zipName = `${studentId}-results.zip`;
  const zip = new JSZip();
  for (const rel of await listFiles(dir)) {
    if (rel === zipName) continue; // a previous run's archive
    zip.file(rel, await readFile(join(dir, rel)), { date: FIXED_DATE, createFolders: false });
  }
  await writeFileAtomic(join(dir, zipName), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export const reporterZip = fp(
  (app) => {
    app.reporter('zip', {
      description:
        'Packs everything in <out>/<student>/ (results.json, report.md, build.log, screens/, logs/) into <student>-results.zip; register it after json and markdown.',
      scope: 'submission',
      async reportSubmission(ctx, result) {
        await writeStudentZip(ctx.outDir, result.student.id);
      },
    });
  },
  { name: 'reporter-zip' },
);
