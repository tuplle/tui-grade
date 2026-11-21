// Cross-platform removal of generated build and release artifacts.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['dist', 'bundle', '_site']) await rm(join(root, name), { recursive: true, force: true });

for (const name of await readdir(root).catch(() => [])) {
  if (/^tui-grade-.*\.(?:tgz|tar\.gz)$/.test(name)) await rm(join(root, name), { force: true });
}
