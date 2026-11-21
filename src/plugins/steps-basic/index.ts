import { copyFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, normalize, sep } from 'node:path';
import { z } from 'zod';
import type { Issue, ScenarioContext, ValidateContext } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { runProcess } from '../../core/process.ts';
import { copyDir, safeJoin } from '../../core/workspace.ts';
import { loadScript, workdirPath } from '../shared.ts';

const error = (path: string, message: string): Issue => ({ path, message, severity: 'error' });

/** Paths with `${...}` can only be judged at run time (steps that interpolate them; `copy` does not allow them). */
const hasVariable = (value: string): boolean => value.includes('${');

const copyParams = z.union([z.string().min(1), z.strictObject({ from: z.string().min(1), to: z.string().min(1).optional() })]);

const writeFileParams = z.strictObject({ path: z.string().min(1), content: z.string() });

const runParams = z.preprocess(
  (value) => value ?? {}, // `run:` with no parameters
  z.strictObject({
    args: z.array(z.string()).default([]),
    stdin: z.string().optional(), // text to feed, or 'closed' (the default behaves the same: stdin is ended)
    timeout: z.number().positive().optional(), // seconds
    env: z.record(z.string(), z.string()).optional(),
  }),
);

const scriptParams = z.strictObject({ path: z.string().min(1), options: z.unknown().optional() });

function validateScript(params: z.output<typeof scriptParams>, v: ValidateContext): Issue[] {
  let file: string;
  try {
    file = safeJoin(v.assignmentDir, params.path);
  } catch (e) {
    return [error('/path', e instanceof Error ? e.message : String(e))];
  }
  return existsSync(file) ? [] : [error('/path', `script not found: ${params.path}`)];
}

async function copyStep(ctx: ScenarioContext, params: z.output<typeof copyParams>): Promise<void> {
  const { from, to = from } = typeof params === 'string' ? { from: params } : params;
  const fromPath = ctx.interpolate(from);
  const source = safeJoin(ctx.fixturesDir, fromPath);
  const dest = workdirPath(ctx, to);

  const stats = await lstat(source).catch(() => undefined);
  if (stats === undefined) throw new Error(`fixture not found: ${from}`);
  if (stats.isSymbolicLink()) throw new Error(`fixture is a symbolic link: ${from}`);
  if (stats.isDirectory()) {
    await copyDir(source, dest, { filter: (_path, entry) => !entry.isSymbolicLink() });
  } else {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);
  }
}

export const stepsBasic = fp(
  (app) => {
    app.step('copy', {
      description: 'Copies a file or directory from the assignment fixtures into the scenario workdir.',
      example: '- copy: input.txt\n- copy: { from: data/big.txt, to: input.txt }',
      params: copyParams,
      validate(params, v) {
        const from = typeof params === 'string' ? params : params.from;
        const to = typeof params === 'string' ? undefined : params.to;
        const fromPath = typeof params === 'string' ? '' : '/from';
        const message = 'variables are not allowed in copy paths; paths are relative to fixtures/';
        const issues: Issue[] = [];
        if (hasVariable(from)) issues.push(error(fromPath, message));
        if (to !== undefined && hasVariable(to)) issues.push(error('/to', message));
        if (issues.length > 0) return issues;
        return v.fixtureExists(from) ? [] : [error(fromPath, `fixture not found: ${from}`)];
      },
      run: copyStep,
    });

    app.step('write_file', {
      description: 'Writes a text file inside the scenario workdir.',
      example: '- write_file: { path: config.txt, content: "mode=fast\\n" }',
      params: writeFileParams,
      validate(params) {
        if (hasVariable(params.path)) return [];
        const escapes = isAbsolute(params.path) || normalize(params.path).split(sep)[0] === '..';
        return escapes ? [error('/path', `path must stay inside the workdir: ${params.path}`)] : [];
      },
      async run(ctx, params) {
        const target = workdirPath(ctx, params.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, ctx.interpolate(params.content));
      },
    });

    app.step('run', {
      description: 'Runs the student program once with the given arguments and stdin; records stdout, stderr and the exit code.',
      example: '- run: { args: ["--help"], stdin: "closed", timeout: 5 }',
      params: runParams,
      produces: 'run',
      async run(ctx, params: z.output<typeof runParams>) {
        const binary = ctx.binaryPath;
        if (binary === undefined) throw new Error('build_failed');
        const id = ctx.currentStepId ?? `run-${ctx.runs.size + 1}`;
        const args = ctx.interpolate(params.args);
        const env = params.env === undefined ? undefined : ctx.interpolate(params.env);
        const result = await runProcess({
          command: binary,
          args,
          cwd: ctx.workdir,
          ...(env === undefined ? {} : { env }),
          ...(params.stdin === undefined ? {} : { stdin: params.stdin }),
          timeoutMs: params.timeout === undefined ? ctx.limits.runTimeoutMs : Math.round(params.timeout * 1000),
          outputLimitBytes: ctx.limits.outputLimitBytes,
        });
        if (result.spawnError !== undefined) throw new Error(`cannot start the program: ${result.spawnError}`);
        const record = {
          id,
          args,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
        };
        ctx.runs.set(id, record);
        ctx.lastRun = record;
      },
    });

    app.step('script', {
      description: 'Runs a custom ES module from the assignment: its default export is called with (ctx, options).',
      example: '- script: { path: scripts/prepare.mjs, options: { size: 10 } }',
      params: scriptParams,
      validate: validateScript,
      async run(ctx, params) {
        const fn = await loadScript(ctx.assignmentDir, ctx.interpolate(params.path));
        await fn(ctx, ctx.interpolate(params.options));
      },
    });
  },
  { name: 'steps-basic' },
);
