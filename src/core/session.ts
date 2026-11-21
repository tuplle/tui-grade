// PTY sessions on top of @microsoft/tui-test: start a program in a terminal, drive it, read the screen.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TuiTest } from '@microsoft/tui-test';
import { livePtyRoots, minimalEnv, registerPtyRoot, unregisterPtyRoot } from './process.ts';
import { killTree } from './proctree.ts';
import { isShuttingDown } from './shutdown.ts';

const DEFAULT_ROWS = 50;
const DEFAULT_COLS = 120;
const DEFAULT_EXPECT_MS = 5000;
const POLL_MS = 25;
/** After the terminal reports that the process ended, how long to wait for the exit marker to be rendered. */
const MARKER_GRACE_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Plain-text containment on screen text, whose lines have their trailing blanks trimmed. The needle may span
 * lines (`\r\n` and one trailing newline, as a YAML block scalar has, are normalized). Blanks at the end of its
 * last line count as the empty cells they are on a terminal: `"> "` matches a bare prompt `>` as well as `> x`.
 * Blanks at the end of its other lines cannot occur on a trimmed screen and are ignored.
 */
export function screenIncludes(screen: string, needle: string): boolean {
  const lines = needle.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const last = lines.pop() ?? '';
  const body = last.trimEnd();
  const blanks = last.length - body.length;
  const head = lines.map((line) => `${escapeRegExp(line.trimEnd())}\n`).join('');
  const tail = blanks === 0 ? '' : `(?: {${blanks}}| *(?=\n|$))`;
  return new RegExp(`${head}${escapeRegExp(body)}${tail}`).test(screen);
}

/**
 * Regex matching on screen text: `^`/`$` anchor per line (the caller adds the `m` flag). The plain screen is tested
 * first. Only a pattern that explicitly mentions a line break (a `\n` escape or a newline character, as a block
 * scalar has) is also tried against the screen plus a final newline, so it can end with one after the last line;
 * other patterns never see that phantom empty line (`^$` must not match every screen).
 */
export function screenMatches(screen: string, regex: RegExp): boolean {
  if (regex.test(screen)) return true;
  return /\\n|\n/.test(regex.source) && regex.test(`${screen}\n`);
}

export interface SessionOptions {
  cwd: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
}
export interface ExitState {
  exited: boolean;
  exitCode: number | null;
}

/** Tree-kills every live PTY session (used when the grader is aborted; `killAllChildren` is the synchronous variant). */
export async function killAllSessions(): Promise<void> {
  await Promise.all(livePtyRoots().map((root) => killTree(root)));
}

/** Matches `text` even when the terminal wrapped it: a line break may appear between any two characters. */
const wrapTolerant = (text: string): string => [...text].map(escapeRegExp).join('\\n?');

/** The compiled Node wrapper, or the source version when the server runs from src/. */
function sessionChildEntry(): string {
  const built = fileURLToPath(new URL('./session-child.js', import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL('./session-child.ts', import.meta.url));
}

/**
 * tui-test 0.1.1 does not report the exit code of the program started with `run` (`getExitCode()` is null),
 * so the program runs under a tiny wrapper shell that prints the short marker `@<token>:<code>@` when the
 * program ends. The token is random per session, so program output cannot fake it. The marker is parsed
 * from the screen text (tolerating terminal wrapping at narrow widths) and removed from the text exposed to callers.
 */
export class SessionHandle {
  readonly #terminal: TuiTest;
  readonly #marker: RegExp;
  readonly #pid: number | null;
  readonly #configPath: string;
  #exit: ExitState | undefined;
  #lastScreen = '';
  #closed = false;

  private constructor(terminal: TuiTest, token: string, pid: number | null, configPath: string) {
    this.#terminal = terminal;
    this.#pid = pid;
    this.#configPath = configPath;
    this.#marker = new RegExp(`\\n*${wrapTolerant(`@${token}:`)}\\n?(\\d(?:\\n?\\d)*)\\n?@`);
  }

  static async start(program: string, args: string[], o: SessionOptions): Promise<SessionHandle> {
    if (isShuttingDown()) throw new Error('the grader is shutting down');
    const token = randomBytes(4).toString('hex');
    const terminal = TuiTest.ephemeral('tui-grade');
    // tui-test merges `env` into the grader's own environment. The Node wrapper starts the program with exactly the
    // minimal environment, on every platform, and reports the exit code through the random marker.
    const configPath = join(o.cwd, `.tui-grade-session-${token}.json`);
    const env = minimalEnv(o.cwd, { TERM: 'xterm-256color', ...o.env });
    await writeFile(configPath, JSON.stringify({ token, program, args, cwd: o.cwd, env }), 'utf8');
    let opened: { shell_pid: number | null };
    try {
      opened = await terminal.run(process.execPath, [sessionChildEntry(), configPath], {
        cwd: o.cwd,
        rows: o.rows ?? DEFAULT_ROWS,
        cols: o.cols ?? DEFAULT_COLS,
      });
    } catch (error) {
      await rm(configPath, { force: true }).catch(() => {});
      await terminal.closeQuiet().catch(() => {});
      throw error;
    }
    if (opened.shell_pid !== null) registerPtyRoot(opened.shell_pid);
    return new SessionHandle(terminal, token, opened.shell_pid, configPath);
  }

  /** Types the text and presses Enter. */
  async send(text: string): Promise<void> {
    await this.#terminal.submit(text);
  }

  /** Types the text without Enter. */
  async type(text: string): Promise<void> {
    await this.#terminal.type(text);
  }

  /** Presses keys, e.g. `Enter`, `Up`, `Ctrl+D`. */
  async press(...keys: string[]): Promise<void> {
    await this.#terminal.keyboard.press(...keys);
  }

  /**
   * Waits until the screen (scrollback included) contains the text (it may span lines; see `screenIncludes`),
   * or matches the regular expression (multi-line mode: `^`/`$` match at line boundaries; trailing blanks are
   * trimmed). Resolves false on timeout; throws on an invalid pattern.
   */
  async expectScreen(text: string, o: { regex?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
    const regex = o.regex === true ? new RegExp(text, 'm') : undefined;
    const matches = (screen: string): boolean => (regex === undefined ? screenIncludes(screen, text) : screenMatches(screen, regex));
    const deadline = Date.now() + (o.timeoutMs ?? DEFAULT_EXPECT_MS);
    for (;;) {
      if (matches(await this.screen())) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(POLL_MS, left));
    }
  }

  /**
   * Waits up to `timeoutMs` for the program to end. `exitCode` is null when it is unknown
   * (not exited, or the wrapper itself was killed before it could report).
   */
  async waitExit(timeoutMs: number): Promise<ExitState> {
    if (this.#exit !== undefined) return this.#exit;
    let ended = false;
    try {
      await this.#terminal.waitExit({ timeout: Math.max(1, Math.round(timeoutMs)) });
      ended = true;
    } catch {
      // still running at the timeout (the library rejects); the marker check below settles it
    }
    const deadline = Date.now() + (ended ? MARKER_GRACE_MS : 0);
    for (;;) {
      await this.screen();
      if (this.#exit !== undefined) return this.#exit;
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    return ended ? { exited: true, exitCode: null } : { exited: false, exitCode: null };
  }

  /** The screen text including scrollback, without the exit marker and trailing blank lines. */
  async screen(): Promise<string> {
    if (this.#closed) return this.#lastScreen;
    let raw: string;
    try {
      raw = await this.#terminal.text({ full: true });
    } catch {
      return this.#lastScreen;
    }
    const found = this.#marker.exec(raw);
    if (found !== null) {
      this.#exit = { exited: true, exitCode: Number((found[1] ?? '').replace(/\n/g, '')) };
      raw = raw.replace(this.#marker, '');
    }
    this.#lastScreen = raw.replace(/\n+$/, '');
    return this.#lastScreen;
  }

  /** Kills the program if it is still running and releases the terminal. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.screen(); // remember the final screen
      this.#closed = true;
      // The library's KILL reaches only the wrapper; the program is a descendant of it on every platform.
      if (this.#pid !== null) await killTree(this.#pid);
      await this.#terminal.signal('KILL').catch(() => {});
      await this.#terminal.closeQuiet().catch(() => {});
    } finally {
      this.#closed = true;
      await rm(this.#configPath, { force: true }).catch(() => {});
      // Whatever went wrong above, a stale root must not stay registered (its pid could be reused).
      if (this.#pid !== null) unregisterPtyRoot(this.#pid);
    }
  }
}
