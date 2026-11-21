import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { killAllChildren, liveProcessGroups, runProcess, type ProcessOptions } from '../../src/core/process.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

const base = (cwd: string): Pick<ProcessOptions, 'cwd' | 'timeoutMs' | 'outputLimitBytes'> => ({
  cwd,
  timeoutMs: 10_000,
  outputLimitBytes: 1_000_000,
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitDead(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

/** Polls for a pidfile written by the child; returns 0 when it never shows up with a valid pid. */
async function readPid(file: string, withinMs: number): Promise<number> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      const pid = Number((await readFile(file, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) return 0;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runProcess', () => {
  it('captures stdout, stderr and exit code separately', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({
        ...base(cwd),
        command: 'sh',
        args: ['-c', 'echo out; echo err >&2; exit 3'],
      });
      expect(r.stdout).toBe('out\n');
      expect(r.stderr).toBe('err\n');
      expect(r.exitCode).toBe(3);
      expect(r.signal).toBeNull();
      expect(r.timedOut).toBe(false);
      expect(r.truncated).toBe(false);
      expect(r.spawnError).toBeUndefined();
    });
  });

  it('delivers a stdin string and then closes it', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({ ...base(cwd), command: 'cat', args: [], stdin: 'hello\nworld\n' });
      expect(r.stdout).toBe('hello\nworld\n');
      expect(r.exitCode).toBe(0);
    });
  });

  it.each([{ stdin: 'closed' as const }, {}])('gives EOF on stdin when %j', async (extra) => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({ ...base(cwd), command: 'cat', args: [], ...extra });
      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  it('does not fail when the program exits without reading stdin', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({
        ...base(cwd),
        command: 'sh',
        args: ['-c', 'exit 0'],
        stdin: 'x'.repeat(5_000_000),
      });
      expect(r.exitCode).toBe(0);
    });
  });

  it('times out and kills a long-running process', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({ ...base(cwd), timeoutMs: 300, command: 'sleep', args: ['30'] });
      expect(r.timedOut).toBe(true);
      expect(r.durationMs).toBeLessThan(5000);
      expect(r.exitCode).toBeNull();
      expect(r.signal).toBe('SIGTERM');
    });
  });

  it('kills the whole process group (grandchildren do not survive)', async () => {
    await withTempDir(async (cwd) => {
      const pidFile = join(cwd, 'child.pid');
      let pid = 0;
      try {
        const r = await runProcess({
          ...base(cwd),
          timeoutMs: 300,
          command: 'sh',
          args: ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`],
        });
        expect(r.timedOut).toBe(true);
        pid = await readPid(pidFile, 2000);
        expect(pid).toBeGreaterThan(1);
        expect(await waitDead(pid, 3000)).toBe(true);
      } finally {
        if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    });
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    await withTempDir(async (cwd) => {
      const pidFile = join(cwd, 'child.pid');
      let pid = 0;
      try {
        const r = await runProcess({
          ...base(cwd),
          timeoutMs: 300,
          command: 'sh',
          // Both the shell and the grandchild ignore SIGTERM. The grandchild is a separate `sh -c`
          // so that `$$` inside it is its own pid (in a `( ... )` subshell `$$` is the parent's).
          args: [
            '-c',
            `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' & wait`,
          ],
        });
        expect(r.timedOut).toBe(true);
        // Only SIGKILL can end it, so the 2 s grace period must have elapsed.
        expect(r.durationMs).toBeGreaterThanOrEqual(1500);
        expect(r.durationMs).toBeLessThan(8000);
        pid = await readPid(pidFile, 2000);
        expect(pid).toBeGreaterThan(1);
        expect(await waitDead(pid, 3000)).toBe(true);
      } finally {
        if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    });
  }, 15_000);

  it('cuts endless output at the cap and flags truncation', async () => {
    await withTempDir(async (cwd) => {
      const cap = 10_000;
      const r = await runProcess({ ...base(cwd), outputLimitBytes: cap, command: 'yes', args: [] });
      expect(r.truncated).toBe(true);
      expect(r.stdout.length).toBeGreaterThan(0);
      expect(r.stdout.length).toBeLessThanOrEqual(cap);
      expect(r.timedOut).toBe(false);
      expect(r.durationMs).toBeLessThan(5000);
    });
  });

  it('caps stderr independently', async () => {
    await withTempDir(async (cwd) => {
      const cap = 5_000;
      const r = await runProcess({
        ...base(cwd),
        outputLimitBytes: cap,
        command: 'sh',
        args: ['-c', 'yes >&2'],
      });
      expect(r.truncated).toBe(true);
      expect(r.stderr.length).toBeLessThanOrEqual(cap);
    });
  });

  it('does not flag truncation when output is exactly at the cap', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({
        ...base(cwd),
        outputLimitBytes: 5,
        command: 'sh',
        args: ['-c', 'printf abcde'],
      });
      expect(r.stdout).toBe('abcde');
      expect(r.truncated).toBe(false);
    });
  });

  it('decodes invalid UTF-8 as U+FFFD', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({ ...base(cwd), command: 'sh', args: ['-c', "printf 'a\\377b'"] });
      expect(r.stdout).toBe('a�b');
    });
  });

  it('reports a nonexistent command as spawnError instead of rejecting', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({ ...base(cwd), command: 'definitely-not-a-real-command-xyz', args: [] });
      expect(typeof r.spawnError).toBe('string');
      expect(r.spawnError).toContain('ENOENT');
      expect(r.exitCode).toBeNull();
      expect(r.timedOut).toBe(false);
    });
  });

  it('reports a nonexistent cwd as spawnError instead of rejecting', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({ ...base(join(cwd, 'missing')), command: 'sh', args: ['-c', 'true'] });
      expect(typeof r.spawnError).toBe('string');
      expect(r.exitCode).toBeNull();
    });
  });

  it('isolates the environment: parent vars hidden, HOME is cwd, extra env applied', async () => {
    await withTempDir(async (cwd) => {
      process.env['TUI_GRADE_SECRET'] = 'leak';
      try {
        const r = await runProcess({
          ...base(cwd),
          command: 'sh',
          args: ['-c', 'echo "[$TUI_GRADE_SECRET]"; echo "$HOME"; echo "$LANG|$LC_ALL"; echo "$EXTRA"; test -n "$PATH" && echo path-ok'],
          env: { EXTRA: 'yes' },
        });
        expect(r.stdout.split('\n')).toEqual(['[]', cwd, 'C.UTF-8|C.UTF-8', 'yes', 'path-ok', '']);
      } finally {
        delete process.env['TUI_GRADE_SECRET'];
      }
    });
  });

  it('lets caller env override defaults', async () => {
    await withTempDir(async (cwd) => {
      const r = await runProcess({
        ...base(cwd),
        command: 'sh',
        args: ['-c', 'echo "$HOME"'],
        env: { HOME: '/somewhere' },
      });
      expect(r.stdout).toBe('/somewhere\n');
    });
  });

  it('treats an infinite or oversized timeout as the largest timer value, not as "now"', async () => {
    await withTempDir(async (cwd) => {
      for (const timeoutMs of [Infinity, 3e9, Number.NaN]) {
        const r = await runProcess({ ...base(cwd), timeoutMs, command: 'sh', args: ['-c', 'sleep 0.3; echo done'] });
        expect(r).toMatchObject({ timedOut: false, exitCode: 0, stdout: 'done\n' });
      }
    });
  });

  itIf(hasTool('setsid'))('does not report a timeout for a program that exited by itself while its pipes stay open', async () => {
    await withTempDir(async (cwd) => {
      const pidFile = join(cwd, 'pid');
      // The daemon leaves the process group (setsid), so it keeps the pipes open after `sh` has exited.
      const script = `setsid sh -c 'echo $$ > "${pidFile}"; exec sleep 5' & sleep 0.2; exit 0`;
      let daemon = 0;
      try {
        const r = await runProcess({ ...base(cwd), timeoutMs: 400, command: 'sh', args: ['-c', script] });
        daemon = await readPid(pidFile, 1000);
        expect(r).toMatchObject({ exitCode: 0, timedOut: false });
      } finally {
        daemon = daemon || (await readPid(pidFile, 1000));
        if (daemon > 0) process.kill(daemon, 'SIGKILL');
      }
    });
  });
});

describe('killAllChildren', () => {
  it('kills the registered process groups and the registry empties when the processes are reaped', async () => {
    await withTempDir(async (cwd) => {
      const pidFile = join(cwd, 'pid');
      const pending = runProcess({ ...base(cwd), command: 'sh', args: ['-c', `echo $$ > "${pidFile}"; sleep 30 & wait`] });
      const pid = await readPid(pidFile, 5000);
      expect(pid).toBeGreaterThan(1);
      expect(liveProcessGroups()).toContain(pid);

      killAllChildren();
      const result = await pending;
      expect(result).toMatchObject({ signal: 'SIGKILL', timedOut: false });
      expect(await waitDead(pid, 2000)).toBe(true);
      expect(liveProcessGroups()).not.toContain(pid);
      expect(liveProcessGroups()).toEqual([]);
    });
  });

  it('does nothing when no program runs', () => {
    expect(() => killAllChildren()).not.toThrow();
  });
});
