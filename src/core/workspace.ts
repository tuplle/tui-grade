import { randomBytes } from 'node:crypto';
import { type Stats, lstatSync, realpathSync, rmSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isShuttingDown } from './shutdown.ts';

/** A relative path resolved outside of its root directory. */
export class PathEscapeError extends Error {
  override name = 'PathEscapeError';
}

/** Temp directories created by `createTempDir` and not removed yet, so a signal handler can clean up after an abort. */
const liveTempDirs = new Set<string>();

/** Creates a temp directory and registers it for `removeAllTempDirs`; `removeDir` (or `unregisterTempDir`) releases it. */
export async function createTempDir(prefix: string): Promise<string> {
  if (isShuttingDown()) throw new Error('the grader is shutting down');
  const dir = await mkdtemp(join(tmpdir(), prefix));
  liveTempDirs.add(dir);
  return dir;
}

/** Forgets a temp directory that is meant to survive (`--keep-workdirs`). */
export function unregisterTempDir(dir: string): void {
  liveTempDirs.delete(dir);
}

/** The temp directories that are still registered. */
export function liveTempDirList(): string[] {
  return [...liveTempDirs];
}

/** Removes every registered temp directory; failures are ignored (best effort, used while aborting). */
export async function removeAllTempDirs(): Promise<void> {
  await Promise.all(
    [...liveTempDirs].map(async (dir) => {
      try {
        await removeDir(dir);
      } catch {
        // nothing more can be done while shutting down
      }
    }),
  );
}

/** Temp files of `writeFileAtomic` calls that are still in flight, so an abort can remove them synchronously. */
const pendingAtomicTemps = new Set<string>();

/** `.<name>.<pid>.<random hex>.tmp`: the temp name `writeFileAtomic` gives its file (a SIGKILL can leave one behind). */
const ATOMIC_TEMP_NAME = /^\..+\.\d+\.[0-9a-f]+\.tmp$/;
export const isAtomicTempName = (name: string): boolean => ATOMIC_TEMP_NAME.test(name);

/**
 * Writes `data` to `path` so that the final name never holds a partial file: the data goes to a temp file next to the
 * target (same directory, same filesystem) and is renamed over it. On failure the temp file is removed.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  pendingAtomicTemps.add(tmp);
  try {
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  } finally {
    pendingAtomicTemps.delete(tmp);
  }
}

/** Removes the temp files of unfinished `writeFileAtomic` calls (synchronous: used when the process is about to exit). */
export function removePendingAtomicTemps(): void {
  for (const tmp of [...pendingAtomicTemps]) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

export interface CopyDirOptions {
  /** Return false to skip an entry (and, for a directory, everything below it). `stats` come from `lstat`. */
  filter?(srcPath: string, stats: Stats): boolean;
}

export async function copyDir(src: string, dest: string, opts: CopyDirOptions = {}): Promise<void> {
  await mkdir(dest, { recursive: true });
  const { filter } = opts;
  await cp(src, dest, {
    recursive: true,
    ...(filter && { filter: async (srcPath: string) => filter(srcPath, await lstat(srcPath)) }),
  });
}

/** `u+rwx` on every directory below `path` (parents first, symlinks skipped), so that read-only leftovers can be removed. */
async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return; // files are removed through their (writable) directory
  await chmod(path, info.mode | 0o700).catch(() => {});
  const names = await readdir(path).catch(() => [] as string[]);
  for (const name of names) await makeWritable(join(path, name));
}

const isPermissionError = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'EACCES' || code === 'EPERM';
};

/**
 * Removes a directory tree. A student's program may leave read-only directories behind (`chmod 500 d`);
 * when `rm` fails on permissions the tree is made writable and removal is retried once.
 */
export async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true });
  }
  liveTempDirs.delete(dir);
}

const isInside = (base: string, target: string): boolean => {
  const back = relative(base, target);
  return !(back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back));
};

/**
 * Resolves symlinks in the deepest existing ancestor of `path` and re-appends the non-existent tail.
 * A symlink that exists but cannot be resolved (dangling) is reported as an escape: it could be
 * retargeted later and its destination cannot be verified.
 */
function realPathOfDeepestExisting(path: string, rel: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    let exists = true;
    try {
      lstatSync(current);
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        throw new PathEscapeError(`path escapes its root (unresolvable link): ${rel}`);
      }
      return join(real, ...tail.reverse());
    }
    const parent = dirname(current);
    if (parent === current) return path; // nothing on the way exists, not even the filesystem root
    tail.push(basename(current));
    current = parent;
  }
}

/**
 * Joins `rel` onto `root`, throwing when the result is not inside `root`. Besides the lexical check,
 * symlinks that already exist on disk (for example created by a student's program) are resolved,
 * so a link pointing outside the root cannot be used to escape it. Returns the lexical path.
 */
export function safeJoin(root: string, rel: string): string {
  const base = resolve(root);
  const target = resolve(base, rel);
  if (isAbsolute(rel) || !isInside(base, target)) {
    throw new PathEscapeError(`path escapes its root: ${rel}`);
  }
  const realBase = realPathOfDeepestExisting(base, rel);
  const realTarget = realPathOfDeepestExisting(target, rel);
  if (!isInside(realBase, realTarget)) {
    throw new PathEscapeError(`path escapes its root through a symlink: ${rel}`);
  }
  return target;
}

// CSI sequences, OSC sequences (BEL or ST terminated) and other two-byte escapes.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** CRLF/CR → LF and removes ANSI escape sequences. */
export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(ANSI, '');
}
