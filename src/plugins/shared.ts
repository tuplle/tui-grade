// Helpers shared by the basic steps and checks.
import { access, lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { CheckOutcome, ScenarioContext } from '../core/contracts.ts';
import { normalizeText, safeJoin } from '../core/workspace.ts';

/** Imports `rel` (relative to the assignment directory) and returns its default export, which must be a function. */
export async function loadScript(assignmentDir: string, rel: string): Promise<(...args: any[]) => unknown> {
  const file = safeJoin(assignmentDir, rel);
  try {
    await access(file);
  } catch {
    throw new Error(`script not found: ${rel}`);
  }
  const mod: unknown = await import(pathToFileURL(file).href);
  const fn = (mod as { default?: unknown }).default;
  if (typeof fn !== 'function') throw new Error(`script '${rel}' must have a default export that is a function`);
  return fn as (...args: any[]) => unknown;
}

/**
 * Resolves a scenario path (after `${...}` interpolation) inside the workdir. An absolute result, as
 * produced by `${workdir}/x`, is accepted when it points into the workdir; `ctx.resolvePath` throws on escape.
 */
export function workdirPath(ctx: ScenarioContext, raw: string): string {
  const path = ctx.interpolate(raw);
  return ctx.resolvePath(isAbsolute(path) ? relative(ctx.workdir, path) : path);
}

/**
 * Reads a student-created file as normalized text, or returns a failure outcome. The file is
 * `lstat`ed first (never opened, so a FIFO cannot block; symlinks are not followed), must be a regular
 * file and no larger than `limitBytes`, so the read is bounded.
 */
export async function readGuardedText(
  absPath: string,
  label: string,
  limitBytes: number,
): Promise<{ text: string } | { failure: CheckOutcome }> {
  const info = await lstat(absPath).catch(() => undefined);
  if (info === undefined) return { failure: { pass: false, message: `file not found: ${label}` } };
  if (!info.isFile()) return { failure: { pass: false, message: `not a regular file: ${label}` } };
  if (info.size > limitBytes) {
    return { failure: { pass: false, message: `file '${label}' is too large to check (${info.size} bytes, limit ${limitBytes})` } };
  }
  try {
    return { text: normalizeText(await readFile(absPath, 'utf8')) };
  } catch {
    return { failure: { pass: false, message: `file not readable: ${label}` } };
  }
}

// ---- text matching (shared by the stdout/stderr and screen checks) --------------------------

const MAX_ACTUAL_CHARS = 1000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Shortens `actual` values shown in check results. */
export const clip = (s: string): string => (s.length > MAX_ACTUAL_CHARS ? `${s.slice(0, MAX_ACTUAL_CHARS)}…` : s);

const textOptions = { ignore_case: z.boolean().optional(), fold_diacritics: z.boolean().optional() };
export const containsParams = z.union([z.string(), z.strictObject({ text: z.string(), ...textOptions })]);
export const matchesParams = z.union([
  z.string(),
  z.strictObject({ pattern: z.string(), flags: z.string().optional(), ...textOptions }),
]);

export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '');

export interface TextOptions {
  ignoreCase: boolean;
  foldDiacritics: boolean;
}
/** Prepares both sides of a comparison: NFD + strip marks, then lowercase, as requested. */
export const prepare = (s: string, o: TextOptions): string => {
  const folded = o.foldDiacritics ? fold(s) : s;
  return o.ignoreCase ? folded.toLowerCase() : folded;
};
const optionsOf = (p: { ignore_case?: boolean | undefined; fold_diacritics?: boolean | undefined }): TextOptions => ({
  ignoreCase: p.ignore_case === true,
  foldDiacritics: p.fold_diacritics === true,
});

export function containsOf(p: z.output<typeof containsParams>): { text: string } & TextOptions {
  return typeof p === 'string' ? { text: p, ignoreCase: false, foldDiacritics: false } : { text: p.text, ...optionsOf(p) };
}
export function matchesOf(p: z.output<typeof matchesParams>): { pattern: string; flags: string } & TextOptions {
  if (typeof p === 'string') return { pattern: p, flags: '', ignoreCase: false, foldDiacritics: false };
  return { pattern: p.pattern, flags: p.flags ?? '', ...optionsOf(p) };
}

/** Compiles the pattern; the error message is the JS engine's, prefixed so it reads clearly. */
export function compile(m: ReturnType<typeof matchesOf>): RegExp | string {
  const flags = m.ignoreCase && !m.flags.includes('i') ? `${m.flags}i` : m.flags;
  try {
    return new RegExp(m.foldDiacritics ? fold(m.pattern) : m.pattern, flags);
  } catch (e) {
    return `invalid regular expression: ${messageOf(e)}`;
  }
}

