import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessions } from '@microsoft/tui-test';
import { killAllChildren, livePtyRoots, registerPtyRoot, unregisterPtyRoot } from '../../src/core/process.ts';
import { SessionHandle, killAllSessions, screenMatches } from '../../src/core/session.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

/** Prints `> `, reads a line, prints `got:<line>`, exits 3. */
const ECHO = 'printf "> "; read x; echo "got:$x"; exit 3';

async function withProgram(body: string, fn: (program: string, dir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const program = join(dir, 'prog.sh');
    await writeFile(program, `#!/bin/sh\n${body}\n`);
    await chmod(program, 0o755);
    await fn(program, dir);
  });
}

/** Pids from files written by the programs under test; whatever is still alive at the end is killed. */
const spawned: number[] = [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (/^\d+\n/.test(text)) {
      const pid = Number(text.trim());
      spawned.push(pid);
      return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pid in ${file}`);
}
async function expectDead(pid: number): Promise<void> {
  for (let i = 0; i < 80 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  expect(alive(pid)).toBe(false);
}

afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
  expect(await sessions()).toEqual([]); // no leaked sessions
});

describe('SessionHandle', () => {
  it('drives an interactive program and reports its own exit code', async () => {
    await withProgram(ECHO, async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      try {
        expect(await s.expectScreen('> ', { timeoutMs: 3000 })).toBe(true);
        await s.send('hi');
        expect(await s.expectScreen('got:hi', { timeoutMs: 3000 })).toBe(true);
        expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 3 });
        const screen = await s.screen();
        expect(screen).toBe('> hi\ngot:hi');
        expect(screen).not.toContain('__TUIGRADE');
      } finally {
        await s.close();
      }
    });
  });

  it('passes arguments, cwd and env to the program', async () => {
    await withProgram('echo "args=$1,$2 cwd=$(pwd) foo=$FOO"', async (program, dir) => {
      const s = await SessionHandle.start(program, ['a b', 'c'], { cwd: dir, env: { FOO: 'bar' } });
      try {
        expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
        const screen = await s.screen();
        expect(screen).toContain('args=a b,c');
        expect(screen).toContain('foo=bar');
        // macOS /var is a symlink to /private/var, and pwd prints the physical path.
        expect(screen.replace(/\n/g, '')).toContain(`cwd=${await realpath(dir)}`);
      } finally {
        await s.close();
      }
    });
  });

  describe('environment of the program', () => {
    const PROBE = 'echo "secret=[$TG_SECRET] home=[$HOME] term=[$TERM] foo=[$FOO] lang=[$LC_ALL] path=[${PATH:+set}]"';

    async function withSecret(fn: () => Promise<void>): Promise<void> {
      const before = process.env['TG_SECRET'];
      process.env['TG_SECRET'] = 'hunter2';
      try {
        await fn();
      } finally {
        if (before === undefined) delete process.env['TG_SECRET'];
        else process.env['TG_SECRET'] = before;
      }
    }

    it('does not leak the grader environment; HOME is the cwd; TERM and PATH are set', async () => {
      await withSecret(() =>
        withProgram(PROBE, async (program, dir) => {
          const s = await SessionHandle.start(program, [], { cwd: dir });
          try {
            expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
            const screen = await s.screen();
            // Long temp paths wrap at the terminal width; compare the logical line without soft breaks.
            expect(screen.replace(/\n/g, '')).toContain(
              `secret=[] home=[${dir}] term=[xterm-256color] foo=[] lang=[C.UTF-8] path=[set]`,
            );
            expect(screen).not.toContain('hunter2');
          } finally {
            await s.close();
          }
        }),
      );
    });

    it('still passes the environment given by the scenario (and lets it override TERM)', async () => {
      await withSecret(() =>
        withProgram(PROBE, async (program, dir) => {
          const s = await SessionHandle.start(program, [], { cwd: dir, env: { FOO: 'a b=c', TERM: 'vt100' } });
          try {
            expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
            const screen = await s.screen();
            expect(screen).toContain('foo=[a b=c]');
            expect(screen).toContain('term=[vt100]');
            expect(screen).toContain('secret=[]');
          } finally {
            await s.close();
          }
        }),
      );
    });

    it('plain runs and sessions start with the same base environment', async () => {
      await withSecret(async () => {
        const { runProcess } = await import('../../src/core/process.ts');
        await withProgram('env | sort', async (program, dir) => {
          const run = await runProcess({ command: program, args: [], cwd: dir, timeoutMs: 5000, outputLimitBytes: 65536 });
          const names = (text: string): string[] => text.split('\n').map((l) => l.split('=')[0] ?? '').filter((n) => /^[A-Z_]+$/.test(n) && n !== 'PWD' && n !== 'SHLVL' && n !== '_' && n !== 'OLDPWD');
          expect(names(run.stdout)).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH']);
          const s = await SessionHandle.start(program, [], { cwd: dir });
          try {
            await s.waitExit(3000);
            expect(names(await s.screen())).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM']);
          } finally {
            await s.close();
          }
        });
      });
    });
  });

  it('expectScreen returns false after the timeout; regex mode matches per line', async () => {
    await withProgram('echo "total: 42"; sleep 30', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      try {
        expect(await s.expectScreen('total: 42', { timeoutMs: 3000 })).toBe(true);
        const started = Date.now();
        expect(await s.expectScreen('never shown', { timeoutMs: 300 })).toBe(false);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(await s.expectScreen('^total: \\d+$', { regex: true, timeoutMs: 1000 })).toBe(true);
        expect(await s.expectScreen('^total: \\d{5}$', { regex: true, timeoutMs: 200 })).toBe(false);
      } finally {
        await s.close();
      }
    });
  });

  it('press Ctrl+D delivers EOF', async () => {
    await withProgram('cat >/dev/null; echo eof-seen; exit 0', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      try {
        await s.type('abc');
        await s.press('Ctrl+D', 'Ctrl+D');
        expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
        expect(await s.screen()).toContain('eof-seen');
      } finally {
        await s.close();
      }
    });
  });

  it('waitExit reports exited:false on timeout, and close kills the program (including children)', async () => {
    await withProgram('echo $$ > pid.txt; sleep 30; echo late', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      expect(await s.expectScreen('never', { timeoutMs: 200 })).toBe(false);
      expect(await s.waitExit(300)).toEqual({ exited: false, exitCode: null });
      const pid = Number((await readFile(join(dir, 'pid.txt'), 'utf8')).trim());
      expect(alive(pid)).toBe(true);
      await s.close();
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
      expect(alive(pid)).toBe(false);
      await s.close(); // idempotent
    });
  });

  it('a program that prints a marker-like line cannot fake the exit code', async () => {
    await withProgram('echo "__TUIGRADE_EXIT:0__"; echo "__TUIGRADE_EXIT:abc:0__"; sleep 30', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      try {
        expect(await s.waitExit(400)).toEqual({ exited: false, exitCode: null });
        expect(await s.screen()).toContain('__TUIGRADE_EXIT:0__');
      } finally {
        await s.close();
      }
    });
  });

  it('keeps output that has no trailing newline, and reports a signal death as 128+n', async () => {
    await withProgram('printf "bye"; kill -9 $$', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      try {
        expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 137 });
        expect(await s.screen()).toBe('bye');
      } finally {
        await s.close();
      }
    });
  });

  it('keeps the final screen readable after close', async () => {
    await withProgram('echo final', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir });
      expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
      await s.close();
      expect(await s.screen()).toBe('final');
    });
  });

  it('honours rows and cols', async () => {
    await withProgram('tput lines; tput cols', async (program, dir) => {
      const s = await SessionHandle.start(program, [], { cwd: dir, rows: 12, cols: 33 });
      try {
        expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
        expect(await s.screen()).toBe('12\n33');
      } finally {
        await s.close();
      }
    });
  });

  describe('processes that resist SIGHUP', () => {
    // The program ignores HUP, loops, and (optionally) starts a HUP-ignoring child in a session of its own.
    const STUBBORN = [
      "trap '' HUP",
      'echo $$ > pid.txt',
      `setsid sh -c "trap '' HUP; echo \\$\\$ > pid-escaped.txt; while :; do sleep 0.1; done" &`,
      'while :; do sleep 0.1; done',
    ].join('\n');

    itIf(hasTool('setsid'))('close() kills the program, its children and a child that left the session', async () => {
      await withProgram(STUBBORN, async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir });
        const pids = [await readPid(join(dir, 'pid.txt')), await readPid(join(dir, 'pid-escaped.txt'))];
        expect(pids.every(alive)).toBe(true);
        await s.close();
        for (const pid of pids) await expectDead(pid);
      });
    });

    it('close() kills a HUP-ignoring program after waitExit timed out', async () => {
      await withProgram("trap '' HUP\necho $$ > pid.txt\nwhile :; do sleep 0.1; done", async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir });
        const pid = await readPid(join(dir, 'pid.txt'));
        expect(await s.waitExit(200)).toEqual({ exited: false, exitCode: null });
        expect(alive(pid)).toBe(true);
        await s.close();
        await expectDead(pid);
      });
    });

    it('leaves nothing behind when the program has already exited', async () => {
      await withProgram('echo $$ > pid.txt; exit 0', async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir });
        const pid = await readPid(join(dir, 'pid.txt'));
        expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
        await s.close();
        await expectDead(pid);
      });
    });
  });

  describe('narrow terminals', () => {
    it.each([30, 20, 10, 5])('reads the exit code and hides the marker at cols=%i', async (cols) => {
      await withProgram('echo hi; exit 7', async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir, cols });
        try {
          expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 7 });
          expect(await s.screen()).toBe('hi');
        } finally {
          await s.close();
        }
      });
    });

    it('handles a two-digit exit code and wrapped program output', async () => {
      await withProgram('echo abcdefghijklmnopqrstuvwxyz; exit 12', async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir, cols: 10 });
        try {
          expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 12 });
          const screen = await s.screen();
          expect(screen.replace(/\n/g, '')).toBe('abcdefghijklmnopqrstuvwxyz');
          expect(screen).not.toMatch(/@|:12/);
        } finally {
          await s.close();
        }
      });
    });

    it('runs a plain /bin/echo at cols=30', async () => {
      await withTempDir(async (dir) => {
        const s = await SessionHandle.start('/bin/echo', ['hi'], { cwd: dir, cols: 30 });
        try {
          expect(await s.waitExit(3000)).toEqual({ exited: true, exitCode: 0 });
          expect(await s.screen()).toBe('hi');
        } finally {
          await s.close();
        }
      });
    });
  });

  describe('multi-line text', () => {
    const MENU = 'printf "Menu:\\n1) Add\\n2) Quit\\n> "; sleep 30';

    it('expectScreen matches a needle spanning lines', async () => {
      await withProgram(MENU, async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir });
        try {
          const ok = (text: string, o: { regex?: boolean } = {}): Promise<boolean> => s.expectScreen(text, { timeoutMs: 1500, ...o });
          const no = (text: string, o: { regex?: boolean } = {}): Promise<boolean> => s.expectScreen(text, { timeoutMs: 100, ...o });
          expect(await ok('Menu:\n1) Add')).toBe(true);
          expect(await ok('Menu:\n1) Add\n')).toBe(true); // block-scalar style: one trailing newline
          expect(await ok('Menu:\r\n1) Add\r\n2) Quit')).toBe(true);
          expect(await ok('1) Add\n2) Quit\n> ')).toBe(true); // last line with a trailing blank, bare prompt
          expect(await ok('2) Quit\n>')).toBe(true);
          expect(await ok('Menu:   \n1) Add')).toBe(true); // blanks at the end of an inner line cannot exist on screen
          expect(await no('Menu:\n2) Quit')).toBe(false);
          expect(await no('Menu:\n\n1) Add')).toBe(false);
          expect(await no('1) Add\n2) Quit\n>x')).toBe(false);
          expect(await ok('Menu:\n1\\) Add\n2\\) Quit', { regex: true })).toBe(true);
          expect(await ok('^1\\) Add\n2\\) Quit\n>$\n', { regex: true })).toBe(true); // block-scalar pattern, trailing blanks are trimmed
          expect(await no('Menu:\n2\\)', { regex: true })).toBe(false);
        } finally {
          await s.close();
        }
      });
    });

    it('keeps the single-line behaviour: a trailing blank matches a prompt or a real blank', async () => {
      await withProgram('printf "> \\nName: Bob\\nfoo>bar"; sleep 30', async (program, dir) => {
        const s = await SessionHandle.start(program, [], { cwd: dir });
        try {
          expect(await s.expectScreen('> ', { timeoutMs: 1500 })).toBe(true);
          expect(await s.expectScreen('Name: ', { timeoutMs: 1500 })).toBe(true);
          expect(await s.expectScreen('foo> ', { timeoutMs: 100 })).toBe(false);
          expect(await s.expectScreen('Name:  ', { timeoutMs: 100 })).toBe(false); // two blanks: the line goes on with ' Bob'
          expect(await s.expectScreen('Bob  ', { timeoutMs: 100 })).toBe(true); // end of line: blanks are empty cells
        } finally {
          await s.close();
        }
      });
    });
  });
});

describe('registry of PTY roots and the abort path', () => {
  it('registerPtyRoot / unregisterPtyRoot add and remove a root', () => {
    const before = livePtyRoots();
    registerPtyRoot(2_000_000_000); // no such process: only the bookkeeping is tested
    expect(livePtyRoots()).toEqual([...before, 2_000_000_000]);
    unregisterPtyRoot(2_000_000_000);
    unregisterPtyRoot(2_000_000_000); // idempotent
    expect(livePtyRoots()).toEqual(before);
  });

  // The program ignores HUP and starts a child in a session of its own (its parent is the program, which the abort
  // kills together with the shell: the child is re-parented to init unless the tree is walked first).
  const ESCAPEE = [
    "trap '' HUP",
    'echo $$ > pid.txt',
    `setsid sh -c "trap '' HUP; echo \\$\\$ > pid-escaped.txt; while :; do sleep 0.1; done" &`,
    'while :; do sleep 0.1; done',
  ].join('\n');

  describe.each([
    ['killAllSessions (async)', killAllSessions],
    ['killAllChildren (synchronous exit fallback)', async () => killAllChildren()],
  ] as const)('%s', (_name, abort) => {
    itIf(hasTool('setsid'))('kills the shell, the program and a setsid escapee; the registry is empty once the session is closed', async () => {
      await withProgram(ESCAPEE, async (program, dir) => {
        expect(livePtyRoots()).toEqual([]);
        const s = await SessionHandle.start(program, [], { cwd: dir });
        const pids = [await readPid(join(dir, 'pid.txt')), await readPid(join(dir, 'pid-escaped.txt'))];
        expect(livePtyRoots()).toHaveLength(1);
        const [root] = livePtyRoots() as [number];
        expect([...pids, root].every(alive)).toBe(true);

        await abort();
        for (const pid of [...pids, root]) await expectDead(pid);

        await s.close(); // the owner releases the root
        expect(livePtyRoots()).toEqual([]);
      });
    });
  });
});

describe('screenMatches', () => {
  const re = (source: string): RegExp => new RegExp(source, 'm');

  it('does not invent a trailing empty line for patterns that do not mention line breaks', () => {
    expect(screenMatches('a\nb', re('^$'))).toBe(false);
    expect(screenMatches('a\nb', re('^\\s*$'))).toBe(false);
    expect(screenMatches('', re('^$'))).toBe(true); // a really blank screen
    expect(screenMatches('a\n\nb', re('^$'))).toBe(true); // a real blank line
    expect(screenMatches('a\n\nb', re('^\\s*$'))).toBe(true);
    expect(screenMatches('a\nb', re('^b$'))).toBe(true);
    expect(screenMatches('a\nb', re('^c$'))).toBe(false);
  });

  it('lets a pattern that mentions line breaks (block scalar) end with one after the last line', () => {
    expect(screenMatches('Menu:\n1) Add', re('^Menu:\n1\\) Add\n'))).toBe(true); // real newline char
    expect(screenMatches('Menu:\n1) Add', re('^Menu:\\n1\\) Add\\n'))).toBe(true); // \n escape
    expect(screenMatches('Menu:\n1) Add', re('^Menu:\n1\\) Add\n$'))).toBe(true);
    expect(screenMatches('Menu:\n1) Add', re('^Menu:\n2\\) Add\n'))).toBe(false);
  });
});
