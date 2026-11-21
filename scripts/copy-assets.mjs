import { chmod, cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = join(root, 'src', 'locales');
const to = join(root, 'dist', 'locales');

await mkdir(to, { recursive: true });
for (const name of await readdir(from)) {
  if (name.endsWith('.json')) await cp(join(from, name), join(to, name));
}

// npm links `bin` entries as they are on POSIX; Windows uses a generated .cmd shim.
if (process.platform !== 'win32') await chmod(join(root, 'dist', 'cli', 'main.js'), 0o755);
