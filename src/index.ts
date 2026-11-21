export { VERSION } from './core/version.ts';

export { App } from './core/app.ts';
export { ConfigError, type RunOptions, gradeAll } from './core/lifecycle.ts';
export { defineBuilder, defineCheck, defineReporter, defineScorer, definePlugin, defineStep, fp } from './core/plugin.ts';
export type { Kind, PluginDef, PluginFn, PluginMeta } from './core/plugin.ts';
export type * from './core/contracts.ts';
export type { RunEvent } from './core/events.ts';
export type { HookFailure, HookFn, HookName, HookPayloads, RunInfo } from './core/hooks.ts';
export { minimalEnv, runProcess, type ProcessOptions, type ProcessResult } from './core/process.ts';
export { PathEscapeError, normalizeText, safeJoin } from './core/workspace.ts';
export { publicResult } from './plugins/reporter-shared.ts';
export { createGrader } from './grader.ts';
export type { CheckReport, DescribeEntry, Grader, GraderOptions, ScenarioSummary } from './grader.ts';
export { z } from 'zod';
