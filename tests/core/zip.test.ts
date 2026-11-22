import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipError, extractZipSafe } from '../../src/core/zip.ts';
import { withTempDir } from '../helpers/tmp.ts';
import { makeZip } from '../helpers/zip.ts';

const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 100 };

/** Writes the archive to `<dir>/<name>` and returns that path. */
async function writeZip(dir: string, name: string, data: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe('extractZipSafe', () => {
  it('extracts a normal ZIP', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(
        dir,
        'a.zip',
        await makeZip([
          { name: 'src/main.c', content: 'int main(void){}' },
          { name: 'README.md', content: 'hello' },
        ]),
      );
      const dest = join(dir, 'dest');
      const res = await extractZipSafe(zip, dest, LIMITS);
      expect(res).toEqual({ files: 2, bytes: 16 + 5, skipped: [] });
      expect(await readFile(join(dest, 'src/main.c'), 'utf8')).toBe('int main(void){}');
      expect(await readFile(join(dest, 'README.md'), 'utf8')).toBe('hello');
    });
  });

  it('never writes entries that escape the destination and reports them as skipped', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(
        dir,
        'evil.zip',
        await makeZip([
          { name: '../evil.txt', content: 'x' },
          { name: '/abs.txt', content: 'x' },
          { name: 'a/../../deep.txt', content: 'x' },
          { name: '..\\win.txt', content: 'x' },
          { name: 'ok.txt', content: 'fine' },
        ]),
      );
      const dest = join(dir, 'dest');
      const res = await extractZipSafe(zip, dest, LIMITS);
      expect(res.files).toBe(1);
      expect(res.skipped.sort()).toEqual(['..\\win.txt', '../evil.txt', '/abs.txt', 'a/../../deep.txt'].sort());
      expect(await readdir(dest)).toEqual(['ok.txt']);
      for (const f of ['evil.txt', 'abs.txt', 'deep.txt', 'win.txt']) {
        expect(existsSync(join(dir, f))).toBe(false);
        expect(existsSync(join(dest, f))).toBe(false);
      }
      expect(existsSync('/abs.txt')).toBe(false);
    });
  });

  it('skips symlink entries', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(
        dir,
        'link.zip',
        await makeZip([
          { name: 'link', content: '/etc/passwd', mode: 0o120777 },
          { name: 'real.txt', content: 'r', mode: 0o100644 },
        ]),
      );
      const dest = join(dir, 'dest');
      const res = await extractZipSafe(zip, dest, LIMITS);
      expect(res.skipped).toEqual(['link']);
      expect(await readdir(dest)).toEqual(['real.txt']);
    });
  });

  it('rejects a declared size above maxBytes before extracting anything', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(
        dir,
        'bomb.zip',
        await makeZip([
          { name: 'a.txt', content: 'small' },
          { name: 'zeros.bin', content: new Uint8Array(10 * 1024 * 1024) },
        ]),
      );
      const dest = join(dir, 'dest');
      await expect(extractZipSafe(zip, dest, LIMITS)).rejects.toThrow(ZipError);
      expect(existsSync(join(dest, 'a.txt'))).toBe(false);
      expect(existsSync(join(dest, 'zeros.bin'))).toBe(false);
    });
  });

  it('stops inflating an entry whose header lies about its size', async () => {
    await withTempDir(async (dir) => {
      const data = await makeZip([{ name: 'zeros.bin', content: new Uint8Array(10 * 1024 * 1024) }]);
      // Patch the uncompressed size to 100 bytes in the local and the central header.
      data.writeUInt32LE(100, data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) + 22);
      data.writeUInt32LE(100, data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
      const zip = await writeZip(dir, 'lying.zip', data);
      const dest = join(dir, 'dest');
      await expect(extractZipSafe(zip, dest, LIMITS)).rejects.toThrow(/maxBytes/);
      const written = existsSync(join(dest, 'zeros.bin')) ? (await stat(join(dest, 'zeros.bin'))).size : 0;
      expect(written).toBeLessThanOrEqual(LIMITS.maxBytes);
    });
  });

  it('rejects more files than maxFiles', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(
        dir,
        'many.zip',
        await makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' }))),
      );
      const dest = join(dir, 'dest');
      await expect(extractZipSafe(zip, dest, { ...LIMITS, maxFiles: 4 })).rejects.toThrow(/maxFiles/);
      expect(existsSync(join(dest, 'f0.txt'))).toBe(false);
    });
  });

  it('throws ZipError for a corrupt archive', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(dir, 'bad.zip', Buffer.from('this is definitely not a zip file'));
      await expect(extractZipSafe(zip, join(dir, 'dest'), LIMITS)).rejects.toThrow(ZipError);
    });
  });

  it('throws ZipError for a truncated archive', async () => {
    await withTempDir(async (dir) => {
      const full = await makeZip([{ name: 'a.txt', content: 'abc' }]);
      const zip = await writeZip(dir, 'cut.zip', full.subarray(0, full.length - 10));
      await expect(extractZipSafe(zip, join(dir, 'dest'), LIMITS)).rejects.toThrow(ZipError);
    });
  });

  it('ignores __MACOSX and .git entries', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(
        dir,
        'mac.zip',
        await makeZip([
          { name: '__MACOSX/._main.c', content: 'junk' },
          { name: 'proj/.git/config', content: 'junk' },
          { name: 'proj/main.c', content: 'code' },
        ]),
      );
      const dest = join(dir, 'dest');
      const res = await extractZipSafe(zip, dest, LIMITS);
      expect(res.files).toBe(1);
      expect(existsSync(join(dest, '__MACOSX'))).toBe(false);
      expect(existsSync(join(dest, 'proj/.git'))).toBe(false);
      expect(await readFile(join(dest, 'proj/main.c'), 'utf8')).toBe('code');
    });
  });

  it('works with diacritics in the archive file name', async () => {
    await withTempDir(async (dir) => {
      const zip = await writeZip(dir, 'Čech_Ján_xcech_project1.zip', await makeZip([{ name: 'a.txt', content: 'a' }]));
      const res = await extractZipSafe(zip, join(dir, 'dest'), LIMITS);
      expect(res.files).toBe(1);
    });
  });
});
