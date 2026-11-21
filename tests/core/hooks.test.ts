import { App } from '../../src/core/app.ts';
import type { HookPayloads, RunInfo } from '../../src/core/hooks.ts';
import { definePlugin, fp } from '../../src/core/plugin.ts';

const run: RunInfo = {
  assignment: 'a1',
  startedAt: '2026-01-01T00:00:00.000Z',
  inputPath: '/in',
  outDir: '/out',
};
const runStart: HookPayloads['onRunStart'] = { run };

describe('lifecycle hooks', () => {
  it('runs hooks sequentially in registration order', async () => {
    const app = new App();
    const order: string[] = [];
    app.hook('onRunStart', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push('first');
    });
    app.hook('onRunStart', () => {
      order.push('second');
    });
    await expect(app.runHooks('onRunStart', runStart)).resolves.toEqual([]);
    expect(order).toEqual(['first', 'second']);
  });

  it('runs ancestor hooks before the context own hooks', async () => {
    const root = new App();
    const order: string[] = [];
    root.hook('onRunStart', () => {
      order.push('root-1');
    });
    let child: App | undefined;
    await root.register(
      definePlugin((app) => {
        child = app;
        app.hook('onRunStart', () => {
          order.push('child');
        });
      }),
    );
    root.hook('onRunStart', () => {
      order.push('root-2');
    });
    await child?.runHooks('onRunStart', runStart);
    expect(order).toEqual(['root-1', 'root-2', 'child']);
  });

  it('does not run an encapsulated child hook for the parent', async () => {
    const root = new App();
    const order: string[] = [];
    await root.register(
      definePlugin((child) => {
        child.hook('onRunStart', () => {
          order.push('child');
        });
      }),
    );
    await root.register(
      fp((shared) => {
        shared.hook('onRunStart', () => {
          order.push('shared');
        });
      }),
    );
    await root.runHooks('onRunStart', runStart);
    expect(order).toEqual(['shared']);
  });

  it('collects a throwing hook and still runs the later ones', async () => {
    const app = new App();
    const order: string[] = [];
    const boom = new Error('boom');
    app.hook('onRunStart', () => {
      order.push('a');
      throw boom;
    });
    app.hook('onRunStart', () => {
      order.push('b');
    });
    const failures = await app.runHooks('onRunStart', runStart);
    expect(order).toEqual(['a', 'b']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hook).toBe('onRunStart');
    expect(failures[0]?.error).toBe(boom);
  });

  it('wraps a non-Error throw into an Error', async () => {
    const app = new App();
    app.hook('onRunStart', () => {
      throw 'plain string';
    });
    const failures = await app.runHooks('onRunStart', runStart);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(failures[0]?.error.message).toContain('plain string');
  });

  it('attributes a failure to the plugin that registered the hook', async () => {
    const root = new App();
    await root.register(
      fp(
        (app) => {
          app.hook('onRunStart', () => {
            throw new Error('x');
          });
        },
        { name: 'noisy' },
      ),
    );
    root.hook('onRunStart', () => {
      throw new Error('y');
    });
    const failures = await root.runHooks('onRunStart', runStart);
    expect(failures.map((f) => f.plugin)).toEqual(['noisy', undefined]);
  });

  it('rethrows the first error with failFast and skips later hooks', async () => {
    const app = new App();
    const order: string[] = [];
    const first = new Error('first');
    app.hook('onRunStart', () => {
      order.push('a');
      throw first;
    });
    app.hook('onRunStart', () => {
      order.push('b');
    });
    await expect(app.runHooks('onRunStart', runStart, { failFast: true })).rejects.toBe(first);
    expect(order).toEqual(['a']);
  });

  it('lets one hook see the payload mutation of the previous one', async () => {
    const app = new App();
    const seen: Array<string | null> = [];
    const submission = { root: '/original' } as HookPayloads['onSubmission']['submission'];
    app.hook('onSubmission', ({ submission: s }) => {
      s.root = '/mutated';
    });
    app.hook('onSubmission', ({ submission: s }) => {
      seen.push(s.root);
    });
    await app.runHooks('onSubmission', { submission });
    expect(seen).toEqual(['/mutated']);
    expect(submission.root).toBe('/mutated');
  });

  it('returns no failures when nothing is registered', async () => {
    await expect(new App().runHooks('onRunStart', runStart)).resolves.toEqual([]);
  });
});
