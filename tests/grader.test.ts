import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadAssignment } from '../src/core/assignment.ts';
import { type DescribeEntry, createGrader } from '../src/grader.ts';
import { ConfigError, fp } from '../src/index.ts';
import { GOOD, addStudent, fakeAssignment } from './helpers/fake-assignment.ts';
import { withTempDir } from './helpers/tmp.ts';

const fixture = (name: string): string => new URL(`./fixtures/assignments/${name}`, import.meta.url).pathname;

const find = (entries: DescribeEntry[], kind: string, name: string): DescribeEntry | undefined =>
  entries.find((e) => e.kind === kind && e.name === name);

describe('createGrader', () => {
  it('check reports load and validation issues together, and starts nothing', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      expect(await createGrader({ assignmentDir: env.assignment }).check()).toEqual([]);
      expect(existsSync(env.marker)).toBe(false);

      const issues = await createGrader({ assignmentDir: fixture('bad-unknown-step') }).check();
      const paths = issues.map((i) => i.path);
      expect(paths).toContain('assignment.yaml#/build/type'); // validator: unknown builder (no stub plugin here)
      expect(paths).toContain('scenarios/s.yaml#/0/steps/0'); // validator: unknown step
    });
  });

  it('inspect lists the expanded scenarios with their files', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const { ok, scenarios, locale } = await createGrader({ assignmentDir: env.assignment }).inspect();
      expect(ok).toBe(true);
      expect(locale).toBe('en');
      expect(scenarios).toEqual([
        { id: '1-1', title: 'Clean exit', group: 'structure', file: 'scenarios/s.yaml' },
        { id: '2-fast', title: 'Mode fast', group: 'behaviour', file: 'scenarios/s.yaml' },
        { id: '2-slow', title: 'Mode slow', group: 'behaviour', file: 'scenarios/s.yaml' },
      ]);
    });
  });

  it('describe lists every kind with a JSON Schema per entry', async () => {
    const entries = await createGrader({ assignmentDir: fixture('valid') }).describe();
    const exitCode = find(entries, 'check', 'exit_code');
    expect(exitCode?.example).toContain('exit_code: 0');
    expect(exitCode?.params).toEqual(expect.objectContaining({ anyOf: expect.any(Array) }));
    for (const kind of ['step', 'check', 'builder', 'reporter', 'scorer']) {
      expect(entries.some((e) => e.kind === kind)).toBe(true);
    }
    for (const e of entries) expect(typeof e.params).toBe('object');
  });

  it('describe without a directory is the default preset; a directory adds its plugins', async () => {
    const extra = fp((app) => {
      app.check('my_check', { description: 'mine', params: z.string(), source: 'none', describe: () => 'mine', run: async () => ({ pass: true }) });
    });
    const bare = await createGrader({}).describe();
    expect(find(bare, 'check', 'exit_code')).toBeDefined();
    expect(find(bare, 'check', 'my_check')).toBeUndefined();

    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const entries = await createGrader({ assignmentDir: env.assignment, plugins: [extra] }).describe();
      expect(find(entries, 'check', 'my_check')?.description).toBe('mine');
    });
  });

  it('describe falls back to an empty schema when a params schema cannot be converted', async () => {
    const strange = fp((app) => {
      app.check('strange', {
        description: 'refined and piped',
        params: z.string().transform((s) => s.length).pipe(z.number()),
        source: 'none',
        describe: () => 'x',
        run: async () => ({ pass: true }),
      });
    });
    const entries = await createGrader({ plugins: [strange] }).describe();
    expect(typeof find(entries, 'check', 'strange')?.params).toBe('object');
  });

  it('schema describes a scenario file with every registered step and check', async () => {
    const grader = createGrader({ assignmentDir: fixture('valid') });
    const schema = (await grader.schema()) as { type: string; $defs: Record<string, { properties: Record<string, unknown> }> };
    expect(schema.type).toBe('array');
    expect(Object.keys(schema.$defs)).toEqual(expect.arrayContaining(['assignment', 'scenario', 'step', 'check']));
    for (const e of await grader.describe()) {
      if (e.kind === 'check') expect(schema.$defs['check']?.properties).toHaveProperty(e.name);
      if (e.kind === 'step') expect(schema.$defs['step']?.properties).toHaveProperty(e.name);
    }
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it('run grades with the options and honours extra plugins', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const seen: string[] = [];
      const spy = fp((app) => {
        app.hook('onRunEnd', ({ results }) => {
          seen.push(...results.map((r) => r.student.id));
        });
      });
      const { results, outDir } = await createGrader({ assignmentDir: env.assignment, plugins: [spy] }).run({
        inputPath: env.input,
        outDir: join(root, 'out'),
      });
      expect(results.map((r) => r.score.points)).toEqual([16]);
      expect(seen).toEqual(['alice']);
      expect(existsSync(join(outDir, 'summary.csv'))).toBe(true);
    });
  });

  it('run throws ConfigError for an invalid assignment', async () => {
    await expect(createGrader({ assignmentDir: fixture('bad-unknown-step') }).run({ inputPath: '.', outDir: '/nonexistent/x' })).rejects.toBeInstanceOf(ConfigError);
  });

  describe('configOk', () => {
    it('is true for a readable assignment.yaml', async () => {
      await withTempDir(async (root) => {
        const env = await fakeAssignment(root);
        expect((await loadAssignment(env.assignment)).configOk).toBe(true);
      });
    });

    it('is false for a missing, malformed or schema-invalid assignment.yaml, and check reports only the config issues', async () => {
      await withTempDir(async (root) => {
        const missing = join(root, 'missing');
        const malformed = join(root, 'malformed');
        const invalid = join(root, 'invalid');
        for (const dir of [malformed, invalid]) await mkdir(join(dir, 'scenarios'), { recursive: true });
        await writeFile(join(malformed, 'assignment.yaml'), 'name: [unclosed\n');
        await writeFile(join(invalid, 'assignment.yaml'), 'name: X\n');
        for (const dir of [missing, malformed, invalid]) {
          expect((await loadAssignment(dir)).configOk).toBe(false);
          const { ok, issues } = await createGrader({ assignmentDir: dir }).inspect();
          expect(ok).toBe(false);
          expect(issues.length).toBeGreaterThan(0);
          // the placeholder config must not be validated (no "unknown builder ''" noise)
          expect(issues.every((i) => i.path.startsWith('assignment.yaml#'))).toBe(true);
          expect(issues.map((i) => i.message).join('\n')).not.toContain("unknown builder ''");
          await expect(createGrader({ assignmentDir: dir }).describe()).rejects.toBeInstanceOf(ConfigError);
        }
      });
    });
  });
});
