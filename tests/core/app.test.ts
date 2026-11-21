import { z } from 'zod';
import { App } from '../../src/core/app.ts';
import { PluginError } from '../../src/core/errors.ts';
import { definePlugin, fp } from '../../src/core/plugin.ts';
import type { CheckDef, StepDef } from '../../src/core/contracts.ts';

const stepDef = (description = 'a step'): StepDef => ({
  description,
  params: z.object({}),
  async run() {},
});

const checkDef = (description = 'a check'): CheckDef => ({
  description,
  params: z.object({}),
  source: 'none',
  describe: () => description,
  async run() {
    return { pass: true };
  },
});

describe('App registries', () => {
  it('finds a registered step in the registering context', () => {
    const app = new App();
    const def = stepDef();
    app.step('noop', def);
    expect(app.lookup('step', 'noop')).toBe(def);
    expect(app.lookup('step', 'missing')).toBeUndefined();
  });

  it('keeps an encapsulated plugin private to itself and its descendants', async () => {
    const root = new App();
    const def = stepDef();
    let childSeen: unknown;
    let grandchildSeen: unknown;
    await root.register(
      definePlugin(async (child) => {
        child.step('private', def);
        await child.register(
          definePlugin((grandchild) => {
            grandchildSeen = grandchild.lookup('step', 'private');
          }),
        );
        childSeen = child.lookup('step', 'private');
      }),
    );
    let siblingSeen: unknown = 'unset';
    await root.register(
      definePlugin((sibling) => {
        siblingSeen = sibling.lookup('step', 'private');
      }),
    );
    expect(childSeen).toBe(def);
    expect(grandchildSeen).toBe(def);
    expect(root.lookup('step', 'private')).toBeUndefined();
    expect(siblingSeen).toBeUndefined();
  });

  it('exposes a shared (fp) plugin registrations in the parent', async () => {
    const root = new App();
    const def = stepDef();
    await root.register(
      fp((app) => {
        app.step('shared', def);
      }),
    );
    expect(root.lookup('step', 'shared')).toBe(def);
  });

  it('rejects duplicate kind:name in one context but allows shadowing a parent', async () => {
    const root = new App();
    root.step('dup', stepDef('one'));
    expect(() => root.step('dup', stepDef('two'))).toThrow(PluginError);
    // same name under a different kind is fine
    expect(() => root.check('dup', checkDef())).not.toThrow();

    const shadow = stepDef('shadow');
    let seen: unknown;
    await root.register(
      definePlugin((child) => {
        child.step('dup', shadow);
        seen = child.lookup('step', 'dup');
      }),
    );
    expect(seen).toBe(shadow);
    expect(root.lookup('step', 'dup')?.description).toBe('one');
  });

  it('exposes the parent of a child context', async () => {
    const root = new App();
    let parent: App | undefined;
    await root.register(
      definePlugin((child) => {
        parent = child.parent;
      }),
    );
    expect(root.parent).toBeUndefined();
    expect(parent).toBe(root);
  });
});

describe('plugin dependencies', () => {
  it('throws PluginError naming the missing dependency', async () => {
    const root = new App();
    const plugin = definePlugin(() => {}, { name: 'consumer', dependencies: ['missing-dep'] });
    const err = await root.register(plugin).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).message).toContain('missing-dep');
  });

  it('passes once the dependency was registered earlier', async () => {
    const root = new App();
    await root.register(fp(() => {}, { name: 'x' }));
    expect(root.hasPlugin('x')).toBe(true);
    await expect(
      root.register(definePlugin(() => {}, { name: 'needs-x', dependencies: ['x'] })),
    ).resolves.toBeUndefined();
  });

  it('resolves named plugins up the chain only', async () => {
    const root = new App();
    await root.register(definePlugin(() => {}, { name: 'x' }));
    expect(root.hasPlugin('x')).toBe(true);
    let inChild = false;
    await root.register(
      definePlugin((child) => {
        inChild = child.hasPlugin('x');
      }),
    );
    expect(inChild).toBe(true);
    expect(root.hasPlugin('nope')).toBe(false);
  });
});

describe('plugin execution', () => {
  it('awaits async plugins so registration order is preserved', async () => {
    const root = new App();
    const order: string[] = [];
    await root.register(
      fp(async (app) => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push('first');
        app.step('a', stepDef());
      }),
    );
    await root.register(
      fp((app) => {
        order.push('second');
        expect(app.lookup('step', 'a')).toBeDefined();
      }),
    );
    expect(order).toEqual(['first', 'second']);
  });

  it('wraps a throwing plugin in PluginError that includes the plugin name', async () => {
    const root = new App();
    const plugin = definePlugin(
      () => {
        throw new Error('boom');
      },
      { name: 'bad-plugin' },
    );
    const err = await root.register(plugin).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).message).toContain('bad-plugin');
    expect((err as Error).message).toContain('boom');
  });

  it('does not count a plugin that threw as loaded', async () => {
    const root = new App();
    const failing = fp(
      () => {
        throw new Error('boom');
      },
      { name: 'flaky' },
    );
    await expect(root.register(failing)).rejects.toBeInstanceOf(PluginError);
    expect(root.hasPlugin('flaky')).toBe(false);
    await expect(
      root.register(definePlugin(() => {}, { name: 'consumer', dependencies: ['flaky'] })),
    ).rejects.toThrow(/flaky/);
  });

  it('passes options to the plugin function', async () => {
    const root = new App();
    let received: unknown;
    await root.register(
      definePlugin<{ n: number }>((_app, opts) => {
        received = opts;
      }),
      { n: 3 },
    );
    expect(received).toEqual({ n: 3 });
  });
});

describe('decorators', () => {
  it('resolves up the chain and does not leak upward', async () => {
    const root = new App();
    root.decorate('rootValue', 1);
    let fromChild: unknown;
    await root.register(
      definePlugin((child) => {
        child.decorate('childValue', 2);
        fromChild = child.getDecorator('rootValue');
      }),
    );
    expect(fromChild).toBe(1);
    expect(root.getDecorator('childValue')).toBeUndefined();
    expect(root.getDecorator<number>('rootValue')).toBe(1);
  });

  it('rejects a duplicate decorator in one context', () => {
    const root = new App();
    root.decorate('x', 1);
    expect(() => root.decorate('x', 2)).toThrow(PluginError);
  });
});

describe('list', () => {
  it('returns a nearest-wins merged view', async () => {
    const root = new App();
    root.check('a', checkDef('root a'));
    root.check('b', checkDef('root b'));
    let listed: Array<{ name: string; description: string }> = [];
    await root.register(
      definePlugin((child) => {
        child.check('b', checkDef('child b'));
        child.check('c', checkDef('child c'));
        listed = child.list('check').map(({ name, def }) => ({ name, description: def.description }));
      }),
    );
    const sorted = [...listed].sort((x, y) => x.name.localeCompare(y.name));
    expect(sorted).toEqual([
      { name: 'a', description: 'root a' },
      { name: 'b', description: 'child b' },
      { name: 'c', description: 'child c' },
    ]);
    expect(root.list('check').map((e) => e.name).sort()).toEqual(['a', 'b']);
  });
});
