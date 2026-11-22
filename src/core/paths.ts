// Path helpers for CLI flags and environment overrides. Shells expand an unquoted `~` only at the start of a word,
// so `--out=~/runs`, quoted paths and `TUI_GRADE_DATA_DIR=~/runs` reach the CLI literally.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Expands a leading `~`, `~/` or `~\` to `home`; every other path is returned unchanged. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

/** Expands `~` and resolves the path against `cwd`, like an unquoted shell argument would. */
export function resolveUserPath(path: string, cwd: string = process.cwd(), home: string = homedir()): string {
  return resolve(cwd, expandHome(path, home));
}
