import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PathEscapeError,
  copyDir,
  createTempDir,
  isAtomicTempName,
  liveTempDirList,
  normalizeText,
  removeAllTempDirs,
  removeDir,
  removePendingAtomicTemps,
  safeJoin,
  unregisterTempDir,
  writeFileAtomic,
} from '../../src/core/workspace.ts';
import { withTempDir } from '../helpers/tmp.ts';

describe('safeJoin', () => {
  const root = '/tmp/root';

  it('accepts nested relative paths', () => {
    expect(safeJoin(root, 'a/b')).toBe(resolve(root, 'a/b'));
    expect(safeJoin(root, 'a/../b')).toBe(resolve(root, 'b'));
  });

  it.each(['../x', '/etc/passwd', 'a/../../b', '..'])('rejects %s', (rel) => {
    expect(() => safeJoin(root, rel)).toThrow(PathEscapeError);
  });

  it('rejects sibling directories sharing the root prefix', () => {
    expect(() => safeJoin(root, '../root2/x')).toThrow(PathEscapeError);
  });
});

describe('safeJoin and symlinks', () => {
  /** Creates `<dir>/root` and `<dir>/outside`, runs the body, cleans up. */
  const withRoots = (fn: (root: string, outside: string) => Promise<void>): Promise<void> =>
    withTempDir(async (dir) => {
      const root = join(dir, 'root');
      const outside = join(dir, 'outside');
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, 'file'), 'secret');
      await fn(root, outside);
    });

  it('rejects a path through a symlink that points outside the root', async () => {
    await withRoots(async (root, outside) => {
      await symlink(outside, join(root, 'link'));
      expect(() => safeJoin(root, 'link/file')).toThrow(PathEscapeError);
      expect(() => safeJoin(root, 'link')).toThrow(PathEscapeError);
      expect(() => safeJoin(root, 'link/not/yet/there')).toThrow(PathEscapeError);
    });
  });

  it('rejects a symlink that points to a file outside the root', async () => {
    await withRoots(async (root, outside) => {
      await symlink(join(outside, 'file'), join(root, 'flink'));
      expect(() => safeJoin(root, 'flink')).toThrow(PathEscapeError);
    });
  });

  it('rejects a dangling symlink', async () => {
    await withRoots(async (root, outside) => {
      await symlink(join(outside, 'missing'), join(root, 'dangling'));
      expect(() => safeJoin(root, 'dangling')).toThrow(PathEscapeError);
      expect(() => safeJoin(root, 'dangling/sub')).toThrow(PathEscapeError);
    });
  });

  it('accepts a symlink that points inside the root', async () => {
    await withRoots(async (root) => {
      await mkdir(join(root, 'real'));
      await writeFile(join(root, 'real', 'f.txt'), 'x');
      await symlink(join(root, 'real'), join(root, 'alias'));
      expect(safeJoin(root, 'alias/f.txt')).toBe(join(root, 'alias', 'f.txt'));
    });
  });

  it('accepts a not-yet-existing nested path under a real directory', async () => {
    await withRoots(async (root) => {
      await mkdir(join(root, 'real'));
      expect(safeJoin(root, 'real/new/deep/file.txt')).toBe(join(root, 'real', 'new', 'deep', 'file.txt'));
      expect(safeJoin(root, 'brand/new')).toBe(join(root, 'brand', 'new'));
    });
  });

  it('accepts paths when the root itself is reached through a symlink', async () => {
    await withRoots(async (root) => {
      const viaLink = `${root}-link`;
      await symlink(root, viaLink);
      await mkdir(join(root, 'sub'));
      expect(safeJoin(viaLink, 'sub/x')).toBe(join(viaLink, 'sub', 'x'));
    });
  });
});

describe('normalizeText', () => {
  it('normalizes line endings and strips ANSI sequences', () => {
    expect(normalizeText('a\r\nb\u001b[31mR\u001b[0m')).toBe('a\nbR');
  });

  it('turns lone CR into LF', () => {
    expect(normalizeText('a\rb')).toBe('a\nb');
  });
});

describe('temp dirs', () => {
  it('createTempDir creates a unique directory with the prefix, removeDir deletes it', async () => {
    const a = await createTempDir('tui-grade-ws-');
    const b = await createTempDir('tui-grade-ws-');
    try {
      expect(a).not.toBe(b);
      expect(a.startsWith(join(tmpdir(), 'tui-grade-ws-'))).toBe(true);
      expect((await stat(a)).isDirectory()).toBe(true);
    } finally {
      await removeDir(a);
      await removeDir(b);
    }
    await expect(stat(a)).rejects.toThrow();
  });

  it('removeDir tolerates a missing directory', async () => {
    await withTempDir(async (dir) => {
      await expect(removeDir(join(dir, 'nope'))).resolves.toBeUndefined();
    });
  });

  it('copyDir copies files recursively', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'src');
      await mkdir(join(src, 'sub'), { recursive: true });
      await writeFile(join(src, 'a.txt'), 'A');
      await writeFile(join(src, 'sub', 'b.txt'), 'B');
      const dest = join(dir, 'dest');
      await copyDir(src, dest);
      expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('A');
      expect(await readFile(join(dest, 'sub', 'b.txt'), 'utf8')).toBe('B');
    });
  });

  it('copyDir skips entries rejected by the filter', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'src');
      await mkdir(src);
      await writeFile(join(src, 'keep.txt'), 'K');
      await writeFile(join(src, 'secret.txt'), 'S');
      await symlink('keep.txt', join(src, 'link'));
      const seen: string[] = [];
      const dest = join(dir, 'dest');
      await copyDir(src, dest, {
        filter: (path, stats) => {
          seen.push(path);
          return !stats.isSymbolicLink() && !path.endsWith('secret.txt');
        },
      });
      expect(await readdir(dest)).toEqual(['keep.txt']);
      expect(seen).toEqual(expect.arrayContaining([join(src, 'link'), join(src, 'secret.txt')]));
    });
  });
});

const itNotRoot = process.getuid?.() === 0 ? it.skip : it;

describe('removeDir', () => {
  itNotRoot('removes a tree with read-only directories, without following symlinks out of it', async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, 'outside');
      await mkdir(outside);
      await chmod(outside, 0o500); // must stay untouched: only a link to it is inside the tree
      const tree = join(dir, 'tree');
      await mkdir(join(tree, 'a', 'b'), { recursive: true });
      await mkdir(join(tree, 'closed'));
      await writeFile(join(tree, 'a', 'b', 'x'), 'x');
      await writeFile(join(tree, 'a', 'f'), 'f');
      await symlink(outside, join(tree, 'link'));
      await chmod(join(tree, 'a', 'b'), 0o500);
      await chmod(join(tree, 'a'), 0o500);
      await chmod(join(tree, 'closed'), 0o000);
      try {
        await removeDir(tree);
        expect(existsSync(tree)).toBe(false);
        expect((await stat(outside)).mode & 0o777).toBe(0o500);
      } finally {
        await chmod(outside, 0o700);
      }
    });
  });

  it('still reports a failure that is not about permissions of the tree itself', async () => {
    if (process.getuid?.() === 0) return;
    await withTempDir(async (dir) => {
      const parent = join(dir, 'parent');
      const tree = join(parent, 'tree');
      await mkdir(tree, { recursive: true });
      await chmod(parent, 0o500); // `tree` cannot be unlinked from its parent
      try {
        await expect(removeDir(tree)).rejects.toThrow();
      } finally {
        await chmod(parent, 0o700);
      }
    });
  });
});

describe('temp dir registry', () => {
  it('registers created directories until they are removed or released', async () => {
    const a = await createTempDir('tui-grade-reg-');
    const b = await createTempDir('tui-grade-reg-');
    const c = await createTempDir('tui-grade-reg-');
    try {
      expect(liveTempDirList()).toEqual(expect.arrayContaining([a, b, c]));
      await removeDir(a);
      expect(liveTempDirList()).not.toContain(a);
      unregisterTempDir(c); // meant to survive
      expect(liveTempDirList()).not.toContain(c);
      await removeAllTempDirs();
      expect(existsSync(b)).toBe(false);
      expect(liveTempDirList()).not.toContain(b);
      expect(existsSync(c)).toBe(true);
    } finally {
      await removeDir(a);
      await removeDir(b);
      await removeDir(c);
    }
  });
});

describe('isAtomicTempName', () => {
  it('matches the temp names of writeFileAtomic and nothing else', async () => {
    expect(isAtomicTempName('.results.json.1234.abcd.tmp')).toBe(true);
    expect(isAtomicTempName('.a.b.c.99.0123abcd.tmp')).toBe(true);
    for (const name of ['results.json', 'x.tmp', '.hidden', '.results.json.tmp', 'results.json.1234.abcd.tmp']) expect(isAtomicTempName(name)).toBe(false);
    await withTempDir(async (dir) => {
      await writeFileAtomic(join(dir, 'f.txt'), 'x'); // a finished write leaves nothing that looks like a temp file
      expect((await readdir(dir)).filter(isAtomicTempName)).toEqual([]);
    });
  });
});

describe('writeFileAtomic', () => {
  it('writes text and bytes, replacing an existing file, and leaves no temp file', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'out.json');
      await writeFileAtomic(file, 'first');
      await writeFileAtomic(file, 'second');
      expect(await readFile(file, 'utf8')).toBe('second');
      await writeFileAtomic(join(dir, 'bin'), new Uint8Array([0, 255, 7]));
      expect([...(await readFile(join(dir, 'bin')))]).toEqual([0, 255, 7]);
      expect((await readdir(dir)).sort()).toEqual(['bin', 'out.json']);
    });
  });

  it('shows no partial file when the final step fails: the target is untouched and the temp name is removed', async () => {
    await withTempDir(async (dir) => {
      // A directory in the way makes the rename fail after the data has been written to the temp name.
      const target = join(dir, 'results.json');
      await mkdir(target);
      await writeFile(join(target, 'keep'), 'x');
      await expect(writeFileAtomic(target, 'complete content')).rejects.toThrow();
      expect(await readdir(dir)).toEqual(['results.json']); // no `.results.json.*.tmp`
      expect(await readdir(target)).toEqual(['keep']);
    });
  });

  it('fails without a trace when the directory does not exist', async () => {
    await withTempDir(async (dir) => {
      await expect(writeFileAtomic(join(dir, 'missing', 'f.txt'), 'x')).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it('removePendingAtomicTemps (the exit handler) leaves neither a temp file nor a truncated target', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'f.txt');
      await writeFile(file, 'old');
      const pending = writeFileAtomic(file, 'new');
      removePendingAtomicTemps(); // what the exit handler does: the half-done write leaves nothing behind
      await pending.catch(() => {});
      const names = await readdir(dir);
      expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(['old', 'new']).toContain(await readFile(file, 'utf8')); // never empty or truncated
    });
  });
});
