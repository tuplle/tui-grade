// The package version, read from the manifest next to `src/` or `dist/`.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION: string = pkg.version;
