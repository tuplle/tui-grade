import type { App } from './app.ts';
import type { BuilderDef, CheckDef, ReporterDef, ScorerDef, StepDef } from './contracts.ts';

export type PluginFn<O = unknown> = (app: App, opts: O) => void | Promise<void>;
export interface PluginMeta {
  name?: string;
  dependencies?: string[];
}
export interface PluginDef<O = unknown> {
  fn: PluginFn<O>;
  meta: PluginMeta;
  shared: boolean;
}
export type Kind = 'step' | 'check' | 'builder' | 'reporter' | 'scorer';

/** Encapsulated plugin: registrations land in a child context and stay invisible to the parent. */
export function definePlugin<O = unknown>(fn: PluginFn<O>, meta: PluginMeta = {}): PluginDef<O> {
  return { fn, meta, shared: false };
}

/** Shared plugin: registrations land in the parent context. */
export function fp<O = unknown>(fn: PluginFn<O>, meta: PluginMeta = {}): PluginDef<O> {
  return { fn, meta, shared: true };
}

// Identity helpers: they only give editors the type of a definition passed to `app.step(...)` and friends.
export const defineStep = <P = unknown>(def: StepDef<P>): StepDef<P> => def;
export const defineCheck = <P = unknown>(def: CheckDef<P>): CheckDef<P> => def;
export const defineBuilder = <P = unknown>(def: BuilderDef<P>): BuilderDef<P> => def;
export const defineReporter = <P = unknown>(def: ReporterDef<P>): ReporterDef<P> => def;
export const defineScorer = <P = unknown>(def: ScorerDef<P>): ScorerDef<P> => def;
