import { spawn, type ChildProcess } from 'node:child_process';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

function waitForUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no URL printed: ${output}`)), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with ${code}: ${output}`));
    });
  });
}

describe('tui-grade serve', () => {
  it('starts the dashboard when called without a command', async () => {
    const child = spawn(process.execPath, ['src/cli/main.ts'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await waitForUrl(child);
      const state = (await (await fetch(`${url}api/state`)).json()) as { version: string; resultsRoot: string };
      expect(state.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(state.resultsRoot).toContain('tui-grade');
    } finally {
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('exit', (value) => resolve(value)));
      expect(code).toBe(143);
    }
  }, 30_000);
});
