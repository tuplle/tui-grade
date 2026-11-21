import { relative } from 'node:path';
import { z } from 'zod';
import { execBuildCommand } from '../../core/build.ts';
import type { BuildResult } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { safeJoin } from '../../core/workspace.ts';

const params = z.strictObject({
  source_dir: z.string().min(1).default('.'),
  build_dir: z.string().min(1).default('build'),
  target: z.string().min(1).optional(),
  binary_path: z.string().min(1),
  configure_args: z.array(z.string()).default([]),
});

export const builderCmake = fp(
  (app) => {
    app.builder('cmake', {
      description: 'Configures and builds a CMake project (cmake -S/-B, then cmake --build).',
      params,
      async build(ctx, p: z.output<typeof params>): Promise<BuildResult> {
        // Paths are project-relative; resolving them through safeJoin keeps them inside the project.
        const rel = (path: string): string => relative(ctx.projectDir, safeJoin(ctx.projectDir, path)) || '.';
        const sourceDir = rel(p.source_dir);
        const buildDir = rel(p.build_dir);
        const binary = safeJoin(ctx.projectDir, p.binary_path);

        const started = Date.now();
        const configure = await execBuildCommand(ctx, 'cmake', ['-S', sourceDir, '-B', buildDir, ...p.configure_args]);
        if (!configure.ok) return configure;

        const remaining = Math.max(1, ctx.limits.buildTimeoutMs - (Date.now() - started));
        const compile = await execBuildCommand(
          ctx,
          'cmake',
          ['--build', buildDir, ...(p.target === undefined ? [] : ['--target', p.target])],
          remaining,
        );
        const result: BuildResult = {
          ...compile,
          log: `${configure.log}${compile.log}`,
          durationMs: configure.durationMs + compile.durationMs,
          warnings: configure.warnings + compile.warnings,
        };
        return result.ok ? { ...result, binaryPath: binary } : result;
      },
    });
  },
  { name: 'builder-cmake' },
);
