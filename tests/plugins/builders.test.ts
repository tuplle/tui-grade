import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/core/app.ts';
import type { BuildContext } from '../../src/core/contracts.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { builderCmake } from '../../src/plugins/builder-cmake/index.ts';
import { builderCustom } from '../../src/plugins/builder-custom/index.ts';
import { builderGcc } from '../../src/plugins/builder-gcc/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

/** Builds through the registered builder with its params parsed (defaults applied), like `runBuild` does. */
async function buildWith(name: string, projectDir: string, raw: unknown, buildTimeoutMs = 30_000) {
  const app = new App();
  await app.register(defaultPreset);
  const builder = app.lookup('builder', name)!;
  return builder.build(ctx(projectDir, buildTimeoutMs), builder.params.parse(raw));
}

const ctx = (projectDir: string, buildTimeoutMs = 30_000): BuildContext => ({
  projectDir,
  limits: { buildTimeoutMs, outputLimitBytes: 1024 * 1024 },
  log: () => {},
});

describe('builder registration', () => {
  it('registers each builder under its name', async () => {
    const app = new App();
    await app.register(builderGcc);
    await app.register(builderCmake);
    await app.register(builderCustom);
    expect(app.list('builder').map((b) => b.name).sort()).toEqual(['cmake', 'custom', 'gcc']);
  });

  it('exposes the builders as builtin plugins and through the default preset', async () => {
    expect(Object.keys(builtinPlugins)).toEqual(expect.arrayContaining(['builder-gcc', 'builder-cmake', 'builder-custom']));
    const app = new App();
    await app.register(defaultPreset);
    expect(app.lookup('builder', 'gcc')).toBeDefined();
    expect(app.lookup('builder', 'cmake')).toBeDefined();
    expect(app.lookup('builder', 'custom')).toBeDefined();
  });
});

describe('builder params', () => {
  const def = async (name: string) => {
    const app = new App();
    await app.register(defaultPreset);
    return app.lookup('builder', name)!;
  };

  it('gcc requires sources and output and defaults nothing else', async () => {
    const { params } = await def('gcc');
    expect(params.safeParse({ sources: ['a.c'], output: 'a' }).success).toBe(true);
    expect(params.safeParse({ sources: [], output: 'a' }).success).toBe(false);
    expect(params.safeParse({ sources: ['a.c'] }).success).toBe(false);
    expect(params.safeParse({ sources: ['a.c'], output: 'a', bogus: 1 }).success).toBe(false);
  });

  it('cmake requires binary_path', async () => {
    const { params } = await def('cmake');
    expect(params.safeParse({ binary_path: 'build/app' }).success).toBe(true);
    expect(params.safeParse({}).success).toBe(false);
  });

  it('custom requires a non-empty command', async () => {
    const { params } = await def('custom');
    expect(params.safeParse({ command: 'make' }).success).toBe(true);
    expect(params.safeParse({ command: '' }).success).toBe(false);
  });
});

describe('gcc builder', () => {
  itIf(hasTool('gcc'))('passes -std, flags and libs as separate argv entries (no shell)', async () => {
    await withTempDir(async (dir) => {
      // A source name with shell metacharacters must be treated as a plain file name.
      await writeFile(join(dir, 'a b;c.c'), '#include <math.h>\nint main(void) { return (int)sqrt(0.0); }\n');
      const res = await buildWith('gcc', dir, {
        sources: ['a b;c.c'],
        output: 'bin/x y',
        std: 'c17',
        flags: ['-Wall'],
        libs: ['-lm'],
      });
      expect(res.ok).toBe(true);
      expect(res.binaryPath).toBe(join(dir, 'bin/x y'));
    });
  });

  itIf(hasTool('g++'))('uses g++ for C++ sources', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'main.cpp'), '#include <string>\nint main() { std::string s; return (int)s.size(); }\n');
      const res = await buildWith('gcc', dir, { sources: ['main.cpp'], output: 'app', std: 'c++17' });
      expect(res.ok).toBe(true);
    });
  });

  it('fails readably when the compiler binary does not exist', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'main.c'), 'int main(void){return 0;}\n');
      const res = await buildWith('gcc', dir, {
        sources: ['main.c'],
        output: 'app',
        compiler: 'definitely-not-a-compiler',
      });
      expect(res.ok).toBe(false);
      expect(res.message).toContain('definitely-not-a-compiler');
    });
  });
});

describe('cmake builder', () => {
  it('rejects a build_dir outside the project (runBuild turns the throw into a failed build)', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'p'));
      await expect(buildWith('cmake', join(dir, 'p'), { build_dir: '../out', binary_path: 'x' })).rejects.toThrow(/escapes/);
    });
  });
});
