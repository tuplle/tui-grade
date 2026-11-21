// Structured progress events for machine consumers such as the local web dashboard.
import type { Issue, SubmissionResult } from './contracts.ts';

export const RUN_EVENT_SCHEMA_VERSION = 1 as const;

export interface RunEventBase {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  type: string;
  at: string; // ISO timestamp
}

export interface RunStartEvent extends RunEventBase {
  type: 'run-start';
  assignment: string;
  assignmentDir: string;
  inputPath: string;
  outDir: string;
  locale: string;
  scenarioCount: number;
}

export interface SubmissionsEvent extends RunEventBase {
  type: 'submissions';
  count: number;
}

export interface SubmissionStartEvent extends RunEventBase {
  type: 'submission-start';
  studentId: string;
  displayName: string;
}

export interface BuildEvent extends RunEventBase {
  type: 'build';
  studentId: string;
  ok: boolean;
  message?: string;
  warnings: number;
  durationMs: number;
}

export interface ScenarioStartEvent extends RunEventBase {
  type: 'scenario-start';
  studentId: string;
  scenarioId: string;
  title: string;
  group?: string;
}

export interface ScenarioEndEvent extends RunEventBase {
  type: 'scenario-end';
  studentId: string;
  scenarioId: string;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
}

export interface SubmissionScoreEvent extends RunEventBase {
  type: 'submission-score';
  studentId: string;
  points: number;
  max: number;
}

export interface SubmissionEndEvent extends RunEventBase {
  type: 'submission-end';
  studentId: string;
  /** The complete result, without inline screens/logs (those are delivered as artifacts). */
  result: SubmissionResult;
}

export interface RunEndEvent extends RunEventBase {
  type: 'run-end';
  outDir: string;
  interrupted: boolean;
  results: Array<{ studentId: string; displayName: string; points: number; max: number }>;
  issues: Issue[];
}

export type RunEvent =
  | RunStartEvent
  | SubmissionsEvent
  | SubmissionStartEvent
  | BuildEvent
  | ScenarioStartEvent
  | ScenarioEndEvent
  | SubmissionScoreEvent
  | SubmissionEndEvent
  | RunEndEvent;

/** Emits an event, ignoring listener failures: progress reporting must never change grading. */
export function emitEvent(listener: ((event: RunEvent) => void) | undefined, event: RunEvent): void {
  if (listener === undefined) return;
  try {
    listener(event);
  } catch {
    // The dashboard is an observer; a broken pipe or listener must not fail a run.
  }
}

/** A result without the large inline screen/log maps; artifacts carry those. */
export function compactResult(result: SubmissionResult): SubmissionResult {
  return {
    ...result,
    scenarios: result.scenarios.map(({ screens: _screens, logs: _logs, ...scenario }) => scenario),
  };
}
