// Lifecycle engine (§5.2): load → intake → per submission (build, scenarios, score) → reporters. Never fails the batch because of a student.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { App } from './app.ts';
import { type LoadedAssignment, loadAssignment } from './assignment.ts';
import { BUILD_CODES, runBuild } from './build.ts';
import type {
  BuildResult,
  Issue,
  ReporterContext,
  ScenarioIR,
  ScenarioResult,
  ScoreResult,
  Submission,
  SubmissionResult,
  Translate,
} from './contracts.ts';
import { ConfigError } from './errors.ts';
import { type ScenarioEnv, runScenario } from './execute.ts';
import { type RunEvent, compactResult, emitEvent } from './events.ts';
import type { HookName, HookPayloads, RunInfo } from './hooks.ts';
import { createTranslate, localize } from './i18n.ts';
import { cleanupSubmission, discoverSubmissions } from './intake.ts';
import { isAtomicTempName, unregisterTempDir, writeFileAtomic } from './workspace.ts';
import { loadManualPoints } from './manual.ts';
import type { PluginDef } from './plugin.ts';
import { writeRunMetadata } from './run-meta.ts';
import { isShuttingDown } from './shutdown.ts';
import { validateAssignment } from './validate.ts';
import { VERSION } from './version.ts';

export { ConfigError } from './errors.ts';

export interface RunOptions {
  assignmentDir: string;
  inputPath: string;
  outDir: string;
  only?: string[]; // scenario ids
  locale?: 'en' | 'sk';
  keepWorkdirs?: boolean;
  manualFile?: string;
  extraPlugins?: PluginDef[];
  translate?: Translate; // default: the built-in catalog of the effective locale
  log?: (m: string) => void;
  /** Structured progress for the web dashboard / machine consumers. Listener failures are ignored. */
  onEvent?: (event: RunEvent) => void;
}

export interface GradeSubmissionOptions {
  outDir: string;
  only?: string[];
  locale: string;
  manual?: Record<string, number>;
  /** True when a manual points file was given (so a missing `manual` means "student not listed"). */
  manualProvided?: boolean;
  /** Keep the submission's work directory (default: it is removed before the reporters run). */
  keepWorkdirs?: boolean;
  translate?: Translate;
  log(m: string): void;
  onEvent?: (event: RunEvent) => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const fileSafe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Runs the hooks of `name`, turning failures into `hook <name> failed: <message>` warnings. */
async function fire<N extends HookName>(app: App, name: N, payload: HookPayloads[N], warnings: string[]): Promise<void> {
  try {
    for (const failure of await app.runHooks(name, payload)) {
      warnings.push(`hook ${name} failed: ${failure.error.message}`);
    }
  } catch (error) {
    warnings.push(`hook ${name} failed: ${messageOf(error)}`);
  }
}

const zeroScore = (loaded: LoadedAssignment): ScoreResult => ({
  points: 0,
  max: loaded.config.max_points,
  automaticPoints: 0,
  groups: [],
  ungrouped: [],
  rounding: loaded.config.scoring.rounding,
});

const rootNotFound = (): BuildResult => ({
  ok: false,
  message: BUILD_CODES.projectRootNotFound,
  log: '',
  exitCode: null,
  timedOut: false,
  warnings: 0,
  durationMs: 0,
});

/** Each section of a run log is cut at this many bytes. */
const LOG_SECTION_MAX_BYTES = 64 * 1024;

function capSection(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= LOG_SECTION_MAX_BYTES ? text : `${bytes.subarray(0, LOG_SECTION_MAX_BYTES).toString()}\n[truncated at 64 KiB]`;
}

type RunLog = NonNullable<ScenarioResult['logs']>[string];

const formatRunLog = (log: RunLog): string =>
  [
    `exit code: ${log.exitCode === null ? 'none' : log.exitCode}`,
    `timed out: ${log.timedOut ? 'yes' : 'no'}`,
    '',
    '--- stdout ---',
    capSection(log.stdout),
    '',
    '--- stderr ---',
    capSection(log.stderr),
    '',
  ].join('\n');

/**
 * Writes `build.log`, the final screens (`screens/`) and the program output of every run (`logs/`) below the student's
 * output directory; sets `ScenarioResult.artifacts`. Run logs are written for all runs, including those that only hidden
 * checks look at: students see what their own program printed, hidden checks hide the expectation, not the output.
 */
async function writeArtifacts(studentDir: string, build: BuildResult, scenarios: ScenarioResult[], warnings: string[]): Promise<void> {
  if (isShuttingDown()) return; // an interrupted run leaves nothing new behind
  // A re-run into the same outDir must not leave files of the previous run next to the new result.
  try {
    await rm(join(studentDir, 'build.log'), { force: true });
    await rm(join(studentDir, 'screens'), { recursive: true, force: true });
    await rm(join(studentDir, 'logs'), { recursive: true, force: true });
    // temp files that a killed grader left from an atomic write
    for (const name of await readdir(studentDir).catch(() => [] as string[])) {
      if (isAtomicTempName(name)) await rm(join(studentDir, name), { force: true });
    }
  } catch (error) {
    warnings.push(`cannot remove stale artifacts: ${messageOf(error)}`);
  }

  try {
    if (build.log !== '') {
      await mkdir(studentDir, { recursive: true });
      await writeFileAtomic(join(studentDir, 'build.log'), build.log);
    }
  } catch (error) {
    warnings.push(`cannot write build.log: ${messageOf(error)}`);
  }

  const used = new Set<string>();
  const usedLogs = new Set<string>();
  for (const scenario of scenarios) {
    scenario.artifacts = [];
    for (const [runId, log] of Object.entries(scenario.logs ?? {})) {
      if (isShuttingDown()) return;
      const base = `${fileSafe(scenario.id)}-${fileSafe(runId)}`;
      let name = base;
      for (let n = 2; usedLogs.has(name); n++) name = `${base}-${n}`;
      usedLogs.add(name);
      const rel = `logs/${name}.txt`;
      try {
        await mkdir(join(studentDir, 'logs'), { recursive: true });
        await writeFileAtomic(join(studentDir, rel), formatRunLog(log));
        scenario.artifacts.push(rel);
      } catch (error) {
        warnings.push(`cannot write ${rel}: ${messageOf(error)}`);
      }
    }
    for (const [sessionId, screen] of Object.entries(scenario.screens ?? {})) {
      if (isShuttingDown()) return;
      const base = `${fileSafe(scenario.id)}-${fileSafe(sessionId)}`;
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
      used.add(name);
      const rel = `screens/${name}.txt`;
      try {
        await mkdir(join(studentDir, 'screens'), { recursive: true });
        await writeFileAtomic(join(studentDir, rel), screen);
        scenario.artifacts.push(rel);
      } catch (error) {
        warnings.push(`cannot write ${rel}: ${messageOf(error)}`);
      }
    }
  }
}

/** Warning of a submission (or run) that the grader's shutdown cut short. */
const INTERRUPTED = 'interrupted: the grader was stopped before this was finished';

/** Thrown inside `gradeSubmission` when the shutdown flag is found set; never leaves the function. */
class InterruptedError extends Error {
  override name = 'InterruptedError';
}

const stopIfShuttingDown = (): void => {
  if (isShuttingDown()) throw new InterruptedError(INTERRUPTED);
};

/**
 * Grades one prepared submission and runs the per-submission reporters. Never throws. When the grader is shutting down
 * it stops at the next step boundary and returns a result with the warning `interrupted`; no artifact is written
 * and no reporter or `onReport` hook runs for it.
 */
export async function gradeSubmission(
  loaded: LoadedAssignment,
  submission: Submission,
  opts: GradeSubmissionOptions,
): Promise<SubmissionResult> {
  const { app, config } = loaded;
  const t = opts.translate ?? createTranslate(opts.locale, app.getCatalogs());
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const tag = `[${submission.id}]`;
  const log = (m: string): void => opts.log(`${tag} ${m}`);
  const warnings = [...submission.warnings];
  const studentDir = join(opts.outDir, submission.id);
  const emit = (event: RunEvent): void => emitEvent(opts.onEvent, event);

  emit({
    schemaVersion: 1,
    type: 'submission-start',
    at: new Date().toISOString(),
    studentId: submission.id,
    displayName: submission.displayName,
  });

  if (opts.manualProvided === true) {
    if (opts.manual === undefined) warnings.push(`student '${submission.id}' is not listed in the manual points file`);
    else {
      const known = new Set((config.groups ?? []).map((g) => g.id));
      for (const group of Object.keys(opts.manual)) {
        if (!known.has(group)) warnings.push(`manual points file: unknown group '${group}' for student '${submission.id}'`);
      }
    }
  }

  let build: BuildResult = { ...rootNotFound(), message: BUILD_CODES.internalError };
  let scenarios: ScenarioResult[] = [];
  let score: ScoreResult | undefined;

  try {
    stopIfShuttingDown();
    await fire(app, 'onSubmission', { submission }, warnings);

    if (submission.root === null) {
      build = rootNotFound();
      log('project root not found; build skipped');
    } else {
      log('building');
      build = await runBuild(app, config, submission, log, { assignmentDir: loaded.dir });
      await fire(app, 'onBuild', { submission, build }, warnings);
    }
    emit({
      schemaVersion: 1,
      type: 'build',
      at: new Date().toISOString(),
      studentId: submission.id,
      ok: build.ok,
      ...(build.message === undefined ? {} : { message: build.message }),
      warnings: build.warnings,
      durationMs: build.durationMs,
    });

    const env: ScenarioEnv = {
      app,
      submission,
      binaryPath: build.ok ? build.binaryPath : undefined,
      projectDir: submission.root ?? undefined,
      build,
      locale: opts.locale,
      t,
      assignmentDir: loaded.dir,
      limits: {
        runTimeoutMs: Math.round(config.limits.run_timeout_sec * 1000),
        outputLimitBytes: config.limits.output_limit_bytes,
      },
      log,
    };
    const selected = opts.only === undefined ? loaded.scenarios : loaded.scenarios.filter((s) => opts.only?.includes(s.id));
    stopIfShuttingDown();
    for (const scenario of selected) {
      stopIfShuttingDown();
      log(`scenario ${scenario.id}`);
      emit({
        schemaVersion: 1,
        type: 'scenario-start',
        at: new Date().toISOString(),
        studentId: submission.id,
        scenarioId: scenario.id,
        title: localize(scenario.title, opts.locale),
        ...(scenario.group === undefined ? {} : { group: scenario.group }),
      });
      const scenarioResult = await runScenarioSafely(env, scenario);
      scenarios.push(scenarioResult);
      emit({
        schemaVersion: 1,
        type: 'scenario-end',
        at: new Date().toISOString(),
        studentId: submission.id,
        scenarioId: scenario.id,
        status: scenarioResult.status,
        durationMs: scenarioResult.durationMs,
      });
    }
    stopIfShuttingDown();

    const scorer = app.lookup('scorer', config.scoring.use);
    if (scorer === undefined) throw new Error(`unknown scorer '${config.scoring.use}'`);
    const scorerOptions: unknown = scorer.params.parse({ rounding: config.scoring.rounding, cap: config.scoring.cap });
    score = scorer.score(
      {
        assignment: config,
        buildOk: build.ok,
        scenarios,
        ...(opts.manual === undefined ? {} : { manual: opts.manual }),
      },
      scorerOptions,
    );
    const payload = { submission, score };
    await fire(app, 'onScore', payload, warnings);
    score = payload.score;
    emit({
      schemaVersion: 1,
      type: 'submission-score',
      at: new Date().toISOString(),
      studentId: submission.id,
      points: score.points,
      max: score.max,
    });
  } catch (error) {
    if (!(error instanceof InterruptedError)) warnings.push(`internal error while grading: ${messageOf(error)}`);
  }
  const interrupted = isShuttingDown();
  if (interrupted) warnings.push(INTERRUPTED);

  const result: SubmissionResult = {
    schemaVersion: 1,
    assignment: config.name,
    locale: opts.locale,
    student: { id: submission.id, displayName: submission.displayName, parts: submission.parts },
    source: { path: submission.sourcePath, kind: submission.kind, root: submission.root },
    startedAt,
    durationMs: 0,
    structure: { rootFound: submission.root !== null },
    build: {
      ok: build.ok,
      ...(build.message === undefined ? {} : { message: build.message }),
      exitCode: build.exitCode,
      timedOut: build.timedOut,
      warnings: build.warnings,
      durationMs: build.durationMs,
      log: build.log,
    },
    scenarios,
    score: score ?? zeroScore(loaded),
    warnings,
  };

  if (!interrupted) await writeArtifacts(studentDir, build, scenarios, warnings);
  result.durationMs = Date.now() - started;
  const finish = (): SubmissionResult => {
    emit({
      schemaVersion: 1,
      type: 'submission-end',
      at: new Date().toISOString(),
      studentId: submission.id,
      result: compactResult(result),
    });
    return result;
  };
  if (opts.keepWorkdirs === true) {
    unregisterTempDir(submission.workDir);
    log(`workdir kept: ${submission.workDir}`);
  } else {
    try {
      await cleanupSubmission(submission);
    } catch (error) {
      warnings.push(`cannot remove workdir ${submission.workDir}: ${messageOf(error)}`);
    }
  }

  const ctx: ReporterContext = { app, locale: opts.locale, t, outDir: opts.outDir, assignment: config };
  if (interrupted) {
    log('interrupted');
    return finish();
  }
  for (const { name, def } of app.list('reporter')) {
    if (isShuttingDown()) break; // the signal arrived while reporting: no further file is started
    if (def.reportSubmission === undefined) continue;
    try {
      await def.reportSubmission(ctx, result, def.params ? def.params.parse({}) : {});
    } catch (error) {
      warnings.push(`reporter ${name} failed: ${messageOf(error)}`);
    }
  }
  if (isShuttingDown()) {
    warnings.push(INTERRUPTED);
    log('interrupted');
    return finish();
  }
  await fire(app, 'onReport', { submission, result, outDir: opts.outDir }, warnings);
  log(`done: ${result.score.points}/${result.score.max}`);
  return finish();
}

/** `runScenario` does not throw by contract; this is the last line of defence (e.g. no temp dir). */
async function runScenarioSafely(env: ScenarioEnv, scenario: ScenarioIR): Promise<ScenarioResult> {
  try {
    return await runScenario(env, scenario);
  } catch (error) {
    return {
      id: scenario.id,
      title: scenario.title,
      ...(scenario.group === undefined ? {} : { group: scenario.group }),
      weight: scenario.weight,
      status: 'error',
      steps: [],
      checks: [],
      error: messageOf(error),
      durationMs: 0,
      artifacts: [],
    };
  }
}

const warn = (path: string, message: string): Issue => ({ path, message, severity: 'warning' });
const describeIssue = (i: Issue): string => `${i.path}: ${i.message}`;

/**
 * Grades every submission found under `opts.inputPath`. Throws `ConfigError` when the assignment has
 * error issues (or the manual points file is unusable); everything else is reported per submission.
 * `issues` of the return value holds the non-fatal (warning) issues.
 */
export async function gradeAll(opts: RunOptions): Promise<{ results: SubmissionResult[]; outDir: string; issues: Issue[] }> {
  const log = opts.log ?? ((): void => {});
  const outDir = resolve(opts.outDir);

  const loaded = await loadAssignment(opts.assignmentDir, opts.extraPlugins === undefined ? {} : { extraPlugins: opts.extraPlugins });
  const all = [...loaded.issues, ...validateAssignment(loaded)];
  const errors = all.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new ConfigError(`assignment is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((i) => `  ${describeIssue(i)}`).join('\n')}`, all);
  }
  const issues = all.filter((i) => i.severity === 'warning');
  const locale = opts.locale ?? loaded.config.locale;
  const emit = (event: RunEvent): void => emitEvent(opts.onEvent, event);
  emit({
    schemaVersion: 1,
    type: 'run-start',
    at: new Date().toISOString(),
    assignment: loaded.config.name,
    assignmentDir: loaded.dir,
    inputPath: resolve(opts.inputPath),
    outDir,
    locale,
    scenarioCount: loaded.scenarios.length,
  });

  let manual: Record<string, Record<string, number>> | undefined;
  if (opts.manualFile !== undefined) {
    try {
      manual = await loadManualPoints(opts.manualFile);
    } catch (error) {
      const issue: Issue = { path: opts.manualFile, message: messageOf(error), severity: 'error' };
      throw new ConfigError(issue.message, [issue]);
    }
  }

  if (opts.only !== undefined) {
    const ids = new Set(loaded.scenarios.map((s) => s.id));
    for (const id of opts.only) if (!ids.has(id)) issues.push(warn('--only', `no scenario with id '${id}'`));
  }

  const t = opts.translate ?? createTranslate(locale, loaded.app.getCatalogs());
  const submissions = await discoverSubmissions(opts.inputPath, loaded.config);
  if (opts.keepWorkdirs === true) for (const s of submissions) unregisterTempDir(s.workDir);
  log(`found ${submissions.length} submission${submissions.length === 1 ? '' : 's'}`);
  emit({ schemaVersion: 1, type: 'submissions', at: new Date().toISOString(), count: submissions.length });

  if (manual !== undefined) {
    const students = new Set(submissions.map((s) => s.id));
    for (const id of Object.keys(manual)) {
      if (!students.has(id)) issues.push(warn(opts.manualFile as string, `manual points for unknown student '${id}'`));
    }
  }

  const results: SubmissionResult[] = [];
  const graded = new Set<Submission>();
  try {
    const run: RunInfo = { assignment: loaded.config.name, startedAt: new Date().toISOString(), inputPath: resolve(opts.inputPath), outDir };
    try {
      await loaded.app.runHooks('onRunStart', { run }, { failFast: true });
    } catch (error) {
      throw new Error(`onRunStart hook failed: ${messageOf(error)}`, { cause: error });
    }
    await mkdir(outDir, { recursive: true });
    await writeRunMetadata(outDir, {
      schemaVersion: 1,
      assignment: loaded.config.name,
      assignmentDir: loaded.dir,
      inputPath: resolve(opts.inputPath),
      outDir,
      startedAt: run.startedAt,
      locale,
      version: VERSION,
      ...(opts.manualFile === undefined ? {} : { manualFile: resolve(opts.manualFile) }),
    });

    for (const submission of submissions) {
      if (isShuttingDown()) break; // no new submission is started once the grader is stopping
      const studentManual = manual?.[submission.id];
      results.push(
        await gradeSubmission(loaded, submission, {
          outDir,
          ...(opts.only === undefined ? {} : { only: opts.only }),
          locale,
          ...(studentManual === undefined ? {} : { manual: studentManual }),
          manualProvided: manual !== undefined,
          ...(opts.keepWorkdirs === undefined ? {} : { keepWorkdirs: opts.keepWorkdirs }),
          translate: t,
          log,
          ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
        }),
      );
      graded.add(submission); // gradeSubmission already removed its workdir (and warned on failure)
    }

    if (isShuttingDown()) {
      // Stopped by a signal: no run-level report (it would describe a partial run), no onRunEnd.
      issues.push(warn('run', INTERRUPTED));
    } else {
      const ctx: ReporterContext = { app: loaded.app, locale, t, outDir, assignment: loaded.config };
      for (const { name, def } of loaded.app.list('reporter')) {
        if (isShuttingDown()) break;
        if (def.reportRun === undefined) continue;
        try {
          await def.reportRun(ctx, results, def.params ? def.params.parse({}) : {});
        } catch (error) {
          issues.push(warn(`reporter#/${name}`, `reporter ${name} failed: ${messageOf(error)}`));
        }
      }

      const endWarnings: string[] = [];
      if (!isShuttingDown()) await fire(loaded.app, 'onRunEnd', { run, results, outDir }, endWarnings);
      for (const message of endWarnings) issues.push(warn('onRunEnd', message));
      if (isShuttingDown()) issues.push(warn('run', INTERRUPTED));
    }
  } finally {
    if (opts.keepWorkdirs !== true) {
      for (const s of submissions) {
        if (graded.has(s)) continue;
        try {
          await cleanupSubmission(s);
        } catch (error) {
          // The run is aborting (the exception discards `issues`), so the log callback is the only channel left.
          log(`cannot remove workdir ${s.workDir}: ${messageOf(error)}`);
        }
      }
    }
  }

  emit({
    schemaVersion: 1,
    type: 'run-end',
    at: new Date().toISOString(),
    outDir,
    interrupted: isShuttingDown(),
    results: results.map((result) => ({
      studentId: result.student.id,
      displayName: result.student.displayName,
      points: result.score.points,
      max: result.score.max,
    })),
    issues,
  });
  return { results, outDir, issues };
}
