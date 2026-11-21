// Process tree of a PTY session. Linux reads /proc, macOS uses ps, Windows uses taskkill /T.
// One implementation of the walk, an async and a sync call style: the sync one is for the `exit` handler and the
// first reaction to Ctrl-C, where nothing can be awaited.
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface ProcInfo {
  ppid: number;
  pgid: number;
  sid: number;
  zombie: boolean;
}

/** How many times the tree is walked and killed again (a victim may fork while it is being killed). */
const MAX_ROUNDS = 8;
/** Pause between two rounds, so killed processes can turn into zombies. */
const ROUND_PAUSE_MS = 10;

const IS_WINDOWS = process.platform === 'win32';
const IS_DARWIN = process.platform === 'darwin';
const run = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** "pid (comm) state ppid pgrp session ..." where comm may itself contain spaces and parentheses. */
function parseLinuxStat(stat: string): ProcInfo | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const [state, ppid, pgid, sid] = [fields[0], Number(fields[1]), Number(fields[2]), Number(fields[3])];
  if (Number.isNaN(ppid) || Number.isNaN(pgid) || Number.isNaN(sid)) return undefined;
  return { ppid, pgid, sid, zombie: state === 'Z' };
}

const isPid = (name: string): boolean => /^\d+$/.test(name);

/** Reads pid → (ppid, pgid, sid) for every process. Linux uses /proc; macOS uses ps. Windows has no table. */
export async function processTable(): Promise<Map<number, ProcInfo>> {
  if (IS_WINDOWS) return new Map();
  if (IS_DARWIN) {
    try {
      const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid=,stat=']);
      return parsePs(stdout);
    } catch {
      return new Map();
    }
  }
  const table = new Map<number, ProcInfo>();
  const names = await readdir('/proc').catch(() => [] as string[]);
  await Promise.all(
    names.filter(isPid).map(async (name) => {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
      const info = stat === undefined ? undefined : parseLinuxStat(stat);
      if (info !== undefined) table.set(Number(name), info);
    }),
  );
  return table;
}

/** Synchronous twin of `processTable`. */
export function processTableSync(): Map<number, ProcInfo> {
  if (IS_WINDOWS) return new Map();
  if (IS_DARWIN) {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 && typeof result.stdout === 'string' ? parsePs(result.stdout) : new Map();
  }
  const table = new Map<number, ProcInfo>();
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return table;
  }
  for (const name of names.filter(isPid)) {
    try {
      const info = parseLinuxStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (info !== undefined) table.set(Number(name), info);
    } catch {
      // the process is gone
    }
  }
  return table;
}

function parsePs(output: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [pid, ppid, pgid, state] = [Number(fields[0]), Number(fields[1]), Number(fields[2]), fields[3] ?? ''];
    if (!Number.isInteger(pid) || Number.isNaN(ppid) || Number.isNaN(pgid)) continue;
    table.set(pid, { ppid, pgid, sid: pgid, zombie: state.startsWith('Z') });
  }
  return table;
}

/**
 * One round: SIGKILLs everything that belongs to the PTY session led by `root` (the wrapper shell, a session and
 * process group leader): its process group and session members, plus all their descendants, so a program that
 * ignores SIGHUP, or moved a child into a new session, cannot outlive the session. Returns false when nothing was left.
 */
function killRound(table: Map<number, ProcInfo>, root: number): boolean {
  const victims = new Set<number>();
  for (const [pid, info] of table) if (pid === root || info.pgid === root || info.sid === root) victims.add(pid);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, info] of table) {
      if (!victims.has(pid) && victims.has(info.ppid)) {
        victims.add(pid);
        grew = true;
      }
    }
  }
  const alive = [...victims].filter((pid) => pid !== process.pid && table.get(pid)?.zombie !== true);
  if (alive.length === 0) return false;
  try {
    process.kill(-root, 'SIGKILL');
  } catch {
    // no such group (already gone)
  }
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return true;
}

/** Tree-kills the PTY session led by `root`; repeats until nothing is left. */
export async function killTree(root: number): Promise<void> {
  if (IS_WINDOWS) {
    await run('taskkill', ['/PID', String(root), '/T', '/F'], { windowsHide: true }).catch(() => {});
    return;
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!killRound(await processTable(), root)) return;
    await sleep(ROUND_PAUSE_MS);
  }
}

/** Synchronous twin of `killTree` (blocks for at most `MAX_ROUNDS * ROUND_PAUSE_MS` on POSIX). */
export function killTreeSync(root: number): void {
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!killRound(processTableSync(), root)) return;
    sleepSync(ROUND_PAUSE_MS);
  }
}
