import { access, mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { z } from 'zod';
import { execBuildCommand } from '../../core/build.ts';
import type { BuildResult } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { safeJoin } from '../../core/workspace.ts';

const params = z.strictObject({
  sources: z.array(z.string().min(1)).min(1),
  output: z.string().min(1),
  std: z.string().min(1).optional(), // e.g. 'c17'
  flags: z.array(z.string()).default(['-Wall', '-Wextra']),
  libs: z.array(z.string()).default([]),
  compiler: z.string().min(1).optional(), // default: g++ for C++ sources, gcc otherwise
});

const CPP_SOURCE = /\.(cpp|cc|cxx|c\+\+)$/i;

/** Makes a project-relative path safe to pass as an argument (never looks like an option). */
const asArg = (rel: string): string => (rel.startsWith('-') ? `./${rel}` : rel);

export const builderGcc = fp(
  (app) => {
    app.builder('gcc', {
      description: 'Compiles C/C++ sources with gcc/g++ (argv, no shell).',
      params,
      async build(ctx, p: z.output<typeof params>): Promise<BuildResult> {
        const sources = p.sources.map((s) => relative(ctx.projectDir, safeJoin(ctx.projectDir, s)));
        for (const [i, source] of sources.entries()) {
          const missing = await access(safeJoin(ctx.projectDir, source)).then(
            () => false,
            () => true,
          );
          if (missing) {
            return {
              ok: false,
              log: '',
              exitCode: null,
              timedOut: false,
              durationMs: 0,
              warnings: 0,
              message: `source file not found: ${p.sources[i]}`,
            };
          }
        }
        const output = safeJoin(ctx.projectDir, p.output);
        await mkdir(dirname(output), { recursive: true });

        const compiler = p.compiler ?? (sources.some((s) => CPP_SOURCE.test(s)) ? 'g++' : 'gcc');
        const args = [
          ...(p.std === undefined ? [] : [`-std=${p.std}`]),
          ...p.flags,
          ...sources.map(asArg),
          '-o',
          asArg(relative(ctx.projectDir, output)),
          ...p.libs,
        ];
        const result = await execBuildCommand(ctx, compiler, args);
        return result.ok ? { ...result, binaryPath: output } : result;
      },
    });
  },
  { name: 'builder-gcc' },
);
