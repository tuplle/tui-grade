// Data-model contracts shared by the kernel, plugins and reporters. Types only: no runtime code.
import type { z } from 'zod';
import type { App } from './app.ts';
import type { Kind } from './plugin.ts';

export type LocalizedText = string | Record<string, string>; // { en, sk }
export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export interface Issue {
  path: string; // "file#/json/pointer"
  message: string;
  severity: 'error' | 'warning';
}

// ---- Scenario intermediate representation -------------------------------------------------

export interface StepSpec {
  name: string;
  params: unknown;
  id?: string;
  pointer: string;
}
export interface CheckSpec {
  name: string;
  params: unknown;
  from?: string;
  weight: number;
  hidden: boolean;
  not: boolean;
  pointer: string;
}
export interface ScenarioIR {
  id: string;
  title: LocalizedText;
  group?: string;
  weight: number;
  steps: StepSpec[];
  expect: CheckSpec[];
  file: string;
  pointer: string;
  vars: Record<string, string>;
}

// ---- Run-time records and results ---------------------------------------------------------

export interface RunRecord {
  id: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}
export interface SessionRecord {
  id: string;
  screen: string;
  exitCode: number | null;
  exited: boolean;
  timedOut: boolean;
  durationMs: number;
}
export interface StepRecord {
  name: string;
  id?: string;
  ok: boolean;
  message?: string;
  durationMs: number;
}
export interface ScenarioResult {
  id: string;
  title: LocalizedText;
  group?: string;
  weight: number;
  status: 'passed' | 'failed' | 'error';
  steps: StepRecord[];
  checks: CheckResult[];
  error?: string;
  durationMs: number;
  artifacts: string[];
  screens?: Record<string, string>; // session id → final screen text (filled by runScenario)
  /** run id → what the program printed (filled by runScenario; delivered as `logs/` files, never inline in results). */
  logs?: Record<string, { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
}

export interface ScenarioContext {
  // handed to steps
  readonly app: App;
  readonly locale: string;
  readonly t: Translate;
  readonly binaryPath: string | undefined; // undefined when the build failed
  readonly projectDir: string | undefined; // project root of the submission (undefined when not found)
  readonly build: BuildResult | undefined;
  readonly workdir: string;
  readonly assignmentDir: string;
  readonly fixturesDir: string;
  readonly vars: Record<string, string>;
  readonly runs: Map<string, RunRecord>;
  readonly sessions: Map<string, SessionRecord>;
  lastRun?: RunRecord;
  lastSession?: SessionRecord;
  /**
   * Set by the executor while a step with `produces` runs: the id the produced record must be
   * registered under (the step's `id` or an auto id `run-N` / `session-N`).
   */
  currentStepId?: string;
  limits: { runTimeoutMs: number; outputLimitBytes: number };
  resolvePath(rel: string): string; // inside workdir; throws on escape
  interpolate<T>(value: T): T; // replaces ${binary} ${workdir} ${fixtures} (matrix vars are already substituted at load)
  log(message: string): void;
}
export interface CheckContext extends ScenarioContext {
  run?: RunRecord;
  session?: SessionRecord;
  evaluate(spec: CheckSpec): Promise<CheckResult>;
}
export interface CheckOutcome {
  pass: boolean;
  message?: string;
  expected?: string;
  actual?: string;
}
export interface CheckResult {
  name: string;
  description: string;
  pass: boolean;
  weight: number;
  hidden: boolean;
  message?: string;
  expected?: string;
  actual?: string;
}

// ---- Plugin definitions -------------------------------------------------------------------

export interface ValidateContext {
  assignmentDir: string;
  fixturesDir: string;
  fixtureExists(rel: string): boolean;
  knownVars: string[];
}
export interface StepDef<P = any> {
  description: string;
  example?: string;
  params: z.ZodType<P>;
  produces?: 'run' | 'session'; // steps that create a RunRecord/SessionRecord
  validate?(params: P, v: ValidateContext): Issue[];
  run(ctx: ScenarioContext, params: P): Promise<void>;
}
export interface CheckDef<P = any> {
  description: string;
  example?: string;
  params: z.ZodType<P>;
  source: 'run' | 'session' | 'either' | 'none'; // which record the check reads (validated statically, §6)
  nested?(params: P): CheckSpec[]; // composite checks (any_of/all_of)
  validate?(params: P, v: ValidateContext): Issue[];
  describe(params: P, t: Translate): string;
  run(ctx: CheckContext, params: P): Promise<CheckOutcome>;
}
export interface BuildResult {
  ok: boolean;
  binaryPath?: string;
  log: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  warnings: number;
  message?: string;
}
export interface BuildContext {
  projectDir: string;
  limits: { buildTimeoutMs: number; outputLimitBytes: number };
  log(m: string): void;
}
export interface BuilderDef<P = any> {
  description: string;
  params: z.ZodType<P>;
  build(ctx: BuildContext, params: P): Promise<BuildResult>;
}
export interface ReporterContext {
  app: App;
  locale: string;
  t: Translate;
  outDir: string;
  assignment: AssignmentConfig;
}
/**
 * Reporters run after a submission is graded. The submission's workdir has already been removed by then
 * (unless `keepWorkdirs`), so reporters must only use data from the result and write below `ctx.outDir`;
 * paths such as `result.source.root` must not be read from disk.
 */
export interface ReporterDef<P = any> {
  description: string;
  scope: 'submission' | 'run';
  params?: z.ZodType<P>;
  reportSubmission?(ctx: ReporterContext, result: SubmissionResult, opts: P): Promise<void>;
  reportRun?(ctx: ReporterContext, results: SubmissionResult[], opts: P): Promise<void>;
}
export interface ScorerDef<P = any> {
  description: string;
  params: z.ZodType<P>;
  score(input: ScoreInput, opts: P): ScoreResult;
}

/** Maps a plugin kind to its definition type. */
export interface DefMap {
  step: StepDef;
  check: CheckDef;
  builder: BuilderDef;
  reporter: ReporterDef;
  scorer: ScorerDef;
}
export type DefOf<K extends Kind> = DefMap[K];

// ---- Assignment configuration (Task 5) ----------------------------------------------------

export interface AssignmentConfig {
  name: string;
  max_points: number;
  locale: 'en' | 'sk';
  build: { type: string } & Record<string, unknown>; // builder name + its params
  binary?: string; // relative to project root, overrides builder output
  project_root_marker: string; // required, e.g. 'src/main.c'
  project_root_depth: number; // default 2
  student_id?: { pattern?: string; strip_prefix?: string }; // regex with named groups
  groups?: Array<{
    id: string;
    title: LocalizedText;
    points: number;
    manual?: boolean;
    requires_build?: boolean;
  }>;
  scoring: { use: string; rounding: 'none' | 'floor' | 'round' | 'ceil'; cap: boolean }; // defaults: proportional, none, true
  plugins: Array<string | { use: string; options?: unknown }>;
  preset: 'default' | 'none';
  template?: string; // dir with files overlaid before the build
  limits: {
    build_timeout_sec: number;
    run_timeout_sec: number;
    output_limit_bytes: number;
    unzip_max_bytes: number;
    unzip_max_files: number;
  }; // 120, 10, 1048576, 524288000, 20000
}

// ---- Submission intake (Task 7) -----------------------------------------------------------

export interface Submission {
  id: string;
  displayName: string;
  parts: Record<string, string>;
  sourcePath: string;
  kind: 'dir' | 'zip';
  workDir: string;
  root: string | null;
  warnings: string[];
}

// ---- Scoring (Task 13) --------------------------------------------------------------------

export interface ScoreInput {
  assignment: AssignmentConfig;
  buildOk: boolean;
  scenarios: ScenarioResult[];
  manual?: Record<string, number>; // groupId → points
}
export interface GroupScore {
  id: string;
  title: LocalizedText;
  max: number;
  points: number;
  manual: boolean;
  pending: boolean;
  requiresBuild: boolean;
  scenarios: Array<{ id: string; points: number; max: number }>;
}
export interface ScoreResult {
  points: number;
  max: number;
  automaticPoints: number;
  groups: GroupScore[];
  ungrouped: Array<{ id: string; points: number; max: number }>;
  rounding: string;
}

// ---- Results model (Task 14) --------------------------------------------------------------

export interface SubmissionResult {
  schemaVersion: 1;
  assignment: string;
  locale: string;
  student: { id: string; displayName: string; parts: Record<string, string> };
  source: { path: string; kind: 'dir' | 'zip'; root: string | null };
  startedAt: string;
  durationMs: number;
  structure: { rootFound: boolean };
  build: {
    ok: boolean;
    message?: string;
    exitCode: number | null;
    timedOut: boolean;
    warnings: number;
    durationMs: number;
    log: string;
  };
  scenarios: ScenarioResult[];
  score: ScoreResult;
  warnings: string[]; // intake warnings + hook failures
}
