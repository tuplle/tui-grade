import { Router, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { loadAssignment } from '../core/assignment.ts';
import { localize } from '../core/i18n.ts';
import { rescoreRun } from '../core/rescore.ts';
import { readRunMetadata } from '../core/run-meta.ts';
import { validateAssignment } from '../core/validate.ts';
import { VERSION } from '../core/version.ts';
import { browse, type BrowseMode } from './fs.ts';
import { HttpError } from './http-error.ts';
import { listRuns, loadRun, runDir, writeManual } from './history.ts';
import { readArtifact, readHeader, readManual, readStudentResult, rows } from './results.ts';
import type { RunManager } from './run-manager.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ApiDeps {
  resultsRoot: string;
  manager: RunManager;
  shutdown(): void;
  initial?: { assignmentDir?: string; inputPath?: string };
}

const stringField = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'invalid_request', `${name} is required`);
  return value;
};

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(400, 'invalid_request', 'only must be an array of scenario ids');
  }
  return value as string[];
}

function pointsBody(value: unknown): Record<string, Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_manual', 'points must be an object of student id → { group id: number }');
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [student, groups] of Object.entries(value)) {
    if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) {
      throw new HttpError(400, 'invalid_manual', `points['${student}'] must be an object`);
    }
    out[student] = {};
    for (const [group, points] of Object.entries(groups)) {
      if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) {
        throw new HttpError(400, 'invalid_manual', `points['${student}']['${group}'] must be a non-negative number`);
      }
      out[student][group] = points;
    }
  }
  return out;
}

async function inspect(assignmentDir: string) {
  const dir = resolve(process.cwd(), assignmentDir);
  const loaded = await loadAssignment(dir);
  const issues = !loaded.configOk ? loaded.issues : [...loaded.issues, ...validateAssignment(loaded)];
  const ok = !issues.some((issue) => issue.severity === 'error');
  return {
    ok,
    issues,
    locale: loaded.config.locale,
    assignment: loaded.configOk
      ? {
          name: loaded.config.name,
          maxPoints: loaded.config.max_points,
          locale: loaded.config.locale,
          groups: loaded.config.groups ?? [],
          limits: loaded.config.limits,
          scoring: loaded.config.scoring,
        }
      : null,
    scenarios: loaded.scenarios.map((scenario) => ({
      id: scenario.id,
      title: localize(scenario.title, loaded.config.locale),
      ...(scenario.group === undefined ? {} : { group: scenario.group }),
      file: scenario.file,
    })),
  };
}

function sse(req: Request, res: Response, deps: ApiDeps, id: string): void {
  const run = deps.manager.get(id);
  if (run === null) throw new HttpError(404, 'run_not_found', `Run '${id}' not found`);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('retry: 1000\n\n');

  let closed = false;
  const write = (item: { seq: number; event: unknown }): void => {
    if (closed) return;
    res.write(`id: ${item.seq}\nevent: ${(item.event as { type: string }).type}\ndata: ${JSON.stringify(item.event)}\n\n`);
  };
  for (const item of deps.manager.events(id, 0) ?? []) write(item);
  if (run.status !== 'running') {
    res.end();
    return;
  }

  const unsubscribe = deps.manager.subscribe(id, (item) => {
    write(item);
    if ((item.event as { type: string }).type === 'run-end') {
      closed = true;
      unsubscribe?.();
      clearInterval(ping);
      res.end();
    }
  });
  if (unsubscribe === null) {
    res.end();
    return;
  }
  const ping = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);
  ping.unref();
  req.on('close', () => {
    closed = true;
    unsubscribe();
    clearInterval(ping);
  });
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();

  router.get('/state', async (_req, res) => {
    const runs = await listRuns(deps.resultsRoot, 20);
    res.json({
      version: VERSION,
      resultsRoot: deps.resultsRoot,
      active: deps.manager.active(),
      runs,
      ...(deps.initial === undefined ? {} : { initial: deps.initial }),
    });
  });

  router.post('/inspect', async (req, res) => {
    const body = req.body as { assignmentDir?: unknown };
    const assignmentDir = stringField(body.assignmentDir, 'assignmentDir');
    res.json(await inspect(assignmentDir));
  });

  router.get('/fs', async (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    const mode: BrowseMode = req.query.mode === 'submissions' ? 'submissions' : 'assignment';
    res.json(await browse(path, mode));
  });

  router.post('/runs', async (req, res) => {
    const body = req.body as {
      assignmentDir?: unknown;
      inputPath?: unknown;
      only?: unknown;
      locale?: unknown;
      keepWorkdirs?: unknown;
    };
    const assignmentDir = stringField(body.assignmentDir, 'assignmentDir');
    const inputPath = stringField(body.inputPath, 'inputPath');
    if (body.locale !== undefined && body.locale !== 'en' && body.locale !== 'sk') {
      throw new HttpError(400, 'invalid_locale', 'locale must be en or sk');
    }
    const run = await deps.manager.start({
      assignmentDir,
      inputPath,
      ...(stringArray(body.only) === undefined ? {} : { only: stringArray(body.only) as string[] }),
      ...(body.locale === undefined ? {} : { locale: body.locale as string }),
      ...(body.keepWorkdirs === undefined ? {} : { keepWorkdirs: body.keepWorkdirs === true }),
    });
    res.status(202).json({ runId: run.id, run });
  });

  router.get('/runs', async (_req, res) => {
    res.json(await listRuns(deps.resultsRoot));
  });

  router.get('/runs/:id', async (req, res) => {
    const id = req.params.id as string;
    const live = deps.manager.get(id);
    res.json(live ?? (await loadRun(deps.resultsRoot, id)));
  });

  router.get('/runs/:id/events', (req, res) => {
    sse(req, res, deps, req.params.id as string);
  });

  router.post('/runs/:id/stop', (req, res) => {
    res.json(deps.manager.stop(req.params.id as string));
  });

  router.get('/runs/:id/students/:studentId', async (req, res) => {
    const id = req.params.id as string;
    const studentId = req.params.studentId as string;
    const live = deps.manager.get(id);
    const outDir = live?.outDir ?? (await runDir(deps.resultsRoot, id));
    const result = await readStudentResult(outDir, studentId);
    if (result === null) throw new HttpError(404, 'result_not_found', 'Student result not found');
    res.json(result);
  });

  router.get('/runs/:id/students/:studentId/artifact', async (req, res) => {
    const id = req.params.id as string;
    const studentId = req.params.studentId as string;
    const path = req.query.path;
    if (typeof path !== 'string') throw new HttpError(400, 'invalid_request', 'path is required');
    const live = deps.manager.get(id);
    const outDir = live?.outDir ?? (await runDir(deps.resultsRoot, id));
    res.type('text/plain').send(await readArtifact(outDir, studentId, path));
  });

  router.get('/runs/:id/students/:studentId/zip', async (req, res) => {
    const id = req.params.id as string;
    const studentId = req.params.studentId as string;
    const live = deps.manager.get(id);
    const outDir = live?.outDir ?? (await runDir(deps.resultsRoot, id));
    const file = join(outDir, studentId, `${studentId}-results.zip`);
    const data = await readFile(file).catch(() => null);
    if (data === null) throw new HttpError(404, 'zip_not_found', 'Student ZIP not found');
    res.type('application/zip').attachment(`${studentId}-results.zip`).send(data);
  });

  router.get('/runs/:id/summary.csv', async (req, res) => {
    const id = req.params.id as string;
    const live = deps.manager.get(id);
    const outDir = live?.outDir ?? (await runDir(deps.resultsRoot, id));
    const data = await readFile(join(outDir, 'summary.csv')).catch(() => null);
    if (data === null) throw new HttpError(404, 'summary_not_found', 'Summary not found');
    res.type('text/csv').send(data);
  });

  router.get('/runs/:id/manual', async (req, res) => {
    const id = req.params.id as string;
    const live = deps.manager.get(id);
    if (live?.status === 'running') throw new HttpError(409, 'run_in_progress', 'The run is still in progress');
    const outDir = live?.outDir ?? (await runDir(deps.resultsRoot, id));
    const header = await readHeader(outDir, id);
    if (header === null) throw new HttpError(404, 'run_not_found', `Run '${id}' not found`);
    if (!header.completed) throw new HttpError(400, 'run_incomplete', 'The run has not finished');
    const meta = await readRunMetadata(outDir);
    if (meta === null) throw new HttpError(400, 'run_metadata_missing', 'This run has no assignment metadata; rescore from the CLI');
    const loaded = await loadAssignment(meta.assignmentDir);
    res.json({
      groups: (loaded.config.groups ?? [])
        .filter((group) => group.manual === true)
        .map((group) => ({ id: group.id, title: localize(group.title, header.locale), points: group.points })),
      values: await readManual(outDir),
      locale: header.locale,
    });
  });

  router.put('/runs/:id/manual', async (req, res) => {
    const id = req.params.id as string;
    const live = deps.manager.get(id);
    if (live?.status === 'running') throw new HttpError(409, 'run_in_progress', 'The run is still in progress');
    const outDir = live?.outDir ?? (await runDir(deps.resultsRoot, id));
    const header = await readHeader(outDir, id);
    if (header === null) throw new HttpError(404, 'run_not_found', `Run '${id}' not found`);
    if (!header.completed) throw new HttpError(400, 'run_incomplete', 'The run has not finished');
    const meta = await readRunMetadata(outDir);
    if (meta === null) throw new HttpError(400, 'run_metadata_missing', 'This run has no assignment metadata; rescore from the CLI');
    const points = pointsBody((req.body as { points?: unknown }).points);
    await writeManual(outDir, points);
    const rescored = await rescoreRun({ assignmentDir: meta.assignmentDir, outDir, manualFile: join(outDir, 'manual.yaml') });
    res.json({ students: rows(rescored.results), issues: rescored.issues });
  });

  router.post('/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(deps.shutdown, 20).unref();
  });

  return router;
}
