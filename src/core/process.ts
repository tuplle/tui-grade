import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { killTreeSync } from './proctree.ts';
import { isShuttingDown } from './shutdown.ts';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string | 'closed';
  timeoutMs: number;
  outputLimitBytes: number;
}

/**
 * The environment of every student program, plain runs and terminal sessions alike: nothing of the grader's own
 * environment (tokens, `SSH_AUTH_SOCK`, ...) is passed on. `extra` (the scenario's `env`) is added last.
 */
export function minimalEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string> {
  if (process.platform === 'win32') {
    const windir = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows';
    return {
      PATH: process.env['PATH'] ?? `${windir}\\System32`,
      SystemRoot: windir,
      WINDIR: windir,
      ComSpec: process.env['ComSpec'] ?? `${windir}\\System32\\cmd.exe`,
      PATHEXT: process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD',
      TEMP: cwd,
      TMP: cwd,
      HOME: cwd,
      USERPROFILE: cwd,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      ...extra,
    };
  }
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...extra,
  };
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  spawnError?: string;
}

/** Time between SIGTERM and SIGKILL when stopping a process group. */
const KILL_GRACE_MS = 2000;
/** How long to wait for the stdio pipes to close after the process has exited. */
const CLOSE_GRACE_MS = 500;

interface Capture {
  chunks: Buffer[];
  bytes: number;
}

function decode(c: Capture): string {
  // TextDecoder replaces invalid UTF-8 sequences with U+FFFD by default.
  return new TextDecoder('utf-8').decode(Buffer.concat(c.chunks));
}

/** Largest delay `setTimeout` accepts (a bigger one fires immediately). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Process groups of the programs currently run by `runProcess`, and roots of the live PTY sessions. */
const liveGroups = new Set<number>();
const liveRoots = new Set<number>();

export const registerPtyRoot = (pid: number): void => void liveRoots.add(pid);
export const unregisterPtyRoot = (pid: number): void => void liveRoots.delete(pid);
export const livePtyRoots = (): number[] => [...liveRoots];
/** Process group ids of the programs that are running right now. */
export const liveProcessGroups = (): number[] => [...liveGroups];

/**
 * Stops everything that is registered (synchronous, so it may run from an `exit` handler): first the whole process tree
 * of every PTY session, found through its still-living shell (a descendant that moved into a session of its own is
 * re-parented to init once the shell is dead and could no longer be found), then SIGKILL of every process group of
 * `runProcess`. Registered entries are removed by their owners when the processes are reaped.
 */
export function killAllChildren(): void {
  for (const root of [...liveRoots]) killTreeSync(root);
  for (const pid of [...liveGroups]) signalGroup(pid, 'SIGKILL');
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill /T stops the process and its descendants.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone (ESRCH) or not signalable; nothing left to stop.
  }
}

/**
 * Runs untrusted code in its own process group with a minimal environment, a wall-clock
 * timeout and a per-stream output cap. Never rejects: every failure is reported in the result.
 */
export function runProcess(o: ProcessOptions): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    const started = Date.now();
    const out: Capture = { chunks: [], bytes: 0 };
    const err: Capture = { chunks: [], bytes: 0 };
    let timedOut = false;
    let truncated = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let done = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    const finish = (spawnError?: string): void => {
      if (done) return;
      done = true;
      if (child?.pid !== undefined) liveGroups.delete(child.pid);
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      const result: ProcessResult = {
        stdout: decode(out),
        stderr: decode(err),
        exitCode,
        signal: exitSignal,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      };
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolve(result);
    };

    const terminate = (): void => {
      if (killTimer !== undefined) return;
      signalGroup(child?.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child?.pid, 'SIGKILL'), KILL_GRACE_MS);
    };

    const collect = (c: Capture) => (chunk: Buffer): void => {
      if (done || truncated) return;
      const room = o.outputLimitBytes - c.bytes;
      if (chunk.length <= room) {
        c.chunks.push(chunk);
        c.bytes += chunk.length;
        return;
      }
      if (room > 0) {
        c.chunks.push(chunk.subarray(0, room));
        c.bytes += room;
      }
      truncated = true;
      terminate();
    };

    if (isShuttingDown()) {
      finish('the grader is shutting down');
      return;
    }
    try {
      child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: minimalEnv(o.cwd, o.env),
        // POSIX process groups allow a whole-run kill; Windows uses taskkill /T instead.
        detached: process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(e instanceof Error ? e.message : String(e));
      return;
    }

    if (child.pid !== undefined) liveGroups.add(child.pid);

    child.on('error', (e) => {
      // Spawn failures (ENOENT, bad cwd, ...) never produce a pid; later errors are ignored.
      if (child?.pid === undefined) finish(e.message);
    });

    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => {}); // EPIPE when the program stops reading early
      if (o.stdin !== undefined && o.stdin !== 'closed') stdin.end(o.stdin);
      else stdin.end();
    }

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // A program that exited by itself is not a timeout, even when the pipes stay open a little longer.
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      // Anything the program left behind in its group (background jobs, daemons) is stopped now.
      signalGroup(child?.pid, 'SIGKILL');
      closeTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish();
      }, CLOSE_GRACE_MS);
    });
    child.on('close', () => finish());

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Number.isFinite(o.timeoutMs) ? Math.min(o.timeoutMs, MAX_TIMER_MS) : MAX_TIMER_MS);
  });
}
