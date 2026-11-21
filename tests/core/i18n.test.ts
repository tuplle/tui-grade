import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { App } from '../../src/core/app.ts';
import { createTranslate, loadCatalog, localize } from '../../src/core/i18n.ts';
import { defaultPreset } from '../../src/plugins/preset.ts';

const readLocale = async (locale: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../../src/locales/${locale}.json`, import.meta.url)), 'utf8')) as Record<string, string>;

/** Sample parameters per shipped check (the `example` strings are YAML snippets, not parsed values). */
const SAMPLES: Record<string, unknown[]> = {
  exit_code: [0, 'nonzero'],
  stdout_contains: ['x'],
  stdout_matches: ['x'],
  stderr_contains: ['x'],
  stderr_matches: ['x'],
  file_exists: ['a.txt'],
  file_contains: [{ path: 'a.txt', text: 'x' }],
  file_empty: ['a.txt'],
  any_of: [[{ stdout_contains: 'a' }, { exit_code: 0 }]],
  all_of: [[{ stdout_contains: 'a' }, { exit_code: 0 }]],
  script: [{ path: 'check.mjs' }],
  screen_contains: ['x'],
  screen_matches: ['x'],
  function_count: [{ file: 'main.c', min: 1 }],
  no_compiler_warnings: [true],
  file_line_count: [{ file: 'main.c', max: 10 }],
};

describe('catalogs', () => {
  it('en.json and sk.json have identical key sets', async () => {
    const [en, sk] = await Promise.all([readLocale('en'), readLocale('sk')]);
    expect(Object.keys(sk).sort()).toEqual(Object.keys(en).sort());
    for (const value of Object.values({ ...en, ...sk })) expect(value).not.toBe('');
    expect(Object.keys(en).length).toBeGreaterThan(30);
  });

  it('keeps the same {placeholders} in both languages', async () => {
    const [en, sk] = await Promise.all([readLocale('en'), readLocale('sk')]);
    const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
    for (const key of Object.keys(en)) expect([key, vars(sk[key] as string)]).toEqual([key, vars(en[key] as string)]);
  });

  it('has a key for every check registered by the preset', async () => {
    const en = await readLocale('en');
    const app = new App();
    await app.register(defaultPreset);
    const checks = app.list('check');
    expect(checks.length).toBeGreaterThanOrEqual(16);
    for (const { name, def } of checks) {
      const samples = SAMPLES[name];
      if (samples === undefined) throw new Error(`no sample params for check '${name}': add it to SAMPLES`);
      for (const sample of samples) {
        const requested: string[] = [];
        def.describe(def.params.parse(sample), (key) => {
          requested.push(key);
          return key;
        });
        expect(requested.length).toBeGreaterThan(0);
        for (const key of requested) expect(Object.keys(en)).toContain(key);
      }
    }
  });

  it('has a key for every build message code', async () => {
    const { BUILD_CODES } = await import('../../src/core/build.ts');
    const en = await readLocale('en');
    for (const code of Object.values(BUILD_CODES)) expect(Object.keys(en)).toContain(`build.${code}`);
  });
});

describe('loadCatalog', () => {
  it('loads a catalog and returns an empty one for an unknown or unsafe locale', () => {
    expect(loadCatalog('en')['report.points']).toBeDefined();
    expect(loadCatalog('xx')).toEqual({});
    expect(loadCatalog('../core/app')).toEqual({});
  });
});

describe('createTranslate', () => {
  it('returns the Slovak text', async () => {
    const sk = await readLocale('sk');
    expect(createTranslate('sk')('report.points')).toBe(sk['report.points']);
    expect(createTranslate('sk')('report.points')).not.toBe((await readLocale('en'))['report.points']);
  });

  it('falls back to English for an unknown locale and to the key for a missing key', async () => {
    const en = await readLocale('en');
    expect(createTranslate('fr')('report.points')).toBe(en['report.points']);
    expect(createTranslate('sk')('no.such.key')).toBe('no.such.key');
  });

  it('interpolates {vars} and keeps unknown placeholders', () => {
    const t = createTranslate('en', [{ en: { greet: 'Hi {name}, {n} left, {missing}' } }]);
    expect(t('greet', { name: 'Ann', n: 3 })).toBe('Hi Ann, 3 left, {missing}');
  });

  it('consults extra catalogs after the built-in ones: locale first, then English extras', () => {
    const extra = [{ en: { 'x.a': 'A-en', 'x.b': 'B-en' }, sk: { 'x.a': 'A-sk' } }];
    const t = createTranslate('sk', extra);
    expect(t('x.a')).toBe('A-sk');
    expect(t('x.b')).toBe('B-en');
    expect(t('report.points')).toBe(createTranslate('sk')('report.points'));
  });

  it('lets the built-in catalogs win over extras for the same key (a plugin cannot change core strings)', () => {
    const extra = [{ en: { 'report.points': 'HACKED' }, sk: { 'report.points': 'HACKED-sk' } }];
    expect(createTranslate('sk', extra)('report.points')).toBe(createTranslate('sk')('report.points'));
    expect(createTranslate('en', extra)('report.points')).toBe(createTranslate('en')('report.points'));
  });
});

describe('localize', () => {
  it('picks the locale, falls back to en, then to the first value', () => {
    expect(localize({ en: 'a', sk: 'b' }, 'sk')).toBe('b');
    expect(localize({ en: 'a', sk: 'b' }, 'de')).toBe('a');
    expect(localize({ sk: 'b' }, 'de')).toBe('b');
    expect(localize('plain', 'sk')).toBe('plain');
    expect(localize({}, 'sk')).toBe('');
  });
});
