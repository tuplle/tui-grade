// Builds the browser client: esbuild bundles app.js (including Alpine), static files are copied, Tailwind compiles CSS.
import { execFile } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const from = join(root, 'src', 'web', 'public');
const to = join(root, 'dist', 'web', 'public');
const tailwind = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss');

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
for (const file of ['index.html', 'theme.js', 'logo.png']) await cp(join(from, file), join(to, file));

await build({
  entryPoints: [join(from, 'app.js')],
  outfile: join(to, 'app.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2024',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

await run(tailwind, ['-i', join(from, 'app.css'), '-o', join(to, 'app.css'), '--minify'], {
  cwd: root,
  stdio: 'inherit',
  // Node cannot execute a .cmd shim directly on Windows; let the shell resolve it.
  shell: process.platform === 'win32',
});
