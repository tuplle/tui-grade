import type { Issue } from './contracts.ts';

/** Duplicate name in one context, missing dependency, or a plugin that threw. */
export class PluginError extends Error {
  override name = 'PluginError';
}

/** The assignment (or a user-supplied input such as the manual points file) is unusable; carries the offending issues. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly issues: Issue[];

  constructor(message: string, issues: Issue[]) {
    super(message);
    this.issues = issues;
  }
}
