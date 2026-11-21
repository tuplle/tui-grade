import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '../core/events.ts';
import { killTree } from '../core/proctree.ts';
import { readHeader, type RunHeader, type StudentRow } from './results.ts';
import { HttpError } from './http-error.ts';

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface StartRunOptions {
  assignmentDir: string;
  inputPath: string;
  only?: string[];
  locale?: string;
  keepWorkdirs?: boolean;
}

export interface StoredEvent {
  seq: number;
  event: RunEvent;
}

export interface RunView extends RunHeader {
  status: RunStatus;
  finishedAt?: string;
  error?: string;
}

interface LiveRun {
  id: string;
  outDir: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  child: ChildProcess;
  events: StoredEvent[];
  listeners: Set<(event: StoredEvent) => void>;
  stderr: string;
  stopRequested: boolean;
  error?: string;
  assignment?: string;
  locale?: string;
  students: StudentRow[];
  exited: Promise<void>;
  resolveExited: () => void;
  killTimer?: NodeJS.Timeout;
}

const EVENT_LIMIT = 50_000;
const STDERR_LIMIT = 64 * 1024;
const STOP_GRACE_MS = 10_000;

function cliEntry(): string {
  const local = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  return existsSync(local) ? local : fileURLToPath(new URL('../cli/main.ts', import.meta.url));
}

function timestampId(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

export class RunManager {
  readonly #resultsRoot: string;
  #active: LiveRun | null = null;
  readonly #recent = new Map<string, LiveRun>();

  constructor(resultsRoot: string) {
    this.#resultsRoot = resolve(resultsRoot);
  }

  get resultsRoot(): string {
    return this.#resultsRoot;
  }

  active(): RunView | null {
    return this.#active === null ? null : this.#view(this.#active);
  }

  get(id: string): RunView | null {
    const run = this.#find(id);
    return run === null ? null : this.#view(run);
  }

  events(id: string, since = 0): StoredEvent[] | null {
    const run = this.#find(id);
    return run === null ? null : run.events.filter((item) => item.seq > since);
  }

  subscribe(id: string, listener: (event: StoredEvent) => void): (() => void) | null {
    const run = this.#find(id);
    if (run === null) return null;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  async start(options: StartRunOptions): Promise<RunView> {
    if (this.#active !== null && this.#active.status === 'running') {
      throw new HttpError(409, 'run_in_progress', 'A grading run is already in progress');
    }
    await mkdir(this.#resultsRoot, { recursive: true });
    const id = await this.#uniqueId();
    const outDir = join(this.#resultsRoot, id);
    await mkdir(outDir, { recursive: true });

    const args = ['run', resolve(options.assignmentDir), resolve(options.inputPath), '--out', outDir, '--events'];
    if (options.only !== undefined && options.only.length > 0) args.push('--only', options.only.join(','));
    if (options.locale !== undefined) args.push('--locale', options.locale);
    if (options.keepWorkdirs === true) args.push('--keep-workdirs');

    const child = spawn(process.execPath, [cliEntry(), ...args], {
      cwd: process.cwd(),
      env: process.env,
      // IPC gives the dashboard a graceful Stop on Windows too; SIGTERM is only a POSIX fallback.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      child.kill('SIGKILL');
      throw new Error('cannot capture the grading process output');
    }

    let resolveExited: () => void = () => {};
    const exited = new Promise<void>((resolvePromise) => {
      resolveExited = resolvePromise;
    });
    const run: LiveRun = {
      id,
      outDir,
      status: 'running',
      startedAt: new Date().toISOString(),
      child,
      events: [],
      listeners: new Set(),
      stderr: '',
      stopRequested: false,
      students: [],
      exited,
      resolveExited,
    };
    this.#active = run;

    createInterface({ input: stdout }).on('line', (line) => this.#line(run, line));
    stderr.on('data', (chunk: Buffer) => {
      run.stderr = `${run.stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });
    child.on('error', (error) => {
      run.error = `cannot start tui-grade: ${error.message}`;
      void this.#finish(run, null);
    });
    child.on('exit', (code, signal) => {
      void this.#finish(run, code, signal);
    });

    return this.#view(run);
  }

  stop(id: string): RunView {
    const run = this.#find(id);
    if (run === null) throw new HttpError(404, 'run_not_found', `Run '${id}' not found`);
    if (run.status !== 'running') return this.#view(run);
    run.stopRequested = true;
    try {
      if (run.child.connected) run.child.send({ type: 'stop' });
      else run.child.kill('SIGTERM');
    } catch {
      run.child.kill('SIGTERM');
    }
    run.killTimer = setTimeout(() => {
      run.child.kill('SIGKILL');
      if (run.child.pid !== undefined) void killTree(run.child.pid);
    }, STOP_GRACE_MS);
    run.killTimer.unref();
    return this.#view(run);
  }

  async stopAll(): Promise<void> {
    const active = this.#active;
    if (active === null || active.status !== 'running') return;
    this.stop(active.id);
    await active.exited;
  }

  #find(id: string): LiveRun | null {
    if (this.#active?.id === id) return this.#active;
    return this.#recent.get(id) ?? null;
  }

  async #uniqueId(): Promise<string> {
    const base = timestampId();
    for (let n = 2; ; n++) {
      const id = n === 2 ? base : `${base}-${n}`;
      const exists = await access(join(this.#resultsRoot, id)).then(
        () => true,
        () => false,
      );
      if (!exists) return id;
    }
  }

  #line(run: LiveRun, line: string): void {
    if (line.trim() === '') return;
    let event: RunEvent;
    try {
      event = JSON.parse(line) as RunEvent;
    } catch {
      return; // a plugin wrote something else to stdout; ignore it
    }
    if (typeof event !== 'object' || event === null || event.schemaVersion !== 1) return;
    if (event.type === 'run-start') {
      run.assignment = event.assignment;
      run.locale = event.locale;
    }
    if (event.type === 'run-end') {
      run.students = event.results.map((result) => ({
        studentId: result.studentId,
        displayName: result.displayName,
        points: result.points,
        max: result.max,
      }));
    }
    const stored = { seq: run.events.length + 1, event };
    run.events.push(stored);
    if (run.events.length > EVENT_LIMIT) run.events.splice(0, run.events.length - EVENT_LIMIT);
    for (const listener of run.listeners) {
      try {
        listener(stored);
      } catch {
        // A disconnected SSE client must not affect the run.
      }
    }
  }

  async #finish(run: LiveRun, code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    if (run.status !== 'running') return;
    if (run.killTimer !== undefined) clearTimeout(run.killTimer);
    run.finishedAt = new Date().toISOString();
    run.status = run.stopRequested || code === 130 || code === 143 ? 'stopped' : code === 0 ? 'done' : 'failed';
    if (run.status === 'failed' && run.error === undefined) {
      run.error = run.stderr.trim() || `tui-grade exited with code ${code ?? 'null'}${signal === null ? '' : ` (${signal})`}`;
    }
    if (run.students.length === 0) {
      const header = await readHeader(run.outDir, run.id);
      if (header !== null) {
        run.students = header.students;
        run.assignment ??= header.assignment;
        run.locale ??= header.locale;
      }
    }
    this.#active = this.#active === run ? null : this.#active;
    this.#recent.set(run.id, run);
    if (this.#recent.size > 20) {
      const oldest = this.#recent.keys().next().value;
      if (oldest !== undefined && oldest !== run.id) this.#recent.delete(oldest);
    }
    run.resolveExited();
  }

  #view(run: LiveRun): RunView {
    return {
      id: run.id,
      outDir: run.outDir,
      assignment: run.assignment ?? run.id,
      startedAt: run.startedAt,
      locale: run.locale ?? 'en',
      completed: run.status === 'done',
      status: run.status,
      students: run.students,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.error === undefined ? {} : { error: run.error }),
    } as RunView;
  }
}
