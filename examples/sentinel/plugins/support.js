// Shared helpers of the SENTINEL plugins.
//
// Importing the framework: a standalone grading project installs the package and uses
//   import { definePlugin, runProcess, z } from 'tui-grade';
// Inside this repository the package is not installed under that name, so the sources are tried first and the package
// is the fallback; the same plugin files then run unchanged in both places.
// Only a missing `src/index.ts` triggers the fallback: any other error (a syntax or dependency error inside src/)
// is rethrown, so it is never hidden behind a stale `dist/` or package.
// This file is deliberately duplicated in every example (examples/*/plugins/support.js): each example has to stay a
// standalone project that can be copied out of the repository.
import { existsSync } from 'node:fs';

const NOT_FOUND = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'];

/** True when `error` says that the missing module is the repository entry point itself (`Cannot find module '.../src/index.ts' imported from ...`). */
const isMissingSources = (error) =>
  error !== null && typeof error === 'object' && NOT_FOUND.includes(error.code) && /Cannot find module '[^']*src\/index\.ts'/.test(String(error.message));

/** The framework API: the repository sources when present, else the installed package. The importers are injectable for tests. */
export async function loadFramework(
  importSources = () => import('../../../src/index.ts'),
  importPackage = () => import('tui-grade'),
) {
  try {
    return await importSources();
  } catch (error) {
    if (!isMissingSources(error)) throw error;
    return importPackage();
  }
}

const framework = await loadFramework();

export const { definePlugin, runProcess, z } = framework;

/** First non-empty line of a program's output, for error messages. */
const firstLine = (text) => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

/**
 * Runs the student program once inside the scenario workdir (where the state files live) as a setup action.
 * Unlike the `run` step it records nothing for the checks: a setup that does not work is an error of the step.
 * `stateFile` has to exist afterwards; it is the file the scenario goes on with.
 */
export async function runSetup(ctx, label, args, stateFile) {
  if (ctx.binaryPath === undefined) throw new Error('build_failed');
  const result = await runProcess({
    command: ctx.binaryPath,
    args,
    cwd: ctx.workdir,
    stdin: 'closed',
    timeoutMs: ctx.limits.runTimeoutMs,
    outputLimitBytes: ctx.limits.outputLimitBytes,
  });
  const command = `sentinel ${args.join(' ')}`;
  if (result.spawnError !== undefined) throw new Error(`${label}: cannot start the program: ${result.spawnError}`);
  if (result.timedOut) throw new Error(`${label}: '${command}' timed out`);
  if (result.exitCode !== 0) {
    const reason = firstLine(result.stderr) || firstLine(result.stdout) || 'no output';
    throw new Error(`${label}: '${command}' exited with code ${result.exitCode} (${reason})`);
  }
  if (!existsSync(ctx.resolvePath(stateFile))) throw new Error(`${label}: '${command}' did not create ${stateFile}`);
}
