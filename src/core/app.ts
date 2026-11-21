import type { DefOf, StepDef, CheckDef, BuilderDef, ReporterDef, ScorerDef } from './contracts.ts';
import { PluginError } from './errors.ts';
import type { HookFailure, HookFn, HookName, HookPayloads } from './hooks.ts';
import type { Kind, PluginDef } from './plugin.ts';

interface HookEntry {
  fn: HookFn<HookName>;
  plugin: string | undefined;
}

/** A plugin context: one registry per kind, decorators, hooks and loaded plugin names, linked to its parent. */
export class App {
  readonly parent: App | undefined;
  readonly #registries: { [K in Kind]: Map<string, DefOf<K>> };
  readonly #decorators = new Map<string, unknown>();
  readonly #plugins = new Set<string>();
  readonly #catalogs = new Map<string, Record<string, string>>();
  readonly #hooks = new Map<HookName, HookEntry[]>();
  #registering: string | undefined;

  constructor(parent?: App) {
    this.parent = parent;
    this.#registries = {
      step: new Map(),
      check: new Map(),
      builder: new Map(),
      reporter: new Map(),
      scorer: new Map(),
    };
  }

  async register<O>(plugin: PluginDef<O>, opts?: O): Promise<void> {
    const name = plugin.meta.name;
    const label = name ?? (plugin.fn.name || '<anonymous>');
    for (const dep of plugin.meta.dependencies ?? []) {
      if (!this.hasPlugin(dep)) {
        throw new PluginError(`plugin '${label}' requires plugin '${dep}', which is not loaded`);
      }
    }
    const target = plugin.shared ? this : new App(this);
    const outer = target.#registering;
    target.#registering = name;
    try {
      await plugin.fn(target, opts as O);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PluginError(`plugin '${label}' failed: ${reason}`, { cause: error });
    } finally {
      target.#registering = outer;
    }
    if (name !== undefined) this.#plugins.add(name);
  }

  step(name: string, def: StepDef): void {
    this.#define('step', name, def);
  }
  check(name: string, def: CheckDef): void {
    this.#define('check', name, def);
  }
  builder(name: string, def: BuilderDef): void {
    this.#define('builder', name, def);
  }
  reporter(name: string, def: ReporterDef): void {
    this.#define('reporter', name, def);
  }
  scorer(name: string, def: ScorerDef): void {
    this.#define('scorer', name, def);
  }

  hook<N extends HookName>(name: N, fn: HookFn<N>): void {
    const entries = this.#hooks.get(name) ?? [];
    entries.push({ fn: fn as HookFn<HookName>, plugin: this.#registering });
    this.#hooks.set(name, entries);
  }

  /**
   * Runs the hooks visible from this context sequentially: ancestors first, then own, each in
   * registration order. A failing hook is collected and the rest still run; with `failFast` the
   * first error is rethrown instead.
   */
  async runHooks<N extends HookName>(
    name: N,
    payload: HookPayloads[N],
    opts: { failFast?: boolean } = {},
  ): Promise<HookFailure[]> {
    const chain: App[] = [];
    for (let app: App | undefined = this; app !== undefined; app = app.parent) chain.unshift(app);
    const failures: HookFailure[] = [];
    for (const app of chain) {
      for (const { fn, plugin } of app.#hooks.get(name) ?? []) {
        try {
          await fn(payload);
        } catch (thrown) {
          if (opts.failFast) throw thrown;
          const error = thrown instanceof Error ? thrown : new Error(String(thrown));
          failures.push(plugin === undefined ? { hook: name, error } : { hook: name, plugin, error });
        }
      }
    }
    return failures;
  }

  /** Own context first, then ancestors. */
  lookup<K extends Kind>(kind: K, name: string): DefOf<K> | undefined {
    for (let app: App | undefined = this; app !== undefined; app = app.parent) {
      const def = app.#registries[kind].get(name);
      if (def !== undefined) return def;
    }
    return undefined;
  }

  /** Everything visible from here; the nearest context wins on a name clash. */
  list<K extends Kind>(kind: K): Array<{ name: string; def: DefOf<K> }> {
    const merged = new Map<string, DefOf<K>>();
    for (let app: App | undefined = this; app !== undefined; app = app.parent) {
      for (const [name, def] of app.#registries[kind]) {
        if (!merged.has(name)) merged.set(name, def);
      }
    }
    return [...merged].map(([name, def]) => ({ name, def }));
  }

  /**
   * Adds message texts for `locale` (`key → text`, `{var}` placeholders) that plugins can use through `t(key)`.
   * Registering the same locale again in one context merges, the later call winning per key. Built-in messages
   * always take precedence over plugin catalogs.
   */
  catalog(locale: string, entries: Record<string, string>): void {
    this.#catalogs.set(locale, { ...this.#catalogs.get(locale), ...entries });
  }

  /** Catalogs visible from here, one object per context (nearest first), shaped for `createTranslate`. */
  getCatalogs(): Array<Record<string, Record<string, string>>> {
    const chain: Array<Record<string, Record<string, string>>> = [];
    for (let app: App | undefined = this; app !== undefined; app = app.parent) {
      if (app.#catalogs.size > 0) chain.push(Object.fromEntries(app.#catalogs));
    }
    return chain;
  }

  decorate(name: string, value: unknown): void {
    if (this.#decorators.has(name)) {
      throw new PluginError(`decorator '${name}' is already defined in this context`);
    }
    this.#decorators.set(name, value);
  }

  getDecorator<T = unknown>(name: string): T | undefined {
    for (let app: App | undefined = this; app !== undefined; app = app.parent) {
      if (app.#decorators.has(name)) return app.#decorators.get(name) as T;
    }
    return undefined;
  }

  /** Named plugins loaded in this chain (this context and its ancestors). */
  hasPlugin(name: string): boolean {
    for (let app: App | undefined = this; app !== undefined; app = app.parent) {
      if (app.#plugins.has(name)) return true;
    }
    return false;
  }

  #define<K extends Kind>(kind: K, name: string, def: DefOf<K>): void {
    const registry = this.#registries[kind] as Map<string, DefOf<K>>;
    if (registry.has(name)) {
      throw new PluginError(`${kind} '${name}' is already registered in this context`);
    }
    registry.set(name, def);
  }
}
