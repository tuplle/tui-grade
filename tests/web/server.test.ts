import { request } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../../src/web/server.ts';
import { GOOD, addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('web server', () => {
  let server: StartedServer;
  let base: string;
  let root: string;
  let web: (path: string, options?: RequestInit) => Promise<Response>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tui-grade-web-'));
    server = await startServer({ resultsRoot: join(root, 'results'), port: 0 });
    base = server.url.replace(/\/$/, '');
    web = (path, options = {}) =>
      fetch(base + path, {
        ...options,
        headers: {
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.method !== undefined && options.method !== 'GET' ? { 'X-TUI-Grade': '1', Origin: base } : {}),
          ...(options.headers ?? {}),
        },
      });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('serves the UI and rejects non-local hosts and header-less writes', async () => {
    expect((await web('/')).status).toBe(200);
    expect(await rawGet(Number(new URL(base).port), '/api/state', 'evil.example')).toBe(403);
    const missing = await fetch(base + '/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ assignmentDir: 'examples/mission' }),
    });
    expect(missing.status).toBe(403);
    const wrongOrigin = await fetch(base + '/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TUI-Grade': '1', Origin: 'http://evil.example' },
      body: JSON.stringify({ assignmentDir: 'examples/mission' }),
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it('inspects an assignment and lists directories', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const inspected = (await (
        await web('/api/inspect', { method: 'POST', body: JSON.stringify({ assignmentDir: env.assignment }) })
      ).json()) as { ok: boolean; assignment: { name: string }; scenarios: unknown[] };
      expect(inspected.ok).toBe(true);
      expect(inspected.assignment.name).toBe('Fake');
      expect(inspected.scenarios).toHaveLength(3);
      const listing = (await (await web('/api/fs?mode=assignment&path=' + encodeURIComponent(root))).json()) as {
        entries: Array<{ name: string; kind: string }>;
      };
      expect(listing.entries.some((entry) => entry.name === 'assignment' && entry.kind === 'dir')).toBe(true);
    });
  });

  it('runs a batch, streams events, and serves results', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const response = await web('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ assignmentDir: env.assignment, inputPath: env.input }),
      });
      expect(response.status).toBe(202);
      const { runId } = (await response.json()) as { runId: string };
      const done = await waitFor(async () => {
        const run = (await (await web('/api/runs/' + runId)).json()) as { status: string };
        return run.status === 'done' ? run : null;
      });
      expect(done).toMatchObject({ status: 'done', students: [{ studentId: 'alice', points: 16, max: 20 }] });

      const events = await (await web('/api/runs/' + runId + '/events')).text();
      expect(events).toContain('event: run-start');
      expect(events).toContain('event: run-end');

      const student = (await (await web('/api/runs/' + runId + '/students/alice')).json()) as { score: { points: number } };
      expect(student.score.points).toBe(16);
      expect((await web('/api/runs/' + runId + '/students/alice/zip')).headers.get('content-type')).toContain('application/zip');
      expect((await web('/api/runs/' + runId + '/summary.csv')).status).toBe(200);
      const history = (await (await web('/api/runs')).json()) as Array<{ id: string }>;
      expect(history.some((run) => run.id === runId)).toBe(true);

      // Older runs may have no run.json; they still open read-only.
      await rm(join(server.manager.resultsRoot, runId, 'run.json'));
      const legacy = (await (await web('/api/runs/' + runId)).json()) as { assignment: string; students: unknown[] };
      expect(legacy.assignment).toBe('Fake');
      expect(legacy.students).toHaveLength(1);
    });
  });

  it('stops an active run', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, {
        scenarios: '- id: hang\n  title: Hang\n  steps:\n    - run: { timeout: 30 }\n  expect:\n    - exit_code: 0\n',
      });
      await addStudent(env, 'alice', '#!/bin/sh\nsleep 30\n');
      const response = await web('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ assignmentDir: env.assignment, inputPath: env.input }),
      });
      const { runId } = (await response.json()) as { runId: string };
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stopped = (await (await web('/api/runs/' + runId + '/stop', { method: 'POST' })).json()) as { status: string };
      expect(['running', 'stopped']).toContain(stopped.status);
      const done = await waitFor(async () => {
        const run = (await (await web('/api/runs/' + runId)).json()) as { status: string };
        return run.status === 'stopped' ? run : null;
      });
      expect(done.status).toBe('stopped');
    });
  });

  it('applies manual points without rebuilding', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const { runId } = (await (
        await web('/api/runs', { method: 'POST', body: JSON.stringify({ assignmentDir: env.assignment, inputPath: env.input }) })
      ).json()) as { runId: string };
      await waitFor(async () => {
        const run = (await (await web('/api/runs/' + runId)).json()) as { status: string };
        return run.status === 'done' ? run : null;
      });
      const marker = await stat(env.marker);
      const manual = (await (await web('/api/runs/' + runId + '/manual')).json()) as { groups: unknown[] };
      expect(manual.groups).toHaveLength(1);
      const saved = (await (
        await web('/api/runs/' + runId + '/manual', { method: 'PUT', body: JSON.stringify({ points: { alice: { review: 3.5 } } }) })
      ).json()) as { students: Array<{ studentId: string; points: number; max: number }> };
      expect(saved.students[0]).toMatchObject({ studentId: 'alice', points: 19.5, max: 20 });
      expect((await stat(env.marker)).mtimeMs).toBe(marker.mtimeMs);
      const result = (await (await web('/api/runs/' + runId + '/students/alice')).json()) as { score: { points: number } };
      expect(result.score.points).toBe(19.5);
    });
  });

  it('rejects traversal and unknown artifacts', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const { runId } = (await (
        await web('/api/runs', { method: 'POST', body: JSON.stringify({ assignmentDir: env.assignment, inputPath: env.input }) })
      ).json()) as { runId: string };
      await waitFor(async () => {
        const run = (await (await web('/api/runs/' + runId)).json()) as { status: string };
        return run.status === 'done' ? run : null;
      });
      expect((await web('/api/runs/..%2F..%2Fetc')).status).toBeLessThan(500);
      const artifact = await web('/api/runs/' + runId + '/students/alice/artifact?path=' + encodeURIComponent('../../etc/passwd'));
      expect(artifact.status).toBe(404);
    });
  });

  it('shuts down through the API', async () => {
    const response = await web('/api/shutdown', { method: 'POST' });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fetch(base + '/api/state')).rejects.toThrow();
    server = { ...server, close: async () => {} }; // already closed
  });
});
