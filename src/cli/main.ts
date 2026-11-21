#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../core/errors.ts';
import { killAllChildren } from '../core/process.ts';
import { killAllSessions } from '../core/session.ts';
import { type StopSignal, beginShutdown } from '../core/shutdown.ts';
import { liveTempDirList, removeAllTempDirs, removePendingAtomicTemps } from '../core/workspace.ts';
import { VERSION } from '../index.ts';
import { type CliIo, type Command, USAGE, UsageError, formatIssue } from './common.ts';
import { checkCommand } from './commands/check.ts';
import { describeCommand } from './commands/describe.ts';
import { rescoreCommand } from './commands/rescore.ts';
import { runCommand } from './commands/run.ts';
import { schemaCommand } from './commands/schema.ts';
import { serveCommand } from './commands/serve.ts';

const COMMANDS: Record<string, Command> = {
  run: runCommand,
  rescore: rescoreCommand,
  check: checkCommand,
  describe: describeCommand,
  schema: schemaCommand,
  serve: serveCommand,
};

/** Duck-typed: errors thrown by node core may come from another realm (e.g. inside Jest's vm context), where `instanceof Error` is false. */
const messageOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error);

/** `parseArgs` failures (unknown flag, missing value, ...) are plain TypeErrors with an `ERR_PARSE_ARGS_*` code. */
const isParseArgsError = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
};

/** Runs the CLI and returns the exit code: 0 ok, 1 invalid assignment / tool error / usage, 2 `--fail-under` not met. */
export async function main(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === '--help' || name === '-h') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (name === '--version' || name === '-v') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (name === undefined) return serveCommand([], io);
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    io.stderr.write(`${name === undefined ? 'error: no command given' : `error: unknown command '${name}'`}\n\n${USAGE}`);
    return 1;
  }
  try {
    return await command(rest, io);
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr.write(`error: ${messageOf(error)}\n\n${USAGE}`);
    } else if (error instanceof ConfigError) {
      for (const issue of error.issues) io.stderr.write(`${formatIssue(issue)}\n`);
      if (error.issues.length === 0) io.stderr.write(`error: ${error.message}\n`);
    } else {
      io.stderr.write(`error: ${messageOf(error)}\n`);
    }
    return 1;
  }
}

/** True when this file is the process entry point; `argv[1]` may be an npm bin symlink, so both sides are resolved. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Ctrl-C / SIGTERM: stop everything the grader started (terminal-session process trees first, then process groups),
 * remove the temp directories of the submissions in flight and exit with 128 + signal number. The run itself stops at the
 * next boundary (`beginShutdown`). A second signal while this is still going on kills again and exits at once. The
 * synchronous `exit` handler is the last resort. Only the direct entry installs this; `main()` itself leaves signals alone.
 */
function installSignalHandlers(): void {
  let stopping = false;
  const stop = (signal: StopSignal, code: number): void => {
    if (stopping) {
      // Escape hatch: cleanup is unbounded (a huge tree, a slow disk), so a repeated signal must not be swallowed.
      killAllChildren();
      removePendingAtomicTemps();
      const dirs = liveTempDirList();
      const shown = dirs.slice(0, 3).join(', ') + (dirs.length > 3 ? ` (+${dirs.length - 3} more)` : '');
      process.stderr.write(`forced exit; temp dirs may remain: ${dirs.length === 0 ? 'none' : shown}\n`);
      process.exit(code);
    }
    stopping = true;
    beginShutdown(signal); // nothing new is started, created or written from here on
    killAllChildren(); // synchronous: PTY trees first, then the process groups
    void (async () => {
      try {
        await killAllSessions(); // anything a dying victim forked meanwhile
        // Test hook (undocumented): makes the cleanup slow so the "second signal" escape hatch can be tested.
        const slowMs = Number(process.env['TUI_GRADE_TEST_SLOW_CLEANUP_MS']);
        if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
        await removeAllTempDirs();
      } finally {
        process.exit(code);
      }
    })();
  };
  process.on('SIGINT', () => stop('SIGINT', 130));
  process.on('SIGTERM', () => stop('SIGTERM', 143));
  if (process.platform === 'win32') process.on('SIGBREAK', () => stop('SIGINT', 130));
  // The dashboard sends this over IPC; Windows has no graceful SIGTERM for a child process.
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'stop') {
      stop('SIGTERM', 143);
    }
  });
  process.on('exit', () => {
    killAllChildren();
    removePendingAtomicTemps(); // a write cut off by the exit must not leave its temp file behind
  });
}

if (isEntryPoint()) {
  const command = process.argv[2];
  // `serve` (and the no-argument default) owns its shutdown: it closes the HTTP server and stops the active child.
  if (command !== undefined && command !== 'serve') installSignalHandlers();
  try {
    process.exitCode = await main(process.argv.slice(2));
  } finally {
    // The dashboard starts this process with an IPC channel for Stop; an open channel keeps Node alive.
    if (process.connected) process.disconnect?.();
  }
}
