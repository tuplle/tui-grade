// Builds the standalone release bundle: `bundle/` (dist + production node_modules + a `tui-grade` wrapper)
// and `tui-grade-<version>-<platform>-<arch>.tar.gz` next to it. Run `pnpm build` first.
//
// The bundle ships `node_modules` because the terminal library (@microsoft/tui-test) comes with a native,
// platform-specific package; the archive therefore only works on the platform it was built on.
//
//   node scripts/make-bundle.mjs                   # pnpm deploy --prod, falling back to a prod install
//   BUNDLE_METHOD=install node scripts/make-bundle.mjs   # force the fallback (pnpm install --prod --frozen-lockfile)
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { create as createTar, extract as extractTar } from 'tar';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(root, 'bundle');

const WRAPPER = `#!/bin/sh
# Starts the bundled tui-grade; works when called through a symlink.
self="$0"
while [ -h "$self" ]; do
  dir=$(cd "$(dirname "$self")" && pwd -P)
  link=$(readlink "$self")
  case "$link" in
    /*) self="$link" ;;
    *) self="$dir/$link" ;;
  esac
done
DIR=$(cd "$(dirname "$self")" && pwd -P)
exec node "$DIR/dist/cli/main.js" "$@"
`;

const WIN_WRAPPER = `@echo off
node "%~dp0dist\\cli\\main.js" %*
`;

class StepError extends Error {}

/** Runs one named step; any failure is reported with the step name and the command output. */
async function step(name, fn) {
  console.log(`[make-bundle] ${name}`);
  try {
    return await fn();
  } catch (error) {
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
    const detail = output === '' ? (error?.message ?? String(error)) : `${error?.message ?? ''}\n${output}`;
    throw new StepError(`step failed: ${name}\n${detail}`, { cause: error });
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

const exec = (command, args, cwd = root) => run(command, args, { cwd, maxBuffer: MAX_BUFFER });

// `pnpm` is pnpm.cmd on Windows, which execFile cannot start without a shell.
const pnpm = (args, cwd = root) =>
  run('pnpm', args, { cwd, maxBuffer: MAX_BUFFER, shell: process.platform === 'win32' });

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function deployWithPnpm(name) {
  await pnpm(['--filter', name, 'deploy', '--prod', bundle]);
}

async function installWithPnpm() {
  await mkdir(bundle, { recursive: true });
  await cp(join(root, 'dist'), join(bundle, 'dist'), { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE.txt', 'README.md']) {
    if (await exists(join(root, file))) await cp(join(root, file), join(bundle, file));
  }
  await pnpm(['install', '--prod', '--frozen-lockfile'], bundle);
}

const launcherName = process.platform === 'win32' ? 'tui-grade.cmd' : 'tui-grade';

async function runLauncher(file, args, cwd) {
  if (process.platform === 'win32') {
    const { stdout } = await exec(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', file, ...args], cwd);
    return { stdout };
  }
  return exec(file, args, cwd);
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const archive = `tui-grade-${manifest.version}-${process.platform}-${process.arch}.tar.gz`;

  await step('check that the project is built (run `pnpm build` first)', async () => {
    if (!(await exists(join(root, 'dist', 'cli', 'main.js')))) throw new Error('dist/cli/main.js is missing');
  });

  await step('remove the previous bundle', async () => {
    await rm(bundle, { recursive: true, force: true });
    await rm(join(root, archive), { force: true });
  });

  let method = process.env.BUNDLE_METHOD === 'install' ? 'install' : 'deploy';
  if (method === 'deploy') {
    try {
      await step('pnpm deploy --prod', () => deployWithPnpm(manifest.name));
    } catch (error) {
      console.warn(`[make-bundle] pnpm deploy failed, falling back to a production install:\n${error.message}`);
      await rm(bundle, { recursive: true, force: true });
      method = 'install';
    }
  }
  if (method === 'install') await step('copy dist and run pnpm install --prod --frozen-lockfile', installWithPnpm);

  await step('check the native tui-test platform package', async () => {
    const store = join(bundle, 'node_modules', '.pnpm');
    const native = (await readdir(store)).filter((entry) => entry.startsWith('@microsoft+tui-test-'));
    if (native.length === 0) throw new Error(`no @microsoft/tui-test-<platform> package in ${store}; sessions would not work`);
  });

  await step('write the tui-grade wrapper', async () => {
    const file = join(bundle, launcherName);
    await writeFile(file, process.platform === 'win32' ? WIN_WRAPPER : WRAPPER);
    if (process.platform !== 'win32') {
      await chmod(file, 0o755);
      await chmod(join(bundle, 'dist', 'cli', 'main.js'), 0o755);
    }
  });

  await step('smoke test: tui-grade describe --json from another directory', async () => {
    const { stdout } = await runLauncher(join(bundle, launcherName), ['describe', '--json'], '/');
    if (!Array.isArray(JSON.parse(stdout))) throw new Error('describe --json did not print a JSON array');
  });

  await step(`create ${archive}`, async () => {
    // A staging directory gives every archive entry the same `tui-grade/` prefix on every platform.
    const staging = await mkdtemp(join(tmpdir(), 'tui-grade-stage-'));
    try {
      await cp(bundle, join(staging, 'tui-grade'), { recursive: true, verbatimSymlinks: true });
      await createTar({ gzip: true, file: join(root, archive), cwd: staging, portable: true }, ['tui-grade']);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  await step(`smoke test: extract ${archive} and run it`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tui-grade-bundle-'));
    try {
      await extractTar({ file: join(root, archive), cwd: dir });
      const { stdout } = await runLauncher(join(dir, 'tui-grade', launcherName), ['describe', '--json'], dir);
      if (!Array.isArray(JSON.parse(stdout))) throw new Error('describe --json did not print a JSON array');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  console.log(`[make-bundle] done (method: ${method}): bundle/ and ${archive}`);
}

main().catch((error) => {
  console.error(`[make-bundle] ERROR: ${error.message}`);
  process.exitCode = 1;
});
