import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { AssignmentConfig, Submission } from './contracts.ts';
import { stripControl } from './text.ts';
import { copyDir, createTempDir, removeDir, safeJoin } from './workspace.ts';
import { extractZipSafe } from './zip.ts';

export type { Submission } from './contracts.ts';

// Accepts explicit `undefined` values (the brief's example passes `strip_prefix: undefined`).
type StudentIdConfig = { pattern?: string | undefined; strip_prefix?: string | undefined } | undefined;

/** Directory names that are never part of a submission (VCS data, macOS resource forks). */
const JUNK_DIRS = new Set(['.git', '__MACOSX']);

/** Entries of a container directory that are not submissions. */
const isIgnoredChild = (name: string): boolean =>
  name.startsWith('.') || name === '__MACOSX' || name === 'grading-results' || /\.csv$/i.test(name);

const isZipName = (name: string): boolean => /\.zip$/i.test(name);

/** Longest student id; keeps `<id>-results.zip` far below the 255-byte file name limit. */
const MAX_ID_LENGTH = 100;

/** Names the reporters create at the top level of the output directory (compared case-insensitively). */
const RESERVED_IDS = new Set(['summary.csv']);
/** Windows device names cannot be used as a file or directory name. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Filesystem-safe id: diacritics transliterated (NFD, combining marks stripped), only `[A-Za-z0-9._-]` kept, at most
 * `MAX_ID_LENGTH` characters, and never the name of a top-level output file (`summary.csv` gets a `_` appended).
 */
function sanitizeId(raw: string): string {
  let id = raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/_+$/, '')
    .replace(/[. ]+$/, '')
    .slice(0, MAX_ID_LENGTH);
  if (id === '') id = 'submission';
  if (RESERVED_IDS.has(id.toLowerCase()) || WINDOWS_RESERVED.test(id)) id = `${id}_`;
  return id;
}

/**
 * Derives the student id from a submission name (file or folder name). With a `pattern` the named groups become
 * `parts`; the id is the `id` group, else the `login` group, else the sanitized name (empty groups count as missing).
 * The display name is "<surname> <name>" when those groups exist, else the NFC-normalized name. Invalid patterns
 * never match; `matched` is false when a pattern is configured and did not match (always true without a pattern).
 */
export function parseStudentId(
  name: string,
  cfg: StudentIdConfig,
): { id: string; displayName: string; parts: Record<string, string>; matched: boolean } {
  let candidate = name.normalize('NFC');
  const prefix = cfg?.strip_prefix;
  if (prefix && candidate.startsWith(prefix)) candidate = candidate.slice(prefix.length);
  const plain = candidate.replace(/\.zip$/i, '');

  const parts: Record<string, string> = {};
  let matched = true;
  if (cfg?.pattern) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(cfg.pattern, 'u');
    } catch {
      re = undefined;
    }
    const m = re && (re.exec(candidate) ?? (plain === candidate ? null : re.exec(plain)));
    matched = !!m;
    for (const [key, value] of Object.entries(m?.groups ?? {})) {
      if (value !== undefined) parts[key] = value.normalize('NFC');
    }
  }

  const person = [parts.surname, parts.name].filter((p): p is string => !!p).join(' ');
  return {
    id: sanitizeId(parts.id || parts.login || plain),
    displayName: person || plain,
    parts,
    matched,
  };
}

/** True when `<dir>/<marker>` exists as a regular entry reachable without leaving `dir` through a symlink. */
async function hasMarker(dir: string, marker: string): Promise<boolean> {
  try {
    const target = safeJoin(dir, marker);
    return !(await lstat(target)).isSymbolicLink();
  } catch {
    return false; // missing, unreadable, or escaping through a symlink (PathEscapeError)
  }
}

/**
 * Shallowest directory (searching breadth-first, alphabetically within a depth) that contains `marker`;
 * `dir` itself is depth 0. Symlinked directories, `.git` and `__MACOSX` are not entered.
 */
export async function findProjectRoot(dir: string, marker: string, maxDepth: number): Promise<string | null> {
  let level = [resolve(dir)];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    for (const candidate of level) {
      if (await hasMarker(candidate, marker)) return candidate;
    }
    if (depth === maxDepth) break;
    const next: string[] = [];
    for (const candidate of level) {
      let entries;
      try {
        entries = await readdir(candidate, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = entries
        .filter((e) => e.isDirectory() && !JUNK_DIRS.has(e.name))
        .map((e) => e.name)
        .sort();
      for (const n of names) next.push(join(candidate, n));
    }
    level = next;
  }
  return null;
}

/** Prepares the work directory of one submission; never throws (problems become warnings, `root: null`). */
async function prepare(sourcePath: string, kind: 'dir' | 'zip', cfg: AssignmentConfig): Promise<Submission> {
  const name = basename(sourcePath);
  let parsed: ReturnType<typeof parseStudentId>;
  const warnings: string[] = [];
  try {
    parsed = parseStudentId(name, cfg.student_id);
    if (!parsed.matched) warnings.push(`student id pattern did not match "${stripControl(name)}"`);
  } catch (err) {
    parsed = parseStudentId(name, undefined);
    warnings.push(`cannot derive student id from "${stripControl(name)}": ${errorMessage(err)}`);
  }
  const { matched: _matched, ...ident } = parsed;
  const workDir = await createTempDir('tui-grade-sub-');
  const submission: Submission = { ...ident, sourcePath, kind, workDir, root: null, warnings };

  try {
    if (kind === 'zip') {
      const { skipped } = await extractZipSafe(sourcePath, workDir, {
        maxBytes: cfg.limits.unzip_max_bytes,
        maxFiles: cfg.limits.unzip_max_files,
      });
      for (const entry of skipped) warnings.push(`skipped unsafe ZIP entry: ${stripControl(entry)}`);
    } else {
      const src = await realpath(sourcePath);
      await copyDir(src, workDir, {
        filter(path, stats) {
          if (stats.isSymbolicLink()) {
            warnings.push(`skipped symlink: ${stripControl(relative(src, path))}`);
            return false;
          }
          return !(stats.isDirectory() && JUNK_DIRS.has(basename(path)));
        },
      });
    }
  } catch (err) {
    warnings.push(`cannot prepare ${kind === 'zip' ? 'ZIP archive' : 'directory'}: ${errorMessage(err)}`);
    return submission;
  }

  submission.root = await findProjectRoot(workDir, cfg.project_root_marker, cfg.project_root_depth);
  if (submission.root === null) {
    warnings.push(
      `project root not found: no "${cfg.project_root_marker}" within depth ${cfg.project_root_depth}`,
    );
  }
  return submission;
}

const errorMessage = (err: unknown): string => stripControl(err instanceof Error ? err.message : String(err));

/** Gives duplicate ids a `-2`, `-3`, … suffix and warns on every submission involved. */
function dedupeIds(subs: Submission[]): void {
  const groups = new Map<string, Submission[]>();
  for (const s of subs) groups.set(s.id, [...(groups.get(s.id) ?? []), s]);
  const taken = new Set(subs.map((s) => s.id));
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const sources = group.map((s) => stripControl(basename(s.sourcePath))).join(', ');
    group.forEach((s, i) => {
      if (i === 0) {
        s.warnings.push(`duplicate student id "${id}" shared by ${group.length} submissions (${sources})`);
        return;
      }
      let n = i + 1;
      while (taken.has(`${id}-${n}`)) n++;
      s.id = `${id}-${n}`;
      taken.add(s.id);
      s.warnings.push(`duplicate student id "${id}" (${sources}); renamed to "${s.id}"`);
    });
  }
}

/**
 * Finds the submissions under `inputPath` and prepares a temp work directory for each. A `.zip` file, or a
 * directory that itself contains the project marker, is a single submission; otherwise every child directory
 * and `.zip` is one (dot-names, `__MACOSX`, `grading-results` and `*.csv` are ignored; symlinked children too).
 * Throws only when `inputPath` itself is unusable.
 */
export async function discoverSubmissions(inputPath: string, cfg: AssignmentConfig): Promise<Submission[]> {
  const input = resolve(inputPath);
  const info = await stat(input).catch(() => null);
  if (!info) throw new Error(`input path does not exist: ${input}`);

  let sources: Array<{ path: string; kind: 'dir' | 'zip' }>;
  if (info.isFile()) {
    if (!isZipName(input)) throw new Error(`input file is not a .zip archive: ${input}`);
    sources = [{ path: input, kind: 'zip' }];
  } else if (info.isDirectory()) {
    if (await findProjectRoot(input, cfg.project_root_marker, 0)) {
      sources = [{ path: input, kind: 'dir' }];
    } else {
      const entries = await readdir(input, { withFileTypes: true });
      sources = [];
      for (const e of entries.filter((d) => !isIgnoredChild(d.name))) {
        // Dirent type is from lstat, so symlinked children are neither directories nor files here.
        if (e.isDirectory()) sources.push({ path: join(input, e.name), kind: 'dir' });
        else if (e.isFile() && isZipName(e.name)) sources.push({ path: join(input, e.name), kind: 'zip' });
      }
      sources.sort((a, b) => (basename(a.path) < basename(b.path) ? -1 : 1));
    }
  } else {
    throw new Error(`input path is neither a file nor a directory: ${input}`);
  }

  const subs: Submission[] = [];
  for (const { path, kind } of sources) subs.push(await prepare(path, kind, cfg));
  dedupeIds(subs);
  return subs;
}

export async function cleanupSubmission(s: Submission): Promise<void> {
  await removeDir(s.workDir);
}
