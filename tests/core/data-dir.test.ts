import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataBaseDir, defaultDataDir } from '../../src/core/data-dir.ts';

describe('dataBaseDir', () => {
  const home = '/home/teacher';

  it('uses XDG_DATA_HOME on Linux when it is absolute', () => {
    expect(dataBaseDir('linux', { XDG_DATA_HOME: '/tmp/xdg-data' }, home)).toBe('/tmp/xdg-data');
  });

  it('falls back to ~/.local/share on Linux', () => {
    expect(dataBaseDir('linux', {}, home)).toBe('/home/teacher/.local/share');
  });

  it('uses Application Support on macOS', () => {
    expect(dataBaseDir('darwin', {}, '/Users/teacher')).toBe('/Users/teacher/Library/Application Support');
  });

  it('uses LOCALAPPDATA or APPDATA on Windows', () => {
    expect(dataBaseDir('win32', { LOCALAPPDATA: 'C:\\Users\\teacher\\AppData\\Local' }, 'C:\\Users\\teacher')).toBe(
      'C:\\Users\\teacher\\AppData\\Local',
    );
    expect(dataBaseDir('win32', { APPDATA: 'C:\\Users\\teacher\\AppData\\Roaming' }, 'C:\\Users\\teacher')).toBe(
      'C:\\Users\\teacher\\AppData\\Roaming',
    );
    expect(dataBaseDir('win32', {}, 'C:\\Users\\teacher')).toBe('C:\\Users\\teacher\\AppData\\Local');
  });
});

describe('defaultDataDir', () => {
  it('returns a tui-grade child directory of the platform data directory', () => {
    expect(defaultDataDir()).toBe(join(dataBaseDir(process.platform, process.env, homedir()), 'tui-grade'));
  });

  it('expands ~ in TUI_GRADE_DATA_DIR', () => {
    const previous = process.env['TUI_GRADE_DATA_DIR'];
    process.env['TUI_GRADE_DATA_DIR'] = '~/runs';
    try {
      expect(defaultDataDir()).toBe(join(homedir(), 'runs'));
    } finally {
      if (previous === undefined) delete process.env['TUI_GRADE_DATA_DIR'];
      else process.env['TUI_GRADE_DATA_DIR'] = previous;
    }
  });
});
