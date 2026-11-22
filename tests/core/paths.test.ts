import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome, resolveUserPath } from '../../src/core/paths.ts';

const home = join(homedir(), 'tui-grade-test-home');
const cwd = join(homedir(), 'tui-grade-test-cwd');

describe('expandHome', () => {
  it('expands ~, ~/... and ~\\...', () => {
    expect(expandHome('~', home)).toBe(home);
    expect(expandHome('~/runs', home)).toBe(join(home, 'runs'));
    expect(expandHome('~\\runs', home)).toBe(join(home, 'runs'));
  });

  it('leaves every other path unchanged', () => {
    const absolute = join(home, 'runs');
    expect(expandHome(absolute, home)).toBe(absolute);
    expect(expandHome('runs', home)).toBe('runs');
    expect(expandHome('~someone/runs', home)).toBe('~someone/runs');
  });
});

describe('resolveUserPath', () => {
  it('resolves a relative path against cwd', () => {
    expect(resolveUserPath('runs', cwd, home)).toBe(resolve(cwd, 'runs'));
  });

  it('expands the home directory before resolving', () => {
    expect(resolveUserPath('~/runs', cwd, home)).toBe(join(home, 'runs'));
    expect(resolveUserPath('~', cwd, home)).toBe(home);
  });
});
