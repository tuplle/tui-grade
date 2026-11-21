// Ctrl-C / SIGTERM against the real CLI entry: hung student processes die, temp dirs of the run are removed.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    await sleep(25);
  }
}

/** After an abort the output directory holds no temp-name leftovers of an atomic write and no truncated JSON. */
async function expectCleanOutDir(out: string): Promise<void> {
  const files = await readdir(out, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of files) {
    if (!entry.isFile()) continue;
    expect(entry.name).not.toMatch(/\.tmp$/);
    if (entry.name === 'results.json') expect(() => JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8'))).not.toThrow();
  }
}

interface Started {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
  stdout: () => string;
}

/** The real CLI entry on `env`, with its own TMPDIR so only this run's temp directories are looked at. */
function startCli(env: { assignment: string; input: string }, out: string, tmp: string, extraEnv: Record<string, string> = {}): Started {
  const child = spawn(process.execPath, ['src/cli/main.ts', 'run', env.assignment, env.input, '--out', out], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: tmp, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })));
  return { child, exited, stderr: () => stderr, stdout: () => stdout };
}

const gradeDirs = async (tmp: string): Promise<string[]> => (await readdir(tmp)).filter((n) => n.startsWith('tui-grade-'));

describe.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('the CLI entry on %s', (signal, expectedCode) => {
  it(`exits with ${expectedCode}, kills the hung student process and removes its temp directories`, async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, {
        scenarios: '- id: hang\n  title: Hang\n  steps:\n    - run: { timeout: 60 }\n  expect:\n    - exit_code: 0\n',
      });
      const pidFile = join(root, 'student.pid');
      // The student records its pid and a background child, then hangs.
      await addStudent(env, 'alice', `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 300 &\necho $! > '${pidFile}.child'\nwait\n`);
      await addStudent(env, 'bob', '#!/bin/sh\necho never graded\n');
      const tmp = join(root, 'tmp');
      await mkdir(tmp);

      const child = spawn(process.execPath, ['src/cli/main.ts', 'run', env.assignment, env.input, '--out', join(root, 'out')], {
        cwd: repoRoot,
        env: { ...process.env, TMPDIR: tmp },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.stdout.resume();
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })));

      let studentPid = 0;
      let backgroundPid = 0;
      try {
        studentPid = await readPid(pidFile, 20_000);
        backgroundPid = await readPid(`${pidFile}.child`, 5000);
        expect(studentPid).toBeGreaterThan(1);
        expect(backgroundPid).toBeGreaterThan(1);
        expect(await gradeDirs(tmp)).not.toEqual([]); // the run has temp directories right now

        child.kill(signal);
        const giveUp = setTimeout(() => child.kill('SIGKILL'), 15_000); // a hang shows as signal SIGKILL below
        const result = await exited;
        clearTimeout(giveUp);
        expect(result).toEqual({ code: expectedCode, signal: null });

        // the whole process group of the student is gone, the leftover temp directories too
        const deadline = Date.now() + 5000;
        while ((alive(studentPid) || alive(backgroundPid)) && Date.now() < deadline) await sleep(25);
        expect(alive(studentPid)).toBe(false);
        expect(alive(backgroundPid)).toBe(false);
        expect(await gradeDirs(tmp)).toEqual([]);
        await expectCleanOutDir(join(root, 'out'));
        expect(stderr).not.toContain('Error');
      } finally {
        for (const pid of [studentPid, backgroundPid]) if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  }, 60_000);
});

describe('the CLI entry on SIGINT during a terminal (PTY) session', () => {
  // The program ignores HUP and starts a child in a session of its own; the child's parent is the program.
  const program = (pidFile: string): string =>
    `#!/bin/sh\ntrap '' HUP\necho $$ > '${pidFile}'\nsetsid sh -c "trap '' HUP; echo \\$\\$ > '${pidFile}.child'; while :; do sleep 0.1; done" &\nwhile :; do sleep 0.1; done\n`;

  itIf(hasTool('setsid'))('exits 130 and leaves neither the program, nor its setsid child, nor temp directories, nor partial output', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, {
        scenarios: '- id: pty\n  title: Pty\n  steps:\n    - session: { timeout: 60 }\n  expect:\n    - exit_code: 0\n',
      });
      const pidFile = join(root, 'student.pid');
      await addStudent(env, 'alice', program(pidFile));
      await addStudent(env, 'bob', '#!/bin/sh\necho never graded\n');
      const tmp = join(root, 'tmp');
      const out = join(root, 'out');
      await mkdir(tmp);
      const { child, exited, stderr } = startCli(env, out, tmp);

      let studentPid = 0;
      let escapedPid = 0;
      try {
        studentPid = await readPid(pidFile, 30_000);
        escapedPid = await readPid(`${pidFile}.child`, 10_000);
        expect(studentPid).toBeGreaterThan(1);
        expect(escapedPid).toBeGreaterThan(1);
        expect(await gradeDirs(tmp)).not.toEqual([]);

        child.kill('SIGINT');
        const giveUp = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const result = await exited;
        clearTimeout(giveUp);
        expect(result).toEqual({ code: 130, signal: null });

        const deadline = Date.now() + 5000;
        while ((alive(studentPid) || alive(escapedPid)) && Date.now() < deadline) await sleep(25);
        expect(alive(studentPid)).toBe(false);
        expect(alive(escapedPid)).toBe(false); // the descendant that left the session was found before its parent died
        expect(await gradeDirs(tmp)).toEqual([]);
        await expectCleanOutDir(out);
        expect(stderr()).not.toContain('Error');
      } finally {
        for (const pid of [studentPid, escapedPid]) if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  }, 90_000);
});

describe.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('a second %s while cleanup is still running', (signal, expectedCode) => {
  it(`forces an immediate exit ${expectedCode} instead of being swallowed`, async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, {
        scenarios: '- id: hang\n  title: Hang\n  steps:\n    - run: { timeout: 60 }\n  expect:\n    - exit_code: 0\n',
      });
      const pidFile = join(root, 'student.pid');
      await addStudent(env, 'alice', `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 300 &\nwait\n`);
      const tmp = join(root, 'tmp');
      await mkdir(tmp);
      // The test hook makes the cleanup after the first signal take a minute.
      const { child, exited, stderr } = startCli(env, join(root, 'out'), tmp, { TUI_GRADE_TEST_SLOW_CLEANUP_MS: '60000' });

      let studentPid = 0;
      try {
        studentPid = await readPid(pidFile, 20_000);
        expect(studentPid).toBeGreaterThan(1);

        child.kill(signal);
        await sleep(300); // the first signal is being handled; its cleanup would last a minute
        const second = Date.now();
        child.kill(signal);
        const giveUp = setTimeout(() => child.kill('SIGKILL'), 10_000);
        const result = await exited;
        clearTimeout(giveUp);
        expect(result).toEqual({ code: expectedCode, signal: null });
        expect(Date.now() - second).toBeLessThan(5000);
        expect(stderr()).toContain('forced exit; temp dirs may remain: ');
        expect(alive(studentPid)).toBe(false);
      } finally {
        if (studentPid > 1 && alive(studentPid)) process.kill(studentPid, 'SIGKILL');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  }, 60_000);
});

describe.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('the CLI entry on %s during a multi-student run', (signal, expectedCode) => {
  it('prints no success summary: stdout stays empty, no points table, no "graded" line, no "results in"', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, {
        scenarios: '- id: hang\n  title: Hang\n  steps:\n    - run: { timeout: 60 }\n  expect:\n    - exit_code: 0\n',
      });
      const pidFile = join(root, 'student.pid');
      await addStudent(env, 'alice', `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 300 &\nwait\n`);
      await addStudent(env, 'bob', '#!/bin/sh\necho never graded\n');
      await addStudent(env, 'carol', '#!/bin/sh\necho never graded\n');
      const tmp = join(root, 'tmp');
      const out = join(root, 'out');
      await mkdir(tmp);
      const { child, exited, stdout } = startCli(env, out, tmp);

      let studentPid = 0;
      try {
        studentPid = await readPid(pidFile, 20_000);
        expect(studentPid).toBeGreaterThan(1);
        child.kill(signal);
        const giveUp = setTimeout(() => child.kill('SIGKILL'), 15_000);
        const result = await exited;
        clearTimeout(giveUp);
        expect(result).toEqual({ code: expectedCode, signal: null });
        const printed = stdout();
        expect(printed).toBe('');
        expect(printed).not.toMatch(/graded|results in|Points|\d+ \/ \d+/);
        expect(await gradeDirs(tmp)).toEqual([]);
        await expectCleanOutDir(out);
      } finally {
        if (studentPid > 1 && alive(studentPid)) process.kill(studentPid, 'SIGKILL');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  }, 60_000);
});
