// Default location for generated run data, using each platform's conventional application-data directory.
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { expandHome } from './paths.ts';

export function dataBaseDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  const join = platform === 'win32' ? win32.join : posix.join;
  const isAbsolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    if (local !== undefined && local !== '' && isAbsolute(local)) return local;
    const roaming = env['APPDATA'];
    if (roaming !== undefined && roaming !== '' && isAbsolute(roaming)) return roaming;
    return join(home, 'AppData', 'Local');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  const xdg = env['XDG_DATA_HOME'];
  return xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
}

export function defaultDataDir(): string {
  const override = process.env['TUI_GRADE_DATA_DIR'];
  if (override !== undefined && override !== '') return expandHome(override);
  return (process.platform === 'win32' ? win32 : posix).join(dataBaseDir(process.platform, process.env, homedir()), 'tui-grade');
}
