import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { createGrader } from '../../src/index.ts';
import { GOOD, addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';

const HIDDEN = `- id: hidden
  title: Hidden check
  group: structure
  steps:
    - run: { args: [] }
  expect:
    - hidden: true
      stdout_contains: nope
`;

describe('teacher-only results', () => {
  it('keeps hidden details in results.full.json and out of the student ZIP', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root, { scenarios: HIDDEN });
      await addStudent(env, 'alice', GOOD);
      const out = join(root, 'out');
      await createGrader({ assignmentDir: env.assignment }).run({ inputPath: env.input, outDir: out });

      const publicResult = JSON.parse(await readFile(join(out, 'alice', 'results.json'), 'utf8')) as {
        scenarios: Array<{ checks: Array<Record<string, unknown>> }>;
      };
      const fullResult = JSON.parse(await readFile(join(out, 'alice', 'results.full.json'), 'utf8')) as {
        scenarios: Array<{ checks: Array<Record<string, unknown>> }>;
      };
      expect(publicResult.scenarios[0]?.checks[0]).toMatchObject({ name: 'stdout_contains', hidden: true, pass: false });
      expect(publicResult.scenarios[0]?.checks[0]).not.toHaveProperty('message');
      expect(publicResult.scenarios[0]?.checks[0]?.description).not.toContain('nope');
      expect(fullResult.scenarios[0]?.checks[0]).toHaveProperty('message');
      expect(fullResult.scenarios[0]?.checks[0]?.description).toContain('nope');

      const meta = JSON.parse(await readFile(join(out, 'run.json'), 'utf8')) as { assignmentDir: string; assignment: string };
      expect(meta.assignment).toBe('Fake');
      expect(meta.assignmentDir).toBe(env.assignment);

      const zip = await JSZip.loadAsync(await readFile(join(out, 'alice', 'alice-results.zip')));
      expect(zip.file('results.json')).not.toBeNull();
      expect(zip.file('results.full.json')).toBeNull();
    });
  });
});
