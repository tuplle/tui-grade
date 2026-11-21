import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/core/app.ts';
import type { BuildResult, CheckResult, CheckSpec, ScenarioContext } from '../../src/core/contracts.ts';
import { type ScenarioEnv, createScenarioContext, evaluateCheck } from '../../src/core/execute.ts';
import { removeDir } from '../../src/core/workspace.ts';
import { checksSource } from '../../src/plugins/checks-source/index.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { hasTool, itIf, withTempDir } from '../helpers/tmp.ts';

const spec = (name: string, params: unknown): CheckSpec => ({
  name,
  params,
  weight: 1,
  hidden: false,
  not: false,
  pointer: `#/expect/${name}`,
});

const build = (over: Partial<BuildResult> = {}): BuildResult => ({
  ok: true,
  log: '',
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  warnings: 0,
  ...over,
});

interface Harness {
  ctx: ScenarioContext;
  /** The student's project directory (separate from the scenario workdir). */
  projectDir: string;
  check(name: string, params: unknown): Promise<CheckResult>;
}

interface HarnessOptions {
  build?: BuildResult | undefined;
  noProject?: boolean;
}

async function withHarness(opts: HarnessOptions, fn: (h: Harness) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const assignmentDir = join(dir, 'assignment');
    const projectDir = join(dir, 'project');
    await mkdir(assignmentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    const app = new App();
    await app.register(checksSource);
    const env: ScenarioEnv = {
      app,
      submission: { id: 'stu' } as ScenarioEnv['submission'],
      binaryPath: '/bin/true',
      projectDir: opts.noProject === true ? undefined : projectDir,
      build: opts.build,
      locale: 'en',
      t: (key, vars) => (vars === undefined ? key : `${key} ${JSON.stringify(vars)}`),
      assignmentDir,
      limits: { runTimeoutMs: 1000, outputLimitBytes: 4096 },
      log: () => {},
    };
    const ctx = await createScenarioContext(env, { id: 's', title: 's', weight: 1, steps: [], expect: [], file: 'f.yaml', pointer: '#/0', vars: {} });
    try {
      await fn({ ctx, projectDir, check: (name, params) => evaluateCheck(ctx, spec(name, params)) });
    } finally {
      await removeDir(ctx.workdir);
    }
  });
}

const FIVE = `#include <stdio.h>

int add(int a, int b) { return a + b; }
static int sub(int a, int b) { return a - b; }
void hello(void) { puts("hi"); }
double half(double x) { return x / 2; }

int main(void) {
  hello();
  return add(1, sub(3, 2)) > 0 ? 0 : 1;
}
`;

describe('registration', () => {
  it('is a builtin plugin, part of the preset, with source none', async () => {
    expect(builtinPlugins['checks-source']).toBe(checksSource);
    expect(checksSource.meta.name).toBe('checks-source');
    const app = new App();
    await app.register(defaultPreset);
    const sources = Object.fromEntries(app.list('check').map((c) => [c.name, c.def.source]));
    expect(sources).toMatchObject({ function_count: 'none', no_compiler_warnings: 'none', file_line_count: 'none' });
  });

  it('describes the checks with their parameters', async () => {
    const app = new App();
    await app.register(checksSource);
    const t = (key: string, vars?: Record<string, unknown>): string => (vars === undefined ? key : `${key}|${JSON.stringify(vars)}`);
    expect(app.lookup('check', 'function_count')!.describe({ file: 'a.c', min: 5 }, t)).toBe(
      'check.function_count|{"file":"a.c","range":">= 5"}',
    );
    expect(app.lookup('check', 'no_compiler_warnings')!.describe(true, t)).toBe('check.no_compiler_warnings');
    expect(app.lookup('check', 'file_line_count')!.describe({ file: 'a.c', max: 3 }, t)).toBe(
      'check.file_line_count|{"file":"a.c","range":"<= 3"}',
    );
  });
});

describe('function_count', () => {
  it('counts main plus helpers and passes min', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(join(projectDir, 'main.c'), FIVE);
      expect((await check('function_count', { file: 'main.c', min: 5 })).pass).toBe(true);
      expect((await check('function_count', { file: 'main.c', min: 5, max: 5 })).pass).toBe(true);
      expect((await check('function_count', { file: 'main.c', max: 4 })).pass).toBe(false);
    });
  });

  it('fails below min with expected/actual', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(join(projectDir, 'a.c'), 'int a(void){return 1;}\nint b(void){return 2;}\nint main(void){return 0;}\n');
      const r = await check('function_count', { file: 'a.c', min: 5 });
      expect(r).toMatchObject({ pass: false, expected: '>= 5', actual: '3' });
      expect(r.message).toMatch(/3/);
      const over = await check('function_count', { file: 'a.c', max: 2 });
      expect(over).toMatchObject({ pass: false, expected: '<= 2', actual: '3' });
      const range = await check('function_count', { file: 'a.c', min: 4, max: 6 });
      expect(range).toMatchObject({ pass: false, expected: '4..6', actual: '3' });
    });
  });

  it('does not count prototypes or calls inside bodies', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'p.c'),
        `int f(int);\nvoid g(void);\nextern int h(char *s, int n);\nint main(void) {\n  f(1);\n  g();\n  h("x", 2);\n  if (f(2)) { g(); }\n  while (f(3)) { g(); }\n  for (;;) { break; }\n  switch (f(4)) { default: break; }\n  return 0;\n}\n`,
      );
      expect(await check('function_count', { file: 'p.c', min: 1, max: 1 })).toMatchObject({ pass: true });
    });
  });

  it('ignores functions in comments, strings and char literals', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'c.c'),
        [
          '// int hidden1(void) { return 1; }',
          '/* int hidden2(void) { return 2; }',
          '   int hidden3(void) { return 3; } */',
          'const char *s = "int hidden4(void) { return 4; }";',
          "char c = '{';",
          'int main(void) {',
          '  puts("int hidden5(void) { }");',
          '  return 0; /* } */',
          '}',
          '',
        ].join('\n'),
      );
      expect(await check('function_count', { file: 'c.c', min: 1, max: 1 })).toMatchObject({ pass: true });
    });
  });

  it('braces inside strings, escaped quotes, char literals and comments do not break the depth', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'd.c'),
        [
          'int one(void) {',
          '  const char *s = "}} \\" } {{";',
          "  char a = '}'; char b = '\\''; char q = '\"';",
          '  // } } }',
          '  /* } } */',
          '  return 1;',
          '}',
          'int two(void) {',
          '  const char *s = "{ {";',
          '  return 2;',
          '}',
          'int main(void) { return one() + two(); }',
          '',
        ].join('\n'),
      );
      expect(await check('function_count', { file: 'd.c', min: 3, max: 3 })).toMatchObject({ pass: true });
    });
  });

  it('counts K&R / Allman style with the brace on the next line', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'k.c'),
        'int add(int a, int b)\n{\n  return a + b;\n}\n\nstatic int\nmul(int a, int b)\n{\n  return a * b;\n}\n\nint main(void)\n{\n  return add(1, 2) - mul(1, 3);\n}\n',
      );
      expect(await check('function_count', { file: 'k.c', min: 3, max: 3 })).toMatchObject({ pass: true });
    });
  });

  it('counts static/inline/pointer-return/const-qualified signatures', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 's.c'),
        [
          'static int a(void) { return 1; }',
          'static inline int b(int x) { return x; }',
          'char *c(char *s) { return s; }',
          'const char *d(void) { return "d"; }',
          'unsigned long long **e(void) { return 0; }',
          'struct node *f(struct node *n) { return n; }',
          'int (*g(void))(int) { return 0; }',
          'int main(int argc, char **argv) { (void)argc; (void)argv; return 0; }',
          '',
        ].join('\n'),
      );
      const r = await check('function_count', { file: 's.c', min: 8, max: 8 });
      expect(r).toMatchObject({ pass: true });
    });
  });

  it('counts C++ style definitions (qualified names, const methods, templates, noexcept)', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'x.cpp'),
        [
          'int Foo::bar(int x) const { return x; }',
          'template <typename T> T id(T v) { return v; }',
          'void quiet() noexcept { }',
          'std::string name() { return ""; }',
          'int main() { return 0; }',
          '',
        ].join('\n'),
      );
      expect(await check('function_count', { file: 'x.cpp', min: 5, max: 5 })).toMatchObject({ pass: true });
    });
  });

  it('does not count struct/enum/union definitions or initializer lists', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 't.c'),
        [
          'struct point { int x; int y; };',
          'typedef struct { int a; } pair;',
          'enum color { RED, GREEN };',
          'union u { int i; float f; };',
          'int table[] = { 1, 2, 3 };',
          'struct point origin = { 0, 0 };',
          'int main(void) { return 0; }',
          '',
        ].join('\n'),
      );
      expect(await check('function_count', { file: 't.c', min: 1, max: 1 })).toMatchObject({ pass: true });
    });
  });

  it('does not count function-like macros, including continued ones', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'm.c'),
        [
          '#define SQUARE(x) ((x) * (x))',
          '#define SWAP(a, b) do { \\',
          '    int t = (a); \\',
          '    (a) = (b); \\',
          '    (b) = t; \\',
          '  } while (0)',
          '#define FN(name) int name(void) { return 0; }',
          '#if defined(FOO) && (BAR)',
          '#endif',
          'int main(void) { return SQUARE(2); }',
          '',
        ].join('\n'),
      );
      expect(await check('function_count', { file: 'm.c', min: 1, max: 1 })).toMatchObject({ pass: true });
    });
  });

  it('looks inside namespace and extern "C" blocks but not into function bodies or classes', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'n.cpp'),
        [
          'extern "C" {',
          '  int c_fn(int x) { return x; }',
          '}',
          'namespace util {',
          '  int helper(void) { return 1; }',
          '  namespace inner { int deep(void) { return 2; } }',
          '}',
          'class Widget {',
          ' public:',
          '  int method(void) { return 3; }',
          '};',
          'int main() { return c_fn(1) + util::helper(); }',
          '',
        ].join('\n'),
      );
      // c_fn, helper, deep and main; Widget::method is inside a class body (out of scope)
      expect(await check('function_count', { file: 'n.cpp', min: 4, max: 4 })).toMatchObject({ pass: true });
    });
  });

  it('does not count nested braces inside a function body as functions', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(
        join(projectDir, 'b.c'),
        'int main(void) {\n  if (1) { int x = 0; (void)x; }\n  else { }\n  do { } while (0);\n  { int y; (void)y; }\n  return 0;\n}\n',
      );
      expect(await check('function_count', { file: 'b.c', min: 1, max: 1 })).toMatchObject({ pass: true });
    });
  });

  it('handles CRLF line endings', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(join(projectDir, 'w.c'), 'int a(void)\r\n{\r\n  return 1;\r\n}\r\nint main(void) { return a(); }\r\n');
      expect(await check('function_count', { file: 'w.c', min: 2, max: 2 })).toMatchObject({ pass: true });
    });
  });

  it('counts zero for an empty file', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(join(projectDir, 'e.c'), '');
      expect(await check('function_count', { file: 'e.c', max: 0 })).toMatchObject({ pass: true });
      expect(await check('function_count', { file: 'e.c', min: 1 })).toMatchObject({ pass: false, actual: '0' });
    });
  });

  it('reads from the project directory, not the scenario workdir', async () => {
    await withHarness({}, async ({ ctx, projectDir, check }) => {
      await writeFile(join(ctx.workdir, 'only-in-workdir.c'), FIVE);
      const r = await check('function_count', { file: 'only-in-workdir.c', min: 1 });
      expect(r).toMatchObject({ pass: false, message: expect.stringMatching(/not found/) });
      await mkdir(join(projectDir, 'src'));
      await writeFile(join(projectDir, 'src', 'main.c'), FIVE);
      expect((await check('function_count', { file: 'src/main.c', min: 5 })).pass).toBe(true);
    });
  });

  it('fails for a missing file, a path escaping the project, a symlink escape and a missing project dir without throwing', async () => {
    await withHarness({}, async ({ ctx, projectDir, check }) => {
      expect(await check('function_count', { file: 'nope.c', min: 1 })).toMatchObject({
        pass: false,
        message: expect.stringMatching(/file not found: nope\.c/),
      });
      expect(await check('function_count', { file: '../outside.c', min: 1 })).toMatchObject({
        pass: false,
        message: expect.stringMatching(/escapes/),
      });
      await writeFile(join(ctx.workdir, 'secret.c'), FIVE);
      await symlink(join(ctx.workdir, 'secret.c'), join(projectDir, 'link.c'));
      const linked = await check('function_count', { file: 'link.c', min: 1 });
      expect(linked.pass).toBe(false);
    });
    await withHarness({ noProject: true }, async ({ check }) => {
      expect(await check('function_count', { file: 'a.c', min: 1 })).toMatchObject({
        pass: false,
        message: expect.stringMatching(/project/),
      });
    });
  });

  it('fails on a directory, an oversized file and (when available) a FIFO', async () => {
    await withHarness({}, async ({ ctx, projectDir, check }) => {
      await mkdir(join(projectDir, 'dir'));
      expect(await check('function_count', { file: 'dir', min: 1 })).toMatchObject({ pass: false, message: expect.stringMatching(/not a regular file/) });
      ctx.limits.outputLimitBytes = 16;
      await writeFile(join(projectDir, 'big.c'), 'x'.repeat(17));
      expect(await check('function_count', { file: 'big.c', min: 1 })).toMatchObject({
        pass: false,
        message: expect.stringMatching(/too large.*17 bytes, limit 16/),
      });
    });
  });

  itIf(hasTool('mkfifo'))(
    'fails promptly on a FIFO instead of blocking',
    async () => {
      await withHarness({}, async ({ projectDir, check }) => {
        execFileSync('mkfifo', [join(projectDir, 'pipe.c')]);
        expect(await check('function_count', { file: 'pipe.c', min: 1 })).toMatchObject({
          pass: false,
          message: expect.stringMatching(/not a regular file/),
        });
      });
    },
    3000,
  );

  it('requires at least one of min/max', async () => {
    const app = new App();
    await app.register(checksSource);
    const params = app.lookup('check', 'function_count')!.params;
    expect(params.safeParse({ file: 'a.c' }).success).toBe(false);
    expect(params.safeParse({ file: 'a.c', min: 1 }).success).toBe(true);
    expect(params.safeParse({ file: 'a.c', max: 1 }).success).toBe(true);
    expect(params.safeParse({ file: '', min: 1 }).success).toBe(false);
    expect(params.safeParse({ file: 'a.c', min: 1.5 }).success).toBe(false);
    expect(params.safeParse({ file: 'a.c', min: 1, extra: 1 }).success).toBe(false);
  });
});

describe('no_compiler_warnings', () => {
  it('passes when the build is ok with 0 warnings', async () => {
    await withHarness({ build: build({ warnings: 0 }) }, async ({ check }) => {
      expect((await check('no_compiler_warnings', true)).pass).toBe(true);
    });
  });

  it('fails with the warning count in the message', async () => {
    await withHarness({ build: build({ warnings: 2 }) }, async ({ check }) => {
      const r = await check('no_compiler_warnings', true);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/2 compiler warnings/);
      expect(r).toMatchObject({ expected: '0', actual: '2' });
    });
    await withHarness({ build: build({ warnings: 1 }) }, async ({ check }) => {
      expect((await check('no_compiler_warnings', true)).message).toMatch(/1 compiler warning\b/);
    });
  });

  it('fails when the build failed, even with 0 warnings counted', async () => {
    await withHarness({ build: build({ ok: false, warnings: 0, exitCode: 1 }) }, async ({ check }) => {
      const r = await check('no_compiler_warnings', true);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/build failed/);
    });
  });

  it('fails when there is no build result', async () => {
    await withHarness({ build: undefined }, async ({ check }) => {
      const r = await check('no_compiler_warnings', true);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/no build/);
    });
  });

  it('accepts only the literal true', async () => {
    const app = new App();
    await app.register(checksSource);
    const params = app.lookup('check', 'no_compiler_warnings')!.params;
    expect(params.safeParse(true).success).toBe(true);
    expect(params.safeParse(false).success).toBe(false);
    expect(params.safeParse('yes').success).toBe(false);
  });

  it('does not need a project directory', async () => {
    await withHarness({ noProject: true, build: build() }, async ({ check }) => {
      expect((await check('no_compiler_warnings', true)).pass).toBe(true);
    });
  });
});

describe('file_line_count', () => {
  it('counts lines; a trailing newline does not add a line', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(join(projectDir, 'three.c'), 'a\nb\nc\n');
      await writeFile(join(projectDir, 'three-nonl.c'), 'a\nb\nc');
      await writeFile(join(projectDir, 'crlf.c'), 'a\r\nb\r\nc\r\n');
      await writeFile(join(projectDir, 'blank-lines.c'), 'a\n\n\nb\n');
      await writeFile(join(projectDir, 'empty.c'), '');
      for (const f of ['three.c', 'three-nonl.c', 'crlf.c']) {
        expect((await check('file_line_count', { file: f, min: 3, max: 3 })).pass).toBe(true);
      }
      expect((await check('file_line_count', { file: 'blank-lines.c', min: 4, max: 4 })).pass).toBe(true);
      expect((await check('file_line_count', { file: 'empty.c', max: 0 })).pass).toBe(true);
    });
  });

  it('fails outside the range with expected/actual', async () => {
    await withHarness({}, async ({ projectDir, check }) => {
      await writeFile(join(projectDir, 'a.c'), 'a\nb\nc\n');
      expect(await check('file_line_count', { file: 'a.c', max: 2 })).toMatchObject({ pass: false, expected: '<= 2', actual: '3' });
      expect(await check('file_line_count', { file: 'a.c', min: 4 })).toMatchObject({ pass: false, expected: '>= 4', actual: '3' });
      expect(await check('file_line_count', { file: 'a.c', min: 4, max: 9 })).toMatchObject({ pass: false, expected: '4..9', actual: '3' });
      expect((await check('file_line_count', { file: 'a.c', min: 1, max: 3 })).pass).toBe(true);
    });
  });

  it('fails for a missing file or missing project directory without throwing', async () => {
    await withHarness({}, async ({ check }) => {
      expect(await check('file_line_count', { file: 'nope.c', max: 5 })).toMatchObject({
        pass: false,
        message: expect.stringMatching(/not found/),
      });
    });
    await withHarness({ noProject: true }, async ({ check }) => {
      expect(await check('file_line_count', { file: 'a.c', max: 5 })).toMatchObject({ pass: false, message: expect.stringMatching(/project/) });
    });
  });

  it('requires at least one of min/max', async () => {
    const app = new App();
    await app.register(checksSource);
    const params = app.lookup('check', 'file_line_count')!.params;
    expect(params.safeParse({ file: 'a.c' }).success).toBe(false);
    expect(params.safeParse({ file: 'a.c', min: 0 }).success).toBe(true);
    expect(params.safeParse({ file: 'a.c', max: 10 }).success).toBe(true);
    expect(params.safeParse({ file: 'a.c', max: -1 }).success).toBe(false);
  });
});
