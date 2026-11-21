import { readFile } from 'node:fs/promises';

const at = (name: string): Promise<string> => readFile(new URL(`../../src/web/public/${name}`, import.meta.url), 'utf8');

describe('dashboard assets', () => {
  it('renders untrusted text with x-text and never x-html or innerHTML', async () => {
    const html = await at('index.html');
    const js = await at('app.js');
    expect(html).not.toContain('x-html');
    expect(js).not.toContain('innerHTML');
  });

  it('bundles Alpine through app.js instead of a vendor script', async () => {
    const html = await at('index.html');
    const js = await at('app.js');
    expect(html).not.toContain('/vendor/alpine.min.js');
    expect(js).toContain("import Alpine from 'alpinejs'");
    expect(js).toContain('Alpine.start()');
  });

  it('has external scripts only (CSP-compatible) and a pre-paint theme script', async () => {
    const html = await at('index.html');
    for (const match of html.matchAll(/<script\b[^>]*>/g)) expect(match[0]).toContain('src=');
    expect(html).toContain('src="/theme.js"');
    expect(html.indexOf('src="/theme.js"')).toBeLessThan(html.indexOf('href="/app.css"'));
  });

  it('defines light and dark tokens and a persisted theme key', async () => {
    const css = await at('app.css');
    const theme = await at('theme.js');
    expect(css).toContain(':root');
    expect(css).toContain('.dark');
    expect(theme).toContain("localStorage.getItem('tui-grade-theme')");
    expect(theme).toContain("classList.toggle('dark'");
  });
});
