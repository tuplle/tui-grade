import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrader } from '../../src/index.ts';
import { rescoreRun } from '../../src/core/rescore.ts';
import { GOOD, addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';

describe('rescoreRun', () => {
  it('applies manual points without building or running the student again', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      await createGrader({ assignmentDir: env.assignment }).run({ inputPath: env.input, outDir: out });
      const marker = await stat(env.marker);
      const before = JSON.parse(await readFile(join(out, 'alice', 'results.json'), 'utf8')) as { score: { points: number } };
      expect(before.score.points).toBe(16);

      await writeFile(join(out, 'manual.yaml'), 'alice:\n  review: 3.5\n');
      const { results } = await rescoreRun({ assignmentDir: env.assignment, outDir: out });

      expect(results[0]?.score.points).toBe(19.5);
      expect(results[0]?.score.groups.find((group) => group.id === 'review')).toMatchObject({ points: 3.5, pending: false });
      expect((await stat(env.marker)).mtimeMs).toBe(marker.mtimeMs); // no build

      const json = JSON.parse(await readFile(join(out, 'alice', 'results.json'), 'utf8')) as { score: { points: number } };
      expect(json.score.points).toBe(19.5);
      const full = await readFile(join(out, 'alice', 'results.full.json'), 'utf8');
      expect(full).toContain('"assignment": "Fake"');
      expect((await readFile(join(out, 'summary.csv'), 'utf8')).includes('alice;19.5;20;')).toBe(true);
    });
  });

  it('reports a run without results', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      const out = await mkdtemp(join(tmpdir(), 'tui-grade-empty-'));
      await expect(rescoreRun({ assignmentDir: env.assignment, outDir: out })).rejects.toThrow(/no student results/);
    });
  });
});
