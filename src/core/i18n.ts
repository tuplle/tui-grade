// Message catalogs (§9): flat dotted keys with `{var}` interpolation; English is the fallback language.
import { readFileSync } from 'node:fs';
import type { LocalizedText, Translate } from './contracts.ts';

type Catalog = Record<string, string>;
/** Extra catalogs (e.g. from plugins): locale → key → text. */
export type ExtraCatalogs = Array<Record<string, Catalog>>;

const cache = new Map<string, Catalog>();

/**
 * Reads `locales/<locale>.json` next to the module's parent directory (`src/locales` when run from
 * source, `dist/locales` when built). An unknown or malformed locale yields an empty catalog.
 */
export function loadCatalog(locale: string): Catalog {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) return {}; // the locale becomes part of a file name
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;
  let catalog: Catalog = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) catalog = parsed as Catalog;
  } catch {
    // no such catalog: callers fall back to English
  }
  cache.set(locale, catalog);
  return catalog;
}

const interpolate = (text: string, vars: Record<string, string | number> | undefined): string =>
  vars === undefined ? text : text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));

/**
 * Builds a translator for `locale`. Lookup order: built-in catalog of the locale, built-in English, extra catalogs
 * of the locale, extra English catalogs; a missing key is returned as-is. The built-in catalogs win, so a plugin can
 * add keys of its own but can never change a core string.
 */
export function createTranslate(locale: string, extra: ExtraCatalogs = []): Translate {
  const sources: Catalog[] = [
    loadCatalog(locale),
    loadCatalog('en'),
    ...extra.map((e) => e[locale]),
    ...extra.map((e) => e.en),
  ].filter((c): c is Catalog => c !== undefined);
  return (key, vars) => {
    for (const source of sources) {
      const text = Object.hasOwn(source, key) ? source[key] : undefined;
      if (text !== undefined) return interpolate(text, vars);
    }
    return key;
  };
}

/** A string is returned as-is; an object picks `locale`, then `en`, then its first value ('' when empty). */
export function localize(text: LocalizedText, locale: string): string {
  if (typeof text === 'string') return text;
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
}
