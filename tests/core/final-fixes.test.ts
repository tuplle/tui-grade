// End-to-end behaviour added by the final fix wave: public paths, run logs, plugin catalogs.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import { gradeAll } from '../../src/core/lifecycle.ts';
import { fp } from '../../src/core/plugin.ts';
import { GOOD, addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';

const readZip = async (file: string): Promise<JSZip> => JSZip.loadAsync(await readFile(file));

describe('student-facing results carry no paths of the instructor machine (I3)', () => {
  it('results.json, report.md and the zip contain neither the temp root, the home directory nor the cwd', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: out });
      expect(results[0]?.source.path).toBe(join(env.input, 'alice')); // the in-memory result keeps the real source

      const json = await readFile(join(out, 'alice', 'results.json'), 'utf8');
      const parsed = JSON.parse(json) as { source: unknown };
      expect(parsed.source).toEqual({ path: 'alice', kind: 'dir', root: null });
      const zip = await readZip(join(out, 'alice', 'alice-results.zip'));
      const zipped = (await zip.file('results.json')?.async('string')) ?? '';
      const report = await readFile(join(out, 'alice', 'report.md'), 'utf8');
      for (const text of [json, zipped, report]) {
        expect(text).not.toContain(root);
        expect(text).not.toContain('/tmp');
        expect(text).not.toContain(process.cwd());
        if (homedir().length > 1) expect(text).not.toContain(homedir());
      }
      expect(zipped).toBe(json);
    });
  });
});

describe('run logs (I5)', () => {
  const HIDDEN_ONLY = `- id: "1-1"
  title: Clean exit
  steps:
    - run: { args: [] }
  expect:
    - stdout_contains: secret-expectation
      hidden: true
- id: "2-1"
  title: Second
  steps:
    - run: { args: [] }
    - run: { args: [] }
  expect:
    - stdout_contains: ok
`;

  it('writes logs/<scenario>-<run>.txt with the real stdout, lists them in artifacts and keeps them out of results.json', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, { scenarios: HIDDEN_ONLY });
      await addStudent(env, 'alice', '#!/bin/sh\necho ok\necho oops 1>&2\nexit 3\n');
      const out = join(root, 'out');
      const { results } = await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: out });

      const dir = join(out, 'alice');
      expect((await readdir(join(dir, 'logs'))).sort()).toEqual(['1-1-run-1.txt', '2-1-run-1.txt', '2-1-run-2.txt']);
      const log = await readFile(join(dir, 'logs', '1-1-run-1.txt'), 'utf8');
      expect(log).toBe('exit code: 3\ntimed out: no\n\n--- stdout ---\nok\n\n\n--- stderr ---\noops\n\n');
      expect(results[0]?.scenarios.map((s) => s.artifacts)).toEqual([['logs/1-1-run-1.txt'], ['logs/2-1-run-1.txt', 'logs/2-1-run-2.txt']]);

      const json = await readFile(join(dir, 'results.json'), 'utf8');
      expect(json).not.toContain('"logs":');
      expect(json).not.toContain('"screens"');
      expect(await readFile(join(dir, 'report.md'), 'utf8')).not.toContain('--- stdout ---');
      const parsed = JSON.parse(json) as { scenarios: Array<{ artifacts: string[] }> };
      expect(parsed.scenarios[0]?.artifacts).toEqual(['logs/1-1-run-1.txt']);

      const zip = await readZip(join(dir, 'alice-results.zip'));
      expect(Object.keys(zip.files).filter((n) => n.startsWith('logs/')).sort()).toEqual(['logs/1-1-run-1.txt', 'logs/2-1-run-1.txt', 'logs/2-1-run-2.txt']);
      expect(await zip.file('logs/1-1-run-1.txt')?.async('string')).toBe(log);
      // the hidden check's expectation is not in anything the student gets
      for (const name of Object.keys(zip.files)) {
        if (!zip.files[name]?.dir) expect((await zip.file(name)?.async('string')) ?? '').not.toContain('secret-expectation');
      }
    });
  });

  it('caps each section at 64 KiB', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, { scenarios: '- id: big\n  title: Big\n  steps:\n    - run: { args: [] }\n  expect:\n    - stdout_contains: x\n' });
      await addStudent(env, 'alice', '#!/bin/sh\nhead -c 100000 /dev/zero | tr "\\\\0" x\n');
      const out = join(root, 'out');
      await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: out });
      const log = await readFile(join(out, 'alice', 'logs', 'big-run-1.txt'), 'utf8');
      expect(log).toContain('[truncated at 64 KiB]');
      expect(log.length).toBeLessThan(65_536 + 400);
      expect(log).toContain('x'.repeat(65_536));
      expect(log).not.toContain('x'.repeat(65_537));
    });
  });

  it('removes the logs of a previous run in the same outDir', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      const opts = { assignmentDir: env.assignment, inputPath: env.input, outDir: out };
      await gradeAll(opts);
      const logs = join(out, 'alice', 'logs');
      expect(existsSync(join(logs, '1-1-run-1.txt'))).toBe(true);
      await writeFile(join(logs, 'stale.txt'), 'old');

      await writeFile(join(env.assignment, 'scenarios', 's.yaml'), '- id: only\n  title: Only\n  steps:\n    - write_file: { path: a.txt, content: x }\n  expect:\n    - file_exists: a.txt\n');
      await gradeAll(opts);
      expect(existsSync(logs)).toBe(false);
    });
  });
});

describe('plugin catalogs (I6)', () => {
  const catalogPlugin = fp(
    (app) => {
      app.catalog('en', { 'my.key': 'Plugin says hello {who}', 'report.points': 'HACKED' });
      app.catalog('sk', { 'my.key': 'Plugin pozdravuje {who}' });
      app.check('my_check', {
        description: 'uses a plugin message',
        params: z.unknown(),
        source: 'none',
        describe: (_params, t) => t('my.key', { who: 'world' }),
        async run() {
          return { pass: true };
        },
      });
    },
    { name: 'catalog-plugin' },
  );

  const SCENARIO = '- id: c\n  title: C\n  steps:\n    - write_file: { path: a.txt, content: x }\n  expect:\n    - my_check: {}\n';

  const report = async (locale: string): Promise<string> =>
    withTempDir(async (root) => {
      const env = await fakeAssignment(root, { scenarios: SCENARIO });
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      await gradeAll({ assignmentDir: env.assignment, inputPath: env.input, outDir: out, locale: locale as 'en', extraPlugins: [catalogPlugin] });
      return readFile(join(out, 'alice', 'report.md'), 'utf8');
    });

  it('shows the localized plugin text in report.md, falls back to English for an unknown locale', async () => {
    expect(await report('en')).toContain('Plugin says hello world');
    expect(await report('sk')).toContain('Plugin pozdravuje world');
    expect(await report('fr')).toContain('Plugin says hello world');
  });

  it('never lets a plugin change a built-in message', async () => {
    const en = await report('en');
    expect(en).not.toContain('HACKED');
    expect(en).toContain('Points');
  });

  it('merges catalogs along the context chain, nearest first', async () => {
    const { App } = await import('../../src/core/app.ts');
    const parent = new App();
    const child = new App(parent);
    child.catalog('en', { a: 'child' });
    child.catalog('en', { c: 'child-c' }); // the same locale again merges
    parent.catalog('en', { a: 'parent', b: 'parent-b' });
    expect(parent.getCatalogs()).toEqual([{ en: { a: 'parent', b: 'parent-b' } }]);
    expect(child.getCatalogs()).toEqual([{ en: { a: 'child', c: 'child-c' } }, { en: { a: 'parent', b: 'parent-b' } }]);
    expect(new App().getCatalogs()).toEqual([]);
  });
});
