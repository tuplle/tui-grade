import { access, constants, lstat, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { App } from './app.ts';
import type { AssignmentConfig, BuildContext, BuildResult, Submission } from './contracts.ts';
import { runProcess } from './process.ts';
import { copyDir, safeJoin } from './workspace.ts';

/** Machine-readable `BuildResult.message` codes; reporters translate them via the `build.<code>` catalog keys. */
export const BUILD_CODES = {
  buildFailed: 'build_failed',
  buildTimeout: 'build_timeout',
  buildOutputLimit: 'build_output_limit',
  binaryMissing: 'binary_missing',
  binaryNotExecutable: 'binary_not_executable',
  projectRootNotFound: 'project_root_not_found',
  internalError: 'internal_error',
} as const;

/** The build log kept in a result is capped to this many bytes (tail kept). */
export const BUILD_LOG_CAP_BYTES = 64 * 1024;

export interface RunBuildOptions {
  /** Directory of `assignment.yaml`; `cfg.template` is resolved relative to it. */
  assignmentDir: string;
  /** Overrides the limits derived from `cfg.limits` (used by tests and the CLI). */
  limits?: { buildTimeoutMs?: number; outputLimitBytes?: number };
}

export const countWarnings = (log: string): number => log.split('\n').filter((line) => /warning:/.test(line)).length;

/** Keeps the last `cap` bytes of `log` and prepends a marker line when something was dropped. */
export function capLog(log: string, cap: number = BUILD_LOG_CAP_BYTES): string {
  const buf = Buffer.from(log, 'utf8');
  if (buf.length <= cap) return log;
  let start = buf.length - cap;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1; // do not start inside a UTF-8 sequence
  const marker = `[... build log truncated: showing the last ${buf.length - start} of ${buf.length} bytes ...]\n`;
  return marker + buf.subarray(start).toString('utf8');
}

/**
 * Runs one build command (argv, no shell) in the project directory and maps the outcome to a
 * `BuildResult` without a binary path. Never rejects.
 */
export async function execBuildCommand(
  ctx: BuildContext,
  command: string,
  args: string[],
  timeoutMs: number = ctx.limits.buildTimeoutMs,
): Promise<BuildResult> {
  ctx.log(`$ ${[command, ...args].join(' ')}`);
  const r = await runProcess({
    command,
    args,
    cwd: ctx.projectDir,
    stdin: 'closed',
    timeoutMs,
    outputLimitBytes: ctx.limits.outputLimitBytes,
  });
  const log = r.stdout + r.stderr;
  const result: BuildResult = {
    ok: r.exitCode === 0 && !r.timedOut && !r.truncated && r.spawnError === undefined,
    log,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    warnings: countWarnings(log),
  };
  if (r.spawnError !== undefined) result.message = `cannot start '${command}': ${r.spawnError}`;
  else if (r.timedOut) result.message = BUILD_CODES.buildTimeout;
  else if (r.truncated) result.message = BUILD_CODES.buildOutputLimit;
  else if (r.exitCode !== 0) result.message = BUILD_CODES.buildFailed;
  return result;
}

const fail = (message: string, started: number, log = ''): BuildResult => ({
  ok: false,
  log,
  exitCode: null,
  timedOut: false,
  durationMs: Date.now() - started,
  warnings: 0,
  message,
});

/**
 * Copies the template directory over the project. Symlinks inside the template are skipped, and a
 * symlink the student placed where a template entry goes is removed first, so the overlay can
 * neither be redirected out of the project nor write through a link.
 */
async function applyTemplate(templateDir: string, root: string): Promise<void> {
  const info = await stat(templateDir).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new Error(`template directory not found: ${templateDir}`);

  const clear = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = relative(templateDir, join(dir, entry.name));
      safeJoin(root, dirname(rel)); // the destination's parent must stay inside the project
      const dest = join(resolve(root), rel); // `rel` comes from walking the template, so it has no `..`
      if ((await lstat(dest).catch(() => undefined))?.isSymbolicLink()) await rm(dest);
      if (entry.isDirectory()) await clear(join(dir, entry.name));
    }
  };
  await clear(templateDir);
  await copyDir(templateDir, root, { filter: (_src, stats) => !stats.isSymbolicLink() });
}

async function verifyBinary(root: string, rel: string): Promise<{ path: string } | { message: string }> {
  const path = safeJoin(root, rel);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return { message: BUILD_CODES.binaryMissing };
  if (!info.isFile()) return { message: BUILD_CODES.binaryNotExecutable };
  try {
    await access(path, constants.X_OK);
  } catch {
    return { message: BUILD_CODES.binaryNotExecutable };
  }
  return { path };
}

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Builds a submission: applies the template overlay, runs the configured builder, verifies that the
 * binary exists and is executable, caps the log and counts warnings. Never throws.
 */
export async function runBuild(
  app: App,
  cfg: AssignmentConfig,
  submission: Submission,
  workdirLog: (m: string) => void,
  opts: RunBuildOptions,
): Promise<BuildResult> {
  const started = Date.now();
  try {
    const root = submission.root;
    if (root === null) return fail(BUILD_CODES.projectRootNotFound, started);

    const { type, ...rawParams } = cfg.build;
    const builder = app.lookup('builder', type);
    if (builder === undefined) return fail(`unknown builder '${type}'`, started);
    const parsed = builder.params.safeParse(rawParams);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return fail(`invalid build params for '${type}': ${detail}`, started);
    }

    if (cfg.template !== undefined) {
      try {
        await applyTemplate(resolve(opts.assignmentDir, cfg.template), root);
      } catch (e) {
        return fail(`template overlay failed: ${describeError(e)}`, started);
      }
      workdirLog(`template '${cfg.template}' applied`);
    }

    const ctx: BuildContext = {
      projectDir: root,
      limits: {
        buildTimeoutMs: opts.limits?.buildTimeoutMs ?? cfg.limits.build_timeout_sec * 1000,
        outputLimitBytes: opts.limits?.outputLimitBytes ?? cfg.limits.output_limit_bytes,
      },
      log: workdirLog,
    };
    const built = await builder.build(ctx, parsed.data);
    const result: BuildResult = { ...built, warnings: countWarnings(built.log), durationMs: 0 };
    delete result.binaryPath;

    if (built.ok) {
      // Builders report an absolute path; `cfg.binary` is relative to the project root.
      const rel = cfg.binary ?? (built.binaryPath === undefined ? undefined : relative(root, built.binaryPath));
      const checked = rel === undefined ? { message: BUILD_CODES.binaryMissing } : await verifyBinary(root, rel);
      if ('path' in checked) result.binaryPath = checked.path;
      else {
        result.ok = false;
        result.message = checked.message;
      }
    }
    result.log = capLog(result.log);
    result.durationMs = Date.now() - started;
    workdirLog(result.ok ? 'build ok' : `build failed: ${result.message ?? 'unknown'}`);
    return result;
  } catch (e) {
    return fail(describeError(e), started);
  }
}
