import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { withTempDir } from './helpers/tmp.ts';

const run = promisify(execFile);
const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const at = (...parts: string[]): string => join(root, ...parts);

interface Manifest {
  main: string;
  types: string;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, { types: string; default: string }>;
  scripts: Record<string, string>;
}
type Workflow = {
  on: { push?: { tags?: string[] } | null; pull_request?: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, { 'runs-on': string; steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> }>;
};

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(at(file), 'utf8')) as T;
const readYaml = async <T>(file: string): Promise<T> => parse(await readFile(at(file), 'utf8')) as T;
const steps = (wf: Workflow): Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> =>
  Object.values(wf.jobs).flatMap((job) => job.steps);
const commands = (wf: Workflow): string[] => steps(wf).flatMap((s) => (s.run === undefined ? [] : s.run.split('\n').map((l) => l.trim())));

beforeAll(async () => {
  // A fresh build, so that the assertions below look at what the sources produce right now.
  await run('pnpm', ['build'], { cwd: root, timeout: 240_000 });
}, 300_000);

describe('built package', () => {
  it('(a) the CLI entry exists, has a shebang, is executable and runs', async () => {
    const manifest = await readJson<Manifest>('package.json');
    const bin = at(manifest.bin['tui-grade'] as string);
    expect((await readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
    await expect(access(bin, constants.X_OK)).resolves.toBeUndefined();

    const { stdout } = await run('node', [bin, 'describe', '--json'], { cwd: root });
    const entries = JSON.parse(stdout) as Array<{ kind: string; name: string }>;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'step', name: 'run' })]));
  });

  it('(b) ships both message catalogs inside dist', async () => {
    for (const locale of ['en', 'sk']) {
      const catalog = JSON.parse(await readFile(at('dist', 'locales', `${locale}.json`), 'utf8')) as Record<string, string>;
      expect(Object.keys(catalog).length).toBeGreaterThan(0);
    }
  });

  it('(c) every exports target resolves to an existing file', async () => {
    const manifest = await readJson<Manifest>('package.json');
    const missing: string[] = [];
    const targets: string[] = [manifest.main, manifest.types];
    const pluginDirs = (await readdir(at('dist', 'plugins'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(pluginDirs).toEqual(expect.arrayContaining(['builder-gcc', 'steps-session', 'reporter-json']));
    for (const [key, entry] of Object.entries(manifest.exports)) {
      for (const target of [entry.types, entry.default]) {
        if (key.includes('*')) targets.push(...pluginDirs.map((dir) => target.replace('*', dir)));
        else targets.push(target);
      }
    }
    for (const target of targets) if (!existsSync(at(target))) missing.push(target);
    expect(missing).toEqual([]);
    expect(Object.keys(manifest.exports)).toEqual(['.', './plugins/*']);
  });

  it('(d) the packed file list contains dist, LICENSE.txt and README.md and nothing from the repository internals', async () => {
    const { stdout } = await run('pnpm', ['pack', '--dry-run', '--json'], { cwd: root, timeout: 120_000 });
    const packed = (JSON.parse(stdout) as { files: Array<{ path: string }> }).files.map((f) => f.path);
    expect(packed).toEqual(
      expect.arrayContaining([
        'LICENSE.txt',
        'README.md',
        'package.json',
        'dist/index.js',
        'dist/index.d.ts',
        'dist/cli/main.js',
        'dist/locales/en.json',
        'dist/locales/sk.json',
        'dist/web/public/index.html',
        'dist/web/public/app.css',
        'dist/web/public/app.js',
        'dist/web/public/theme.js',
      ]),
    );
    const stray = packed.filter((p) => !(p.startsWith('dist/') || ['LICENSE.txt', 'README.md', 'package.json'].includes(p)));
    expect(stray).toEqual([]);
    for (const forbidden of ['tests/', 'examples/', '.superpowers/', 'src/', 'scripts/']) {
      expect(packed.filter((p) => p.startsWith(forbidden))).toEqual([]);
    }
  });
});

describe('GitHub workflows', () => {
  it('ci.yml runs the checks on push and pull requests', async () => {
    const wf = await readYaml<Workflow>('.github/workflows/ci.yml');
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    const uses = steps(wf).flatMap((s) => (s.uses === undefined ? [] : [s.uses]));
    expect(uses).toEqual(expect.arrayContaining([expect.stringMatching(/^actions\/checkout@v\d+$/), expect.stringMatching(/^pnpm\/action-setup@v\d+$/), expect.stringMatching(/^actions\/setup-node@v\d+$/)]));
    const node = steps(wf).find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(String(node?.with?.['node-version'])).toBe('26');
    expect(node?.with?.['cache']).toBe('pnpm');
    const cmds = commands(wf);
    const order = ['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm build'].map((c) => cmds.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(Object.values(wf.jobs).map((job) => job['runs-on'])).toEqual(
      expect.arrayContaining(['${{ matrix.os }}', 'windows-latest']),
    );
  });

  it('release.yml builds the tarball and the standalone bundle on v* tags', async () => {
    const wf = await readYaml<Workflow>('.github/workflows/release.yml');
    expect(wf.on.push?.tags).toEqual(['v*']);
    expect(wf.permissions?.['contents']).toBe('write');
    expect(wf.permissions?.['id-token']).toBe('write'); // OIDC for npm trusted publishing
    const releaseText = await readFile(at('.github/workflows/release.yml'), 'utf8');
    expect(releaseText).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    // npm refuses to run in this repository (devEngines requires pnpm), so the workflow must use pnpm.
    expect(releaseText).not.toMatch(/^\s*npm\s/m);
    const setupNode = wf.jobs['release']?.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['registry-url']).toBe('https://registry.npmjs.org');
    const cmds = commands(wf);
    expect(cmds).toEqual(expect.arrayContaining(['pnpm install --frozen-lockfile', 'pnpm build', 'pnpm pack', 'node scripts/make-bundle.mjs']));
    const releaseSteps = wf.jobs['release']?.steps ?? [];
    const runs = releaseSteps.map((s) => s.run);
    const tagCheck = runs.findIndex((r) => r?.includes('GITHUB_REF_NAME'));
    expect(runs[tagCheck]).toBe('test "v$(node -p "require(\'./package.json\').version")" = "$GITHUB_REF_NAME"');
    expect(tagCheck).toBeLessThan(runs.indexOf('pnpm build')); // a wrong tag fails before anything is built
    const release = steps(wf).find((s) => s.uses?.startsWith('softprops/action-gh-release@'));
    expect(release?.uses).toMatch(/@v\d+$/);
    const files = String(release?.with?.['files']);
    expect(files).toContain('*.tgz');
    expect(files).toContain('.tar.gz');
  });

  it.each(['.github/workflows/ci.yml', '.github/workflows/release.yml', 'docs/ci-grading-example.yml'])(
    '%s does not leave the git token on disk',
    async (file) => {
      const wf = await readYaml<Workflow>(file);
      const checkouts = steps(wf).filter((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkouts.length).toBeGreaterThan(0);
      for (const checkout of checkouts) expect(checkout.with?.['persist-credentials']).toBe(false);
    },
  );

  it('docs/ci-grading-example.yml is a documented sample workflow that parses', async () => {
    const text = await readFile(at('docs', 'ci-grading-example.yml'), 'utf8');
    expect(text.startsWith('#')).toBe(true);
    expect(text.split('\n')[0]).toMatch(/example/i);
    const wf = parse(text) as Workflow;
    expect(commands(wf).some((c) => c.includes('tui-grade run'))).toBe(true);
    expect(steps(wf).some((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with?.['name'] === 'grading-results')).toBe(true);
  });
});

describe('installed from the packed tarball', () => {
  const NETWORK = /ENOTCACHED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ERR_PNPM_FETCH|ERR_PNPM_NO_OFFLINE|getaddrinfo/i;

  it('(e) a plugin importing the package can definePlugin and `tui-grade check` runs (skipped without network)', async () => {
    await withTempDir(async (dir) => {
      const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', dir], { cwd: root, timeout: 120_000 });
      const tarball = (JSON.parse(stdout) as { filename: string }).filename;
      const project = join(dir, 'project');
      await mkdir(project);
      await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
      // pnpm 12 refuses dependencies with install scripts unless they are decided on; koffi's script only looks for a prebuilt binary.
      await writeFile(join(project, 'pnpm-workspace.yaml'), 'allowBuilds:\n  koffi: false\n');
      try {
        await run('pnpm', ['add', '--prefer-offline', tarball], { cwd: project, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        const text = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`; // not the message: it echoes the command line
        if (!NETWORK.test(text) || process.env['CI']) throw error; // on CI a missing network is a failure, not a skip
        process.stderr.write('SKIPPED packaging test (e): installing the tarball needs the network, which is not available\n');
        return;
      }

      const assignment = join(project, 'assignment');
      await mkdir(join(assignment, 'scenarios'), { recursive: true });
      await writeFile(
        join(project, 'plugin.mjs'),
        `import { definePlugin, z } from 'tui-grade';
export default definePlugin(
  (app) => {
    app.check('always_ok', {
      description: 'Always passes.',
      params: z.literal(true),
      source: 'none',
      describe: () => 'always ok',
      run: async () => ({ pass: true }),
    });
  },
  { name: 'consumer-plugin' },
);
`,
      );
      await writeFile(
        join(assignment, 'assignment.yaml'),
        'name: consumer\nmax_points: 1\nbuild: { type: custom, command: "true" }\nproject_root_marker: main.c\nplugins: [../plugin.mjs]\n',
      );
      await writeFile(join(assignment, 'scenarios', 's.yaml'), '- id: s1\n  title: Static\n  expect:\n    - always_ok: true\n');

      const bin = join(project, 'node_modules', '.bin', 'tui-grade');
      const checked = await run(bin, ['check', assignment], { cwd: project });
      expect(checked.stdout).toContain('valid: 1 scenario');

      // The npx route must work from the same packed tarball.
      const npx = await run('npx', ['--yes', '--package', tarball, 'tui-grade', '--version'], { cwd: project, timeout: 180_000 });
      expect(npx.stdout.trim()).toBe('1.0.0');

      // the built-in plugins are importable through the `exports` map
      const probe = await run('node', ['--input-type=module', '-e', "const m = await import('tui-grade/plugins/steps-basic'); console.log(typeof m.stepsBasic.fn)"], { cwd: project });
      expect(probe.stdout.trim()).toBe('function');

      // and the shipped example assignment validates against the installed package
      const example = join(project, 'mission');
      await cp(at('examples', 'mission'), example, { recursive: true });
      expect((await stat(example)).isDirectory()).toBe(true);
      const exampleCheck = await run(bin, ['check', example], { cwd: project });
      expect(exampleCheck.stdout).toContain('valid:');
    });
  }, 300_000);
});
