// Shared plumbing of the CLI commands.
import type { Issue } from '../core/contracts.ts';
import { stripControl } from '../core/text.ts';

export interface Writer {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout: Writer;
  stderr: Writer;
  cwd?: string; // base for relative paths and the default output directory (default: process.cwd())
}

/** Wrong command line: the message is printed together with the usage text; exit code 1. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE = `Usage:
  tui-grade run <assignment-dir> <path> [--out dir] [--only id,id] [--locale sk|en]
                [--manual file] [--keep-workdirs] [--fail-under N] [--events]
  tui-grade rescore <assignment-dir> <out-dir> [--manual file] [--locale sk|en]
  tui-grade check <assignment-dir> [--json] [--list]
  tui-grade describe [assignment-dir] [--json]
  tui-grade schema [assignment-dir]
  tui-grade serve [--port N] [--results-root dir] [--assignment dir] [--submissions path] [--no-open]
  tui-grade --version

Commands:
  (none)     Start the localhost web dashboard and open it in the default browser.
  serve      Start the localhost web dashboard explicitly.
  run        Grade every submission found at <path> (a folder of submissions, one folder, or a .zip).
  rescore    Recompute points and reports from an existing run; no build and no student program is started.
  check      Validate an assignment without starting any student program or build.
  describe   List the steps, checks, builders, reporters and scorers with parameters and examples.
  schema     Print a JSON Schema of a scenario file (and of assignment.yaml under $defs).

Exit codes: 0 ok; 1 invalid assignment, tool error or bad usage; 2 --fail-under not met.
`;

/** `path: message` for errors, `path: warning: message` for warnings. */
export const formatIssue = (issue: Issue): string =>
  stripControl(issue.severity === 'warning' ? `${issue.path}: warning: ${issue.message}` : `${issue.path}: ${issue.message}`);

export const printIssues = (io: CliIo, issues: Issue[]): void => {
  for (const issue of issues) io.stderr.write(`${formatIssue(issue)}\n`);
};

export interface Command {
  (args: string[], io: CliIo): Promise<number>;
}

/** Exactly `min`..`max` positionals, otherwise a usage error naming the command. */
export function positionalArgs(command: string, positionals: string[], min: number, max: number): string[] {
  if (positionals.length < min || positionals.length > max) {
    const wanted = min === max ? `${min}` : `${min} to ${max}`;
    throw new UsageError(`'${command}' takes ${wanted} positional argument${max === 1 ? '' : 's'}, got ${positionals.length}`);
  }
  return positionals;
}
