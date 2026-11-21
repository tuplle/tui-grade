import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import JSZip from 'jszip';
import { PathEscapeError, safeJoin } from './workspace.ts';

/** A ZIP that is corrupt, exceeds the configured limits, or cannot be extracted. */
export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipLimits {
  maxBytes: number;
  maxFiles: number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

/** Minimal view of jszip's (untyped) internal stream: chunks arrive via 'data', backpressure via pause/resume. */
interface ZipStream {
  on(event: 'data', fn: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'end', fn: () => void): ZipStream;
  on(event: 'error', fn: (err: unknown) => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}
type StreamableEntry = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): ZipStream;
  _data?: { uncompressedSize?: number };
};

/** Splits an entry name into path segments, treating backslashes as separators. */
const segmentsOf = (rawName: string): string[] =>
  rawName
    .replaceAll('\\', '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');

/** True when the entry name is absolute, contains `..` or a NUL, i.e. could only ever be an escape attempt. */
function isHostileName(rawName: string, segments: string[]): boolean {
  return (
    rawName.includes('\0') ||
    /^(?:[/\\]|[A-Za-z]:)/.test(rawName) ||
    segments.includes('..')
  );
}

const isIgnoredSegment = (segments: string[]): boolean =>
  segments.includes('__MACOSX') || segments.includes('.git');

interface Planned {
  entry: StreamableEntry;
  target: string;
  declared: number;
}

/**
 * Inflates one entry into `target`, aborting as soon as `budget` bytes would be exceeded, no matter what the
 * archive header claims. Resolves with the number of bytes written.
 */
function inflateToFile(entry: StreamableEntry, target: string, budget: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('uint8array');
    const out = createWriteStream(target, { flags: 'wx' }); // 'wx': never write through an existing file or link
    let written = 0;
    let settled = false;
    let waitingForDrain = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      out.destroy();
      reject(err instanceof ZipError ? err : new ZipError(`cannot extract "${entry.name}": ${String(err)}`));
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      written += chunk.length;
      if (written > budget) {
        fail(new ZipError(`archive exceeds maxBytes while inflating "${entry.name}"`));
        return;
      }
      if (!out.write(chunk) && !waitingForDrain) {
        // jszip may still deliver a few queued chunks after pause(); wait for a single drain only.
        waitingForDrain = true;
        stream.pause();
        out.once('drain', () => {
          waitingForDrain = false;
          if (!settled) stream.resume();
        });
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve(written);
      });
    });
    out.on('error', fail);
    stream.resume();
  });
}

/**
 * Extracts `zipPath` into `destDir`. Entries with escaping/absolute names and symlink or special-file entries are
 * skipped and listed in `skipped`; `__MACOSX/` and `.git/` entries are ignored silently. `maxFiles` and `maxBytes`
 * are checked against the declared sizes before anything is written and again against the bytes actually inflated.
 * On failure, files extracted so far stay in `destDir`; the caller owns (and removes) it.
 */
export async function extractZipSafe(
  zipPath: string,
  destDir: string,
  limits: ZipLimits,
): Promise<{ files: number; bytes: number; skipped: string[] }> {
  let zip: JSZip;
  try {
    zip = await new JSZip().loadAsync(await readFile(zipPath));
  } catch (err) {
    throw new ZipError(`cannot read ZIP archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const skipped: string[] = [];
  const planned: Planned[] = [];
  let declaredBytes = 0;
  await mkdir(destDir, { recursive: true });

  for (const entry of Object.values(zip.files) as StreamableEntry[]) {
    // jszip rewrites `../` names on load; the original name is what a naive extractor would have used.
    const rawName = entry.unsafeOriginalName ?? entry.name;
    const segments = segmentsOf(rawName);
    if (isHostileName(rawName, segments)) {
      skipped.push(rawName);
      continue;
    }
    if (entry.dir || segments.length === 0 || isIgnoredSegment(segments)) continue;

    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : null;
    if (mode !== null && (mode & S_IFMT) !== 0 && (mode & S_IFMT) !== S_IFREG) {
      skipped.push(rawName); // symlink (S_IFLNK) or device/fifo/socket
      continue;
    }

    let target: string;
    try {
      target = safeJoin(destDir, segments.join('/'));
    } catch (err) {
      if (!(err instanceof PathEscapeError)) throw err;
      skipped.push(rawName);
      continue;
    }

    const declared = entry._data?.uncompressedSize ?? 0;
    planned.push({ entry, target, declared });
    declaredBytes += declared;
    if (planned.length > limits.maxFiles) {
      throw new ZipError(`archive has more than maxFiles (${limits.maxFiles}) files`);
    }
    if (declaredBytes > limits.maxBytes) {
      throw new ZipError(`archive declares more than maxBytes (${limits.maxBytes}) of data`);
    }
  }

  let bytes = 0;
  for (const { entry, target } of planned) {
    await mkdir(dirname(target), { recursive: true });
    bytes += await inflateToFile(entry, target, limits.maxBytes - bytes);
  }
  return { files: planned.length, bytes, skipped };
}
