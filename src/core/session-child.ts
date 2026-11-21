// Runs the student program inside the PTY with a minimal environment and reports its exit code through a marker.
// This small Node wrapper replaces the POSIX `env -i ... sh -c` wrapper, so sessions also work on Windows.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { constants } from 'node:os';

interface SessionChildConfig {
  token: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) process.exit(2);

  let config: SessionChildConfig;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as SessionChildConfig;
  } catch {
    process.exit(2);
  }
  await rm(configPath, { force: true }).catch(() => {});

  let reported = false;
  const report = (code: number): void => {
    if (reported) return;
    reported = true;
    // Keep the marker on its own line; the session parser removes it from the screen.
    process.stdout.write(`\n@${config.token}:${code}@\n`);
  };

  let child: ChildProcess;
  try {
    child = spawn(config.program, config.args, {
      cwd: config.cwd,
      env: config.env,
      stdio: 'inherit',
      windowsHide: false,
    });
  } catch {
    report(1);
    process.exitCode = 1;
    return;
  }

  child.on('error', () => {
    report(1);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    const signalNumber = signal === null ? undefined : (constants.signals as Record<string, number | undefined>)[signal];
    const result = typeof code === 'number' ? code : 128 + (signalNumber ?? 0);
    report(result);
    process.exitCode = result;
  });
}

void main();
