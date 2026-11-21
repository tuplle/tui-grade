import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const docs = join(repo, 'docs');
const read = (name: string): Promise<string> => readFile(join(docs, name), 'utf8');

describe('Docsify documentation', () => {
  it('uses Docsify v5 with a cover, sidebar, navbar and search', async () => {
    const html = await read('index.html');
    expect(html).toContain('docsify@5');
    expect(html).toContain('loadSidebar: true');
    expect(html).toContain('loadNavbar: true');
    expect(html).toContain('coverpage: true');
    expect(html).toContain('search.min.js');
    for (const file of ['README.md', '_coverpage.md', '_sidebar.md', '_navbar.md', '.nojekyll']) {
      await expect(readFile(join(docs, file))).resolves.toBeDefined();
    }
  });

  it('has a resolvable sidebar and no internal design notes in it', async () => {
    const sidebar = await read('_sidebar.md');
    expect(sidebar).not.toContain('superpowers');
    const links = [...sidebar.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1] as string);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      if (link.startsWith('http')) continue;
      const target = link.split('#')[0] as string;
      await expect(readFile(join(docs, target))).resolves.toBeDefined();
    }
  });

  it('keeps superpowers assets out of the public docs tree', async () => {
    expect(await readdir(docs)).not.toContain('superpowers');
  });

  it('publishes the docs through GitHub Pages', async () => {
    const workflow = await readFile(join(repo, '.github', 'workflows', 'pages.yml'), 'utf8');
    expect(workflow).toContain('cp -R docs/. _site/');
    expect(workflow).not.toContain('superpowers');
    expect(workflow).toContain('actions/upload-pages-artifact');
    expect(workflow).toContain('actions/deploy-pages');
  });
});
