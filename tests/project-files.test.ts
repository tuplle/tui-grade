import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const at = (...parts: string[]): string => join(repo, ...parts);

describe('public repository files', () => {
  it('has the project and community documents', async () => {
    for (const file of [
      'README.md',
      'LICENSE.txt',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'CHANGELOG.md',
      '.editorconfig',
    ]) {
      await expect(stat(at(file))).resolves.toBeDefined();
    }
  });

  it('has issue, pull request and automation templates', async () => {
    for (const file of [
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/ISSUE_TEMPLATE/config.yml',
      '.github/pull_request_template.md',
      '.github/dependabot.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/pages.yml',
    ]) {
      await expect(stat(at(file))).resolves.toBeDefined();
    }
  });

  it('has publishable package metadata and no generated content in files', async () => {
    const pkg = JSON.parse(await readFile(at('package.json'), 'utf8')) as {
      license: string;
      files: string[];
      repository: { url: string };
      bugs: { url: string };
      homepage: string;
      engines: { node: string };
      publishConfig: { access: string };
    };
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.repository.url).toContain('github.com/tuplle/tui-grade');
    expect(pkg.bugs.url).toContain('/issues');
    expect(pkg.homepage).toContain('tuplle.github.io/tui-grade');
    expect(pkg.engines.node).toContain('26');
    expect(pkg.publishConfig.access).toBe('public');
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE.txt']));
  });

  it('keeps generated and local planning content out of git', async () => {
    const ignore = await readFile(at('.gitignore'), 'utf8');
    for (const pattern of ['dist', 'bundle/', 'grading-results/', 'graphify-out/', '.superpowers', '.openchamber']) {
      expect(ignore).toContain(pattern);
    }
  });
});
