import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { App } from '../../src/core/app.ts';
import { loadAssignment, assignmentConfigSchema } from '../../src/core/assignment.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';
import { definePlugin, fp } from '../../src/core/plugin.ts';
import { resolvePlugin } from '../../src/core/plugin-resolver.ts';
import { builtinPlugins } from '../../src/plugins/index.ts';
import { withTempDir } from '../helpers/tmp.ts';
import { stubPlugin } from '../helpers/stub-plugin.ts';

const fixture = (name: string): string => new URL(`../fixtures/assignments/${name}`, import.meta.url).pathname;

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

const CONFIG = 'name: T\nmax_points: 1\nbuild: { type: stub-build }\nproject_root_marker: src/main.c\n';
const SCENARIO = '- id: a\n  title: A\n  run: {}\n  expect: []\n';

describe('assignment config schema', () => {
  it('fills the documented defaults', async () => {
    const loaded = await loadAssignment(fixture('valid'), { extraPlugins: [stubPlugin] });
    expect(loaded.issues).toEqual([]);
    expect(loaded.config).toEqual({
      name: 'Demo assignment',
      max_points: 10,
      locale: 'en',
      build: { type: 'stub-build' },
      project_root_marker: 'src/main.c',
      project_root_depth: 2,
      groups: expect.any(Array),
      scoring: { use: 'proportional', rounding: 'none', cap: true },
      plugins: [],
      preset: 'default',
      limits: {
        build_timeout_sec: 120,
        run_timeout_sec: 10,
        output_limit_bytes: 1_048_576,
        unzip_max_bytes: 524_288_000,
        unzip_max_files: 20_000,
      },
    });
    expect(loaded.config.limits.run_timeout_sec).toBe(10);
    expect(loaded.config.locale).toBe('en');
  });

  it('requires the root marker and rejects unknown keys and bad regular expressions', () => {
    const schema = assignmentConfigSchema();
    const base = { name: 'T', max_points: 1, build: { type: 'x' } };
    expect(schema.safeParse(base).success).toBe(false);
    expect(schema.safeParse({ ...base, project_root_marker: 'm', surprise: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, project_root_marker: 'm', student_id: { pattern: '(' } }).success).toBe(false);
    expect(schema.safeParse({ ...base, project_root_marker: 'm', student_id: { pattern: '^(?<id>\\d+)' } }).success).toBe(true);
  });
});

describe('loadAssignment', () => {
  it('loads the valid fixture: matrix expanded, files sorted, no issues', async () => {
    const loaded = await loadAssignment(fixture('valid'), { extraPlugins: [stubPlugin] });
    expect(loaded.issues).toEqual([]);
    expect(loaded.scenarios.map((s) => s.id)).toEqual(['echo-fast', 'echo-slow', 'interactive']);
    expect(loaded.scenarios[0]?.file).toBe('scenarios/basic.yaml');
    expect(loaded.app.lookup('step', 'noop')).toBeDefined();
  });

  it('reports a missing, unparsable or invalid assignment.yaml as issues, not throws', async () => {
    await withTempDir(async (dir) => {
      const missing = await loadAssignment(dir);
      expect(missing.issues).toEqual([
        { path: 'assignment.yaml#/', message: expect.stringContaining('not found'), severity: 'error' },
      ]);
      await write(dir, { 'assignment.yaml': 'name: [unclosed\n' });
      expect((await loadAssignment(dir)).issues[0]?.message).toMatch(/line \d+, col \d+/);
      await write(dir, { 'assignment.yaml': 'name: T\nmax_points: 1\nbuild: { type: x }\nbogus: 1\n' });
      const invalid = await loadAssignment(dir);
      const paths = invalid.issues.map((i) => i.path).sort();
      expect(paths).toEqual(['assignment.yaml#/bogus', 'assignment.yaml#/project_root_marker']);
      expect(invalid.scenarios).toEqual([]);
    });
  });

  it('reports scenario file problems with the file name and keeps the rest', async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        'assignment.yaml': CONFIG,
        'scenarios/a.yaml': SCENARIO,
        'scenarios/sub/b.yml': '- id: b\n  title: B\n  expect: []\n',
      });
      const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
      expect(loaded.scenarios.map((s) => s.file)).toEqual(['scenarios/a.yaml']);
      expect(loaded.issues.map((i) => i.path)).toEqual(['scenarios/sub/b.yml#/0']);
    });
  });

  it('reports an unreadable scenario file as an issue and still loads its siblings', async () => {
    await withTempDir(async (dir) => {
      await write(dir, {
        'assignment.yaml': CONFIG,
        'scenarios/a.yaml': SCENARIO,
        'scenarios/broken.yaml/inner.txt': 'x',
      });
      const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
      expect(loaded.scenarios.map((s) => s.id)).toEqual(['a']);
      expect(loaded.issues).toEqual([
        { path: 'scenarios/broken.yaml#/', message: expect.stringMatching(/cannot read file: .*EISDIR/), severity: 'error' },
      ]);
    });
  });

  it('reports an unreadable scenarios directory instead of claiming there are no scenario files', async () => {
    await withTempDir(async (dir) => {
      await write(dir, { 'assignment.yaml': CONFIG, scenarios: 'not a directory' });
      const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
      expect(loaded.issues).toEqual([
        { path: 'scenarios#/', message: expect.stringMatching(/cannot read scenarios\/: .*ENOTDIR/), severity: 'error' },
      ]);
    });
  });

  it('reports an assignment without scenario files', async () => {
    await withTempDir(async (dir) => {
      await write(dir, { 'assignment.yaml': CONFIG });
      const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
      expect(loaded.issues).toEqual([
        { path: 'scenarios#/', message: expect.stringContaining('no scenario files'), severity: 'error' },
      ]);
    });
  });

  describe('plugins', () => {
    const PLUGIN_FILE = `export default {
  meta: { name: 'from-file' },
  shared: false,
  fn(app, opts) {
    app.step('from_file', { description: 'x', params: { safeParse: () => ({ success: true, data: null }) }, run: async () => {} });
    app.decorate('opts', opts);
  },
};
`;

    it('loads a relative-path plugin, passes its options and shares its registrations', async () => {
      await withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': `${CONFIG}plugins:\n  - use: ./plugins/p.mjs\n    options: { level: 3 }\n`,
          'scenarios/a.yaml': SCENARIO,
          'plugins/p.mjs': PLUGIN_FILE,
        });
        const loaded = await loadAssignment(dir);
        expect(loaded.issues).toEqual([]);
        expect(loaded.app.lookup('step', 'from_file')).toBeDefined(); // visible although declared non-shared
        expect(loaded.app.getDecorator('opts')).toEqual({ level: 3 });
        expect(loaded.app.hasPlugin('from-file')).toBe(true);
      });
    });

    describe('npm packages', () => {
      const pluginSource = (step: string): string => `export default {
  meta: { name: '${step}-plugin' },
  shared: true,
  fn(app) {
    app.step('${step}', { description: 'x', params: { safeParse: () => ({ success: true, data: null }) }, run: async () => {} });
  },
};
`;
      const install = (dir: string, name: string, manifest: object, files: Record<string, string>): Promise<void> =>
        write(dir, {
          ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`node_modules/${name}/${file}`, text])),
          [`node_modules/${name}/package.json`]: JSON.stringify({ name, type: 'module', ...manifest }),
        });
      const base = (plugins: string): Record<string, string> => ({
        'assignment.yaml': `${CONFIG}plugins: ${plugins}\n`,
        'scenarios/a.yaml': SCENARIO,
      });

      it('loads an import-only package (exports without a require condition)', async () => {
        await withTempDir(async (dir) => {
          await write(dir, base('[esm-only-plugin]'));
          await install(dir, 'esm-only-plugin', { exports: { '.': { import: './i.js' } } }, { 'i.js': pluginSource('from_esm') });
          const loaded = await loadAssignment(dir);
          expect(loaded.issues).toEqual([]);
          expect(loaded.app.lookup('step', 'from_esm')).toBeDefined();
          expect(loaded.app.hasPlugin('from_esm-plugin')).toBe(true);
        });
      });

      it('loads a main-only package', async () => {
        await withTempDir(async (dir) => {
          await write(dir, base('[main-only-plugin]'));
          await install(dir, 'main-only-plugin', { main: './lib/entry.js' }, { 'lib/entry.js': pluginSource('from_main') });
          const loaded = await loadAssignment(dir);
          expect(loaded.issues).toEqual([]);
          expect(loaded.app.lookup('step', 'from_main')).toBeDefined();
        });
      });

      it('loads a scoped package with a conditions map, found in an ancestor node_modules, and an exported subpath', async () => {
        await withTempDir(async (root) => {
          const dir = join(root, 'courses', 'one');
          await write(dir, base('["@scope/pkg", "@scope/pkg/extra"]'));
          await install(
            root,
            '@scope/pkg',
            { exports: { '.': { types: './x.d.ts', node: { default: './main.js' } }, './extra': './extra.js' } },
            { 'main.js': pluginSource('from_scope'), 'extra.js': pluginSource('from_extra') },
          );
          const loaded = await loadAssignment(dir);
          expect(loaded.issues).toEqual([]);
          expect(loaded.app.lookup('step', 'from_scope')).toBeDefined();
          expect(loaded.app.lookup('step', 'from_extra')).toBeDefined();
        });
      });

      it('explains a package that does not export the requested entry, or whose entry file is missing', async () => {
        await withTempDir(async (dir) => {
          await write(dir, base('[closed-plugin, closed-plugin/other, ghost-plugin]'));
          await install(dir, 'closed-plugin', { exports: { '.': { require: './c.cjs' } } }, { 'c.cjs': 'module.exports = {};' });
          await install(dir, 'ghost-plugin', { main: './gone.js' }, {});
          const loaded = await loadAssignment(dir);
          expect(loaded.issues.map((i) => [i.path, i.message])).toEqual([
            ['assignment.yaml#/plugins/0', expect.stringMatching(/package 'closed-plugin' does not export a main entry point for ESM import/)],
            ['assignment.yaml#/plugins/1', expect.stringMatching(/package 'closed-plugin' does not export '\.\/other'/)],
            ['assignment.yaml#/plugins/2', expect.stringMatching(/package 'ghost-plugin' points to '\.\/gone\.js', which does not exist/)],
          ]);
        });
      });
    });

    it('reports an unknown module and a missing file as issues with the plugin index', async () => {
      await withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': `${CONFIG}plugins: [no-such-package-xyz, ./missing.mjs]\n`,
          'scenarios/a.yaml': SCENARIO,
        });
        const loaded = await loadAssignment(dir);
        expect(loaded.issues).toEqual([
          { path: 'assignment.yaml#/plugins/0', message: expect.stringMatching(/cannot resolve plugin 'no-such-package-xyz'/), severity: 'error' },
          { path: 'assignment.yaml#/plugins/1', message: expect.stringMatching(/cannot load plugin '\.\/missing\.mjs'/), severity: 'error' },
        ]);
      });
    });

    it('reports a module that does not export a plugin', async () => {
      await withTempDir(async (dir) => {
        await write(dir, {
          'assignment.yaml': `${CONFIG}plugins: [./p.mjs]\n`,
          'scenarios/a.yaml': SCENARIO,
          'p.mjs': 'export default 42;\n',
        });
        const loaded = await loadAssignment(dir);
        expect(loaded.issues[0]?.message).toMatch(/must export a plugin definition/);
      });
    });

    it('reports unmet plugin dependencies, duplicates and throwing plugins', async () => {
      await withTempDir(async (dir) => {
        await write(dir, { 'assignment.yaml': CONFIG, 'scenarios/a.yaml': SCENARIO });
        const needy = fp(() => {}, { name: 'needy', dependencies: ['missing'] });
        const boom = definePlugin(() => {
          throw new Error('kaboom');
        }, { name: 'boom' });
        // A different plugin (distinct name) that defines an already registered builder is a real conflict.
        const clash = fp((app) => app.builder('stub-build', { description: 'clash', params: z.object({}), build: async () => { throw new Error('unused'); } }), { name: 'clash' });
        const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin, needy, boom, clash] });
        const messages = loaded.issues.map((i) => i.message);
        expect(messages).toEqual([
          expect.stringMatching(/plugin 'needy' requires plugin 'missing'/),
          expect.stringMatching(/plugin 'boom' failed: kaboom/),
          expect.stringMatching(/plugin 'clash' failed: .*already registered/),
        ]);
        expect(loaded.issues.every((i) => i.severity === 'error')).toBe(true);
      });
    });

    it('treats registering an already loaded named plugin as a no-op', async () => {
      await withTempDir(async (dir) => {
        await write(dir, { 'assignment.yaml': CONFIG, 'scenarios/a.yaml': SCENARIO });
        const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin, stubPlugin] });
        expect(loaded.issues).toEqual([]);
      });
    });

    describe('first-party builders listed in plugins:', () => {
      const GCC_CONFIG = 'name: T\nmax_points: 1\nbuild: { type: gcc, sources: [src/main.c], output: bin/app }\nproject_root_marker: src/main.c\n';
      for (const preset of ['default', 'none']) {
        it(`loads builder-gcc with preset: ${preset} and registers gcc`, async () => {
          await withTempDir(async (dir) => {
            await write(dir, {
              'assignment.yaml': `${GCC_CONFIG}preset: ${preset}\nplugins: [builder-gcc]\n`,
              'scenarios/a.yaml': SCENARIO,
            });
            const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
            expect(loaded.issues).toEqual([]);
            expect(loaded.app.lookup('builder', 'gcc')).toBeDefined();
            expect(loaded.app.hasPlugin('builder-gcc')).toBe(true);
          });
        });
      }

      it('names every builtin plugin after its builtinPlugins key and the preset provides the builders as named plugins', async () => {
        for (const [key, def] of Object.entries(builtinPlugins)) expect(def.meta.name).toBe(key);
        const app = new App();
        await app.register(defaultPreset);
        for (const name of ['builder-gcc', 'builder-cmake', 'builder-custom']) expect(app.hasPlugin(name)).toBe(true);
      });
    });

    it('resolves builtin names through the builtin map', async () => {
      const def = fp(() => {}, { name: 'test-builtin' });
      builtinPlugins['test-builtin'] = def;
      try {
        expect(await resolvePlugin('test-builtin', '/nowhere')).toBe(def);
        await withTempDir(async (dir) => {
          await write(dir, { 'assignment.yaml': `${CONFIG}plugins: [test-builtin]\n`, 'scenarios/a.yaml': SCENARIO });
          const loaded = await loadAssignment(dir, { extraPlugins: [stubPlugin] });
          expect(loaded.issues).toEqual([]);
          expect(loaded.app.hasPlugin('test-builtin')).toBe(true);
        });
      } finally {
        delete builtinPlugins['test-builtin'];
      }
    });
  });

  describe('preset', () => {
    it('registers the default preset unless preset: none', async () => {
      await withTempDir(async (dir) => {
        await write(dir, { 'assignment.yaml': CONFIG, 'scenarios/a.yaml': SCENARIO });
        expect((await loadAssignment(dir)).app.hasPlugin('preset-default')).toBe(true);
        await write(dir, { 'assignment.yaml': `${CONFIG}preset: none\n` });
        const bare = await loadAssignment(dir);
        expect(bare.issues).toEqual([]);
        expect(bare.app.hasPlugin('preset-default')).toBe(false);
        for (const kind of ['step', 'check', 'builder', 'reporter', 'scorer'] as const) {
          expect(bare.app.list(kind)).toEqual([]);
        }
      });
    });
  });
});
