import { z } from 'zod';
import type { CheckDef, Issue } from '../../src/core/contracts.ts';
import { fp } from '../../src/core/plugin.ts';

const outcome = async (): Promise<{ pass: boolean }> => ({ pass: true });
const check = (source: CheckDef['source']): CheckDef => ({
  description: 'stub check',
  params: z.object({ contains: z.string().optional() }),
  source,
  describe: () => 'stub',
  run: outcome,
});

/** Stand-in for the parts of the preset that are not built yet: a builder, a session-producing step and checks of each source. (`run`, `session`, `any_of` etc. come from the real preset.) */
export const stubPlugin = fp(
  (app) => {
    app.builder('stub-build', { description: 'stub', params: z.object({}), build: async () => { throw new Error('not used'); } });

    const step = (produces?: 'run' | 'session') => ({
      description: 'stub step',
      params: z.object({ args: z.array(z.string()).optional() }).nullable(),
      ...(produces === undefined ? {} : { produces }),
      run: async (): Promise<void> => {},
    });
    app.step('noop', { ...step(), params: z.unknown() });
    app.step('mkrun', step('run'));
    app.step('mksession', step('session'));
    app.step('feed', {
      description: 'copies a fixture',
      params: z.object({ file: z.string() }),
      run: async () => {},
      validate: (params, v): Issue[] =>
        v.fixtureExists(params.file)
          ? []
          : [{ path: '/file', message: `fixture '${params.file}' does not exist`, severity: 'error' }],
    });

    app.check('stdout_x', check('run'));
    app.check('screen_x', check('session'));
    app.check('any_x', check('either'));
    app.check('nothing', check('none'));
  },
  { name: 'stub' },
);
