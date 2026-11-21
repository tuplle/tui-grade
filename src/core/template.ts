// `${name}` interpolation over arbitrary JSON-like values (scenario params, matrix values).

/** A `${name}` placeholder referenced a variable that is not defined. */
export class UnknownVariableError extends Error {
  override name = 'UnknownVariableError';
  readonly variable: string;

  constructor(variable: string) {
    super(`unknown variable \${${variable}}`);
    this.variable = variable;
  }
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Deeply replaces `${name}` in every string (object keys are left alone). An unknown variable throws
 * `UnknownVariableError` unless `keepUnknown` is set, in which case the placeholder is kept verbatim.
 */
export function interpolate<T>(value: T, vars: Record<string, string>, opts?: { keepUnknown?: boolean }): T {
  const keepUnknown = opts?.keepUnknown ?? false;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(PLACEHOLDER, (placeholder, name: string) => {
        if (Object.hasOwn(vars, name)) return vars[name] as string;
        if (keepUnknown) return placeholder;
        throw new UnknownVariableError(name);
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}

/** Names of all `${name}` placeholders found in the value, deduplicated, in order of first appearance. */
export function findVariables(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(PLACEHOLDER)) found.add(match[1] as string);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}
