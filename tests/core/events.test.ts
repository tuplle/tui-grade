import { join } from 'node:path';
import { createGrader } from '../../src/index.ts';
import type { RunEvent } from '../../src/index.ts';
import { GOOD, addStudent, fakeAssignment } from '../helpers/fake-assignment.ts';
import { withTempDir } from '../helpers/tmp.ts';

describe('run events', () => {
  it('reports the run, submission, scenario and score in order', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const events: RunEvent[] = [];
      await createGrader({ assignmentDir: env.assignment }).run({
        inputPath: env.input,
        outDir: join(root, 'out'),
        onEvent: (event) => events.push(event),
      });

      expect(events.map((event) => event.type)).toEqual([
        'run-start',
        'submissions',
        'submission-start',
        'build',
        'scenario-start',
        'scenario-end',
        'scenario-start',
        'scenario-end',
        'scenario-start',
        'scenario-end',
        'submission-score',
        'submission-end',
        'run-end',
      ]);
      const start = events[0];
      expect(start).toMatchObject({ type: 'run-start', assignment: 'Fake', scenarioCount: 3 });
      const end = events.at(-1);
      expect(end).toMatchObject({ type: 'run-end', interrupted: false, results: [{ studentId: 'alice', points: 16, max: 20 }] });
    });
  });

  it('never fails a run when the event listener throws', async () => {
    await withTempDir(async (root) => {
      const env = await fakeAssignment(root);
      await addStudent(env, 'alice', GOOD);
      const { results } = await createGrader({ assignmentDir: env.assignment }).run({
        inputPath: env.input,
        outDir: join(root, 'out'),
        onEvent: () => {
          throw new Error('listener broke');
        },
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.score.points).toBe(16);
    });
  });
});
