import type {
  BuildResult,
  CheckResult,
  CheckSpec,
  ScenarioContext,
  ScenarioIR,
  ScenarioResult,
  ScoreResult,
  StepRecord,
  StepSpec,
  Submission,
  SubmissionResult,
} from './contracts.ts';

export interface RunInfo {
  assignment: string;
  startedAt: string;
  inputPath: string;
  outDir: string;
}

/** Payload per lifecycle hook; hooks run sequentially and may mutate the payload objects. */
export interface HookPayloads {
  onRunStart: { run: RunInfo };
  onSubmission: { submission: Submission }; // may mutate submission.root
  onBuild: { submission: Submission; build: BuildResult }; // after the build
  onScenarioStart: { submission: Submission; scenario: ScenarioIR; ctx: ScenarioContext };
  onStep: { scenario: ScenarioIR; step: StepSpec; record: StepRecord };
  onCheck: { scenario: ScenarioIR; check: CheckSpec; result: CheckResult };
  onScenarioEnd: { scenario: ScenarioIR; result: ScenarioResult };
  onScore: { submission: Submission; score: ScoreResult }; // may mutate score
  // Runs after the reporters. The submission's workdir is already removed (unless `keepWorkdirs`): use only
  // data from `result` and files below `outDir`.
  onReport: { submission: Submission; result: SubmissionResult; outDir: string };
  onRunEnd: { run: RunInfo; results: SubmissionResult[]; outDir: string };
}

export type HookName = keyof HookPayloads;
export type HookFn<N extends HookName> = (payload: HookPayloads[N]) => void | Promise<void>;

export interface HookFailure {
  hook: HookName;
  /** Name of the plugin that registered the hook, when it was registered from a named plugin. */
  plugin?: string;
  error: Error;
}
