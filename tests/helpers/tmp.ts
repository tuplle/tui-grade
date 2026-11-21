import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tui-grade-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function hasTool(cmd: string): boolean {
  if (process.platform === 'win32') return spawnSync('where', [cmd], { stdio: 'ignore', windowsHide: true }).status === 0;
  return spawnSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' }).status === 0;
}

export const itIf = (cond: boolean): typeof it => (cond ? it : (it.skip as typeof it));
