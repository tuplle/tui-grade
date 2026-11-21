// Turns a plugin specifier from `assignment.yaml` into a `PluginDef`.
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinPlugins } from '../plugins/index.ts';
import type { PluginDef } from './plugin.ts';

function isPluginDef(value: unknown): value is PluginDef {
  if (value === null || typeof value !== 'object') return false;
  const { fn, meta } = value as Record<string, unknown>;
  return typeof fn === 'function' && meta !== null && typeof meta === 'object';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONDITIONS = ['node', 'import', 'default'];

/** First usable target of an `exports` value, honouring the conditions of an ESM `import` from Node. */
function pickTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const picked = pickTarget(item);
      if (picked !== undefined) return picked;
    }
  } else if (target !== null && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (!CONDITIONS.includes(condition)) continue;
      const picked = pickTarget(value);
      if (picked !== undefined) return picked;
    }
  }
  return undefined;
}

/** Looks `subpath` ('.' or './x') up in a package.json `exports` field (exact keys and `*` patterns). */
function resolveExports(exportsField: unknown, subpath: string): string | undefined {
  const isMap =
    exportsField !== null &&
    typeof exportsField === 'object' &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith('.'));
  if (!isMap) return subpath === '.' ? pickTarget(exportsField) : undefined;
  const map = exportsField as Record<string, unknown>;
  if (Object.hasOwn(map, subpath)) return pickTarget(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.length >= key.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const picked = pickTarget(value);
      return picked?.replaceAll('*', subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a bare package specifier to a file with ESM semantics (`import` conditions, no `require`
 * fallback): walks up from `fromDir` to the nearest `node_modules/<package>` and reads its package.json
 * `exports` (or `main`, then `index.js`). `import.meta.resolve` with a parent is not usable here:
 * it needs a flag in Node and goes through Jest's own resolver in the tests.
 */
async function resolvePackage(spec: string, fromDir: string): Promise<string> {
  const parts = spec.split('/');
  const nameLength = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength).join('/');
  const subpath = parts.length > nameLength ? `./${parts.slice(nameLength).join('/')}` : '.';

  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', name);
    let manifest: Record<string, unknown> | undefined;
    try {
      manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) throw new Error(`package '${name}' has an invalid package.json`, { cause: error });
    }
    if (manifest !== undefined) {
      let relative: string | undefined;
      if (manifest['exports'] !== undefined && manifest['exports'] !== null) {
        relative = resolveExports(manifest['exports'], subpath);
        if (relative === undefined) {
          const what = subpath === '.' ? 'a main entry point for ESM import' : `'${subpath}'`;
          throw new Error(`package '${name}' does not export ${what} (check its package.json "exports")`);
        }
      } else if (subpath === '.') {
        const main = manifest['main'];
        relative = typeof main === 'string' && main !== '' ? main : 'index.js';
      } else {
        relative = subpath;
      }
      const file = resolve(pkgDir, relative);
      if (await isFile(file)) return file;
      if (subpath === '.' && manifest['exports'] === undefined && (await isFile(`${file}.js`))) return `${file}.js`;
      throw new Error(`package '${name}' points to '${relative}', which does not exist`);
    }
    if (dirname(dir) === dir) throw new Error(`package '${name}' is not installed (searched node_modules from ${resolve(fromDir)} upward)`);
  }
}

/**
 * `./x.js` and absolute paths are imported from the file system (relative ones against the assignment
 * directory), a builtin name maps to the builtin plugin, anything else is an npm package resolved from
 * the assignment directory with ESM semantics (import-only `exports` work). The module's `default` (or `plugin`) export must be a plugin definition.
 * Throws an `Error` with a readable message when the plugin cannot be resolved or loaded.
 */
export async function resolvePlugin(spec: string, assignmentDir: string): Promise<PluginDef> {
  const isPath = spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec);
  if (!isPath && Object.hasOwn(builtinPlugins, spec)) return builtinPlugins[spec] as PluginDef;

  let file: string;
  if (isPath) {
    file = resolve(assignmentDir, spec);
  } else {
    try {
      file = await resolvePackage(spec, assignmentDir);
    } catch (error) {
      throw new Error(`cannot resolve plugin '${spec}': not a builtin plugin and ${message(error)}`, { cause: error });
    }
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot load plugin '${spec}' (${file}): ${message(error)}`, { cause: error });
  }
  const def = mod['default'] ?? mod['plugin'];
  if (!isPluginDef(def)) {
    throw new Error(
      `plugin '${spec}' must export a plugin definition (definePlugin/fp result) as its default or 'plugin' export`,
    );
  }
  return def;
}
