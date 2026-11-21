// Helpers for turning parser and schema failures into `Issue`s.
import type { z } from 'zod';
import type { Issue } from './contracts.ts';

/** Joins a `file#/pointer` base and a relative pointer (`''`, `'/a/b'` or `'a/b'`). */
export function joinPointer(base: string, sub: string): string {
  if (sub === '' || sub === '/') return base;
  return sub.startsWith('/') ? base + sub : `${base}/${sub}`;
}

/** One error `Issue` per zod problem; the zod path is appended to `base` as a JSON pointer. */
export function zodIssues(error: z.ZodError, base: string): Issue[] {
  const issues: Issue[] = [];
  for (const problem of error.issues) {
    const path = problem.path.map(String);
    if (problem.code === 'unrecognized_keys') {
      for (const key of problem.keys) {
        issues.push({ path: joinPointer(base, [...path, key].join('/')), message: `unknown key '${key}'`, severity: 'error' });
      }
      continue;
    }
    issues.push({ path: joinPointer(base, path.join('/')), message: problem.message, severity: 'error' });
  }
  return issues;
}
