import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignmentConfig } from '../../src/core/contracts.ts';
import {
  type Submission,
  cleanupSubmission,
  discoverSubmissions,
  findProjectRoot,
  parseStudentId,
} from '../../src/core/intake.ts';
import { withTempDir } from '../helpers/tmp.ts';
import { makeZip } from '../helpers/zip.ts';

function makeConfig(over: Partial<AssignmentConfig> = {}): AssignmentConfig {
  return {
    name: 'test',
    max_points: 10,
    locale: 'en',
    build: { type: 'gcc' },
    project_root_marker: 'src/main.c',
    project_root_depth: 2,
    scoring: { use: 'proportional', rounding: 'none', cap: true },
    plugins: [],
    preset: 'none',
    limits: {
      build_timeout_sec: 120,
      run_timeout_sec: 10,
      output_limit_bytes: 1048576,
      unzip_max_bytes: 1024 * 1024,
      unzip_max_files: 100,
    },
    ...over,
  };
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
}

/** Runs the body and always removes every prepared workDir. */
async function withSubmissions(
  input: string,
  cfg: AssignmentConfig,
  fn: (subs: Submission[]) => Promise<void>,
): Promise<void> {
  const subs = await discoverSubmissions(input, cfg);
  try {
    await fn(subs);
  } finally {
    await Promise.all(subs.map(cleanupSubmission));
  }
}

describe('findProjectRoot', () => {
  it('returns the shallowest directory containing the marker', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'a/src/main.c': '', 'a/b/src/main.c': '' });
      expect(await findProjectRoot(dir, 'src/main.c', 3)).toBe(join(dir, 'a'));
    });
  });

  it('finds the marker in the directory itself (depth 0)', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'src/main.c': '' });
      expect(await findProjectRoot(dir, 'src/main.c', 0)).toBe(dir);
    });
  });

  it('does not look deeper than maxDepth', async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { 'a/b/c/src/main.c': '' });
      expect(await findProjectRoot(dir, 'src/main.c', 2)).toBeNull();
      expect(await findProjectRoot(dir, 'src/main.c', 3)).toBe(join(dir, 'a/b/c'));
    });
  });

  it('ignores __MACOSX and .git and does not follow symlinked directories', async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, 'outside');
      await writeFiles(outside, { 'src/main.c': '' });
      const sub = join(dir, 'sub');
      await writeFiles(sub, { '__MACOSX/src/main.c': '', '.git/src/main.c': '' });
      await symlink(outside, join(sub, 'link'));
      expect(await findProjectRoot(sub, 'src/main.c', 2)).toBeNull();
    });
  });
});

describe('parseStudentId', () => {
  const cfg = { pattern: '^(?<surname>[^_]+)_(?<name>[^_]+)_(?<login>[^_]+)_zapr1', strip_prefix: undefined };

  it('extracts named groups and uses login as id', () => {
    const r = parseStudentId('Novak_Jan_xnovak_zapr1.zip', cfg);
    expect(r.parts).toEqual({ surname: 'Novak', name: 'Jan', login: 'xnovak' });
    expect(r.id).toBe('xnovak');
    expect(r.displayName).toBe('Novak Jan');
  });

  it('keeps diacritics in the display name and transliterates the id', () => {
    const decomposed = 'Čech_Ján_xcech_zapr1.zip'; // NFD input
    const r = parseStudentId(decomposed, cfg);
    expect(r.displayName).toBe('Čech Ján');
    expect(r.parts.surname).toBe('Čech');
    expect(r.id).toBe('xcech');
  });

  it('falls back to the sanitized full name when the pattern does not match', () => {
    const r = parseStudentId('Ján Čech (final).zip', cfg);
    expect(r.id).toBe('Jan_Cech_final');
    expect(r.displayName).toBe('Ján Čech (final)');
    expect(r.parts).toEqual({});
  });

  it('uses the sanitized name when no student_id config exists', () => {
    expect(parseStudentId('alice', undefined).id).toBe('alice');
    expect(parseStudentId('Kováč Ľubomír.zip', undefined).id).toBe('Kovac_Lubomir');
  });

  it('strips the configured prefix before matching and for the fallback id', () => {
    const withPrefix = { strip_prefix: 'pevs-2026-' };
    expect(parseStudentId('pevs-2026-alice', withPrefix)).toMatchObject({ id: 'alice', displayName: 'alice' });
    const both = { pattern: '^(?<login>[a-z]+)$', strip_prefix: 'pevs-2026-' };
    expect(parseStudentId('pevs-2026-bob', both).parts.login).toBe('bob');
  });

  it('never yields an id with unsafe characters or a leading dot', () => {
    expect(parseStudentId('../../etc/passwd', undefined).id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(parseStudentId('..hidden', undefined).id.startsWith('.')).toBe(false);
    expect(parseStudentId('???', undefined).id).toBe('submission');
  });

  it('treats an invalid pattern as non-matching', () => {
    expect(parseStudentId('abc', { pattern: '(' }).id).toBe('abc');
    expect(parseStudentId('abc', { pattern: '(' }).matched).toBe(false);
  });

  it('reports whether a configured pattern matched (always true without one)', () => {
    expect(parseStudentId('Novak_Jan_xnovak_zapr1.zip', cfg).matched).toBe(true);
    expect(parseStudentId('Ján Čech (final).zip', cfg).matched).toBe(false);
    expect(parseStudentId('anything', undefined).matched).toBe(true);
    expect(parseStudentId('anything', { pattern: '' }).matched).toBe(true);
  });

  it('falls back from an empty id group to login, then to the name (|| not ??)', () => {
    const pattern = '^(?<id>[a-z]*)_(?<login>[a-z]*)_';
    expect(parseStudentId('_xlogin_rest', { pattern }).id).toBe('xlogin');
    expect(parseStudentId('__rest', { pattern }).id).toBe('rest'); // both groups empty: the sanitized name, not 'submission'
    expect(parseStudentId('abc_def_rest', { pattern }).id).toBe('abc');
  });

  it('never yields the reserved name summary.csv, in any case', () => {
    for (const name of ['summary.csv.zip', 'summary.csv', 'SUMMARY.CSV', 'Summary.Csv.zip']) {
      const id = parseStudentId(name, undefined).id;
      expect(id.toLowerCase()).not.toBe('summary.csv');
      expect(id).toMatch(/^summary\.csv_$/i);
    }
    expect(parseStudentId('summary.csv.bak', undefined).id).toBe('summary.csv.bak');
  });

  it('avoids Windows device names and trailing dots', () => {
    for (const name of ['CON', 'con.zip', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9.txt']) {
      expect(parseStudentId(name, undefined).id).toMatch(/_$/);
    }
    expect(parseStudentId('alice.', undefined).id).toBe('alice');
  });

  it('caps ids at 100 characters', () => {
    const long = 'a'.repeat(300);
    expect(parseStudentId(`${long}.zip`, undefined).id).toBe('a'.repeat(100));
    expect(`${parseStudentId(`${long}.zip`, undefined).id}-results.zip`.length).toBeLessThan(255);
    expect(parseStudentId('x'.repeat(98) + 'é'.repeat(10), undefined).id).toHaveLength(100);
  });
});

describe('discoverSubmissions', () => {
  it('uses a ZIP with an extra root folder: root is that folder', async () => {
    await withTempDir(async (dir) => {
      const zip = join(dir, 'Novak_Jan_xnovak_zapr1.zip');
      await writeFile(zip, await makeZip([{ name: 'project/src/main.c', content: 'int main(){}' }]));
      await withSubmissions(zip, makeConfig({ student_id: { pattern: '^(?<surname>[^_]+)_(?<name>[^_]+)_(?<login>[^_]+)' } }), async (subs) => {
        expect(subs).toHaveLength(1);
        const [s] = subs as [Submission];
        expect(s.kind).toBe('zip');
        expect(s.id).toBe('xnovak');
        expect(s.sourcePath).toBe(zip);
        expect(s.root).toBe(join(s.workDir, 'project'));
        expect(await readFile(join(s.root as string, 'src/main.c'), 'utf8')).toBe('int main(){}');
        expect(s.warnings).toEqual([]);
      });
    });
  });

  it('reports root null (with a warning) when the marker is deeper than project_root_depth', async () => {
    await withTempDir(async (dir) => {
      const zip = join(dir, 'deep.zip');
      await writeFile(zip, await makeZip([{ name: 'a/b/c/src/main.c', content: '' }]));
      await withSubmissions(zip, makeConfig(), async ([s]) => {
        expect(s?.root).toBeNull();
        expect(s?.warnings.join('\n')).toMatch(/src\/main\.c/);
      });
      await withSubmissions(zip, makeConfig({ project_root_depth: 3 }), async ([s]) => {
        expect(s?.root).not.toBeNull();
      });
    });
  });

  it('treats every child directory and ZIP of a container as a submission', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'submissions');
      await writeFiles(input, { 'alice/src/main.c': 'A', 'bob/src/main.c': 'B' });
      await writeFiles(input, { '.hidden/src/main.c': '', '__MACOSX/x': '', 'grading-results/r.json': '', 'notes.csv': '', 'readme.txt': '' });
      await writeFile(join(input, 'carol.zip'), await makeZip([{ name: 'src/main.c', content: 'C' }]));
      await withSubmissions(input, makeConfig(), async (subs) => {
        expect(subs.map((s) => [s.id, s.kind])).toEqual([
          ['alice', 'dir'],
          ['bob', 'dir'],
          ['carol', 'zip'],
        ]);
        for (const s of subs) {
          expect(s.root).toBe(s.workDir);
          expect(existsSync(join(s.workDir, 'src/main.c'))).toBe(true);
        }
        expect(await readFile(join(subs[0]?.workDir as string, 'src/main.c'), 'utf8')).toBe('A');
      });
    });
  });

  it('treats a directory that itself contains the marker as a single submission', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'alice-project');
      await writeFiles(input, { 'src/main.c': 'A', 'sub/other.txt': 'x' });
      await withSubmissions(input, makeConfig(), async (subs) => {
        expect(subs).toHaveLength(1);
        expect(subs[0]).toMatchObject({ id: 'alice-project', kind: 'dir', sourcePath: input });
        expect(subs[0]?.root).toBe(subs[0]?.workDir);
        expect(subs[0]?.workDir).not.toBe(input);
      });
    });
  });

  it('gives duplicate ids a numeric suffix and warns on every involved submission', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'in');
      await mkdir(input);
      const bytes = await makeZip([{ name: 'src/main.c', content: '' }]);
      await writeFile(join(input, 'Novak_Jan_xnovak_zapr1.zip'), bytes);
      await writeFile(join(input, 'Novak_Jan_xnovak_zapr1 (1).zip'), bytes);
      const cfg = makeConfig({ student_id: { pattern: '^(?<surname>[^_]+)_(?<name>[^_]+)_(?<login>[^_ ]+)' } });
      await withSubmissions(input, cfg, async (subs) => {
        expect(subs.map((s) => s.id)).toEqual(['xnovak', 'xnovak-2']);
        expect(subs[0]?.warnings.join('\n')).toMatch(/xnovak/);
        expect(subs[1]?.warnings.join('\n')).toMatch(/xnovak-2/);
      });
    });
  });

  it('does not throw for a broken ZIP: root null and a warning', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'in');
      await mkdir(input);
      await writeFile(join(input, 'broken.zip'), 'not a zip');
      await writeFile(join(input, 'good.zip'), await makeZip([{ name: 'src/main.c', content: '' }]));
      await withSubmissions(input, makeConfig(), async (subs) => {
        expect(subs.map((s) => s.id)).toEqual(['broken', 'good']);
        expect(subs[0]?.root).toBeNull();
        expect(subs[0]?.warnings[0]).toMatch(/ZIP/i);
        expect(subs[1]?.root).not.toBeNull();
      });
    });
  });

  it('turns an over-limit ZIP into a submission with root null', async () => {
    await withTempDir(async (dir) => {
      const zip = join(dir, 'bomb.zip');
      await writeFile(zip, await makeZip([{ name: 'src/main.c', content: new Uint8Array(2 * 1024 * 1024) }]));
      await withSubmissions(zip, makeConfig(), async ([s]) => {
        expect(s?.root).toBeNull();
        expect(s?.warnings.join('\n')).toMatch(/maxBytes/);
      });
    });
  });

  it('records skipped ZIP entries as warnings', async () => {
    await withTempDir(async (dir) => {
      const zip = join(dir, 'evil.zip');
      await writeFile(
        zip,
        await makeZip([
          { name: 'src/main.c', content: '' },
          { name: '../evil.txt', content: 'x' },
          { name: 'link', content: '/etc/passwd', mode: 0o120777 },
        ]),
      );
      await withSubmissions(zip, makeConfig(), async ([s]) => {
        expect(s?.root).not.toBeNull();
        expect(s?.warnings.join('\n')).toMatch(/\.\.\/evil\.txt/);
        expect(s?.warnings.join('\n')).toMatch(/link/);
        expect(existsSync(join(s?.workDir as string, 'link'))).toBe(false);
      });
    });
  });

  it('does not copy symlinks from directory submissions and warns about each', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'alice');
      await writeFiles(input, { 'src/main.c': 'A' });
      await writeFile(join(dir, 'secret.txt'), 'secret');
      await symlink(join(dir, 'secret.txt'), join(input, 'src', 'leak.txt'));
      await symlink(dir, join(input, 'up'));
      await withSubmissions(input, makeConfig(), async ([s]) => {
        expect(s?.root).toBe(s?.workDir);
        expect(existsSync(join(s?.workDir as string, 'src/main.c'))).toBe(true);
        expect(existsSync(join(s?.workDir as string, 'src/leak.txt'))).toBe(false);
        expect(existsSync(join(s?.workDir as string, 'up'))).toBe(false);
        expect(s?.warnings.filter((w) => /symlink/i.test(w))).toHaveLength(2);
        expect(s?.warnings.join('\n')).toMatch(/src\/leak\.txt/);
      });
    });
  });

  it('skips symlinked children of a container directory', async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, 'outside');
      await writeFiles(outside, { 'src/main.c': 'X' });
      const input = join(dir, 'in');
      await writeFiles(input, { 'alice/src/main.c': 'A' });
      await symlink(outside, join(input, 'mallory'));
      await withSubmissions(input, makeConfig(), async (subs) => {
        expect(subs.map((s) => s.id)).toEqual(['alice']);
      });
    });
  });

  it('rejects a missing input path and a non-ZIP file', async () => {
    await withTempDir(async (dir) => {
      await expect(discoverSubmissions(join(dir, 'nope'), makeConfig())).rejects.toThrow(/nope/);
      await writeFile(join(dir, 'file.txt'), 'x');
      await expect(discoverSubmissions(join(dir, 'file.txt'), makeConfig())).rejects.toThrow(/file\.txt/);
    });
  });
});

describe('submission names chosen by students', () => {
  it('cannot claim the reporter output name summary.csv (a ZIP called summary.csv.zip)', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'in');
      await mkdir(input);
      await writeFile(join(input, 'summary.csv.zip'), await makeZip([{ name: 'src/main.c', content: '' }]));
      await withSubmissions(input, makeConfig(), async (subs) => {
        expect(subs.map((s) => s.id)).toEqual(['summary.csv_']);
      });
    });
  });

  it('keeps ids unique after truncation and after reserved-name handling', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'in');
      await writeFiles(input, {
        [`${'n'.repeat(150)}-one/src/main.c`]: '',
        [`${'n'.repeat(150)}-two/src/main.c`]: '',
        'summary.csv_/src/main.c': '',
      });
      await writeFile(join(input, 'summary.csv.zip'), await makeZip([{ name: 'src/main.c', content: '' }]));
      await withSubmissions(input, makeConfig(), async (subs) => {
        const ids = subs.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.length <= 102 && id.toLowerCase() !== 'summary.csv')).toBe(true);
        expect(ids.filter((id) => id.startsWith('n'))).toHaveLength(2);
        expect(subs.filter((s) => s.id.startsWith('n')).every((s) => s.warnings.some((w) => w.includes('duplicate student id')))).toBe(true);
        expect(ids.filter((id) => id.startsWith('summary.csv_'))).toHaveLength(2);
      });
    });
  });

  it('warns when a configured student_id pattern does not match the name', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'in');
      await writeFiles(input, { 'alice/src/main.c': '', 'Novak_Jan_xnovak/src/main.c': '' });
      const cfg = makeConfig({ student_id: { pattern: '^(?<surname>[^_]+)_(?<name>[^_]+)_(?<login>[^_]+)' } });
      await withSubmissions(input, cfg, async (subs) => {
        const byName = new Map(subs.map((s) => [s.id, s]));
        expect(byName.get('alice')?.warnings).toEqual(['student id pattern did not match "alice"']);
        expect(byName.get('xnovak')?.warnings).toEqual([]);
      });
      // no pattern configured: nothing to match
      await withSubmissions(input, makeConfig(), async (subs) => {
        expect(subs.flatMap((s) => s.warnings)).toEqual([]);
      });
    });
  });

  it('never carries control characters of entry or file names into warnings', async () => {
    await withTempDir(async (dir) => {
      const zip = join(dir, 'a.zip');
      await writeFile(zip, await makeZip([{ name: 'src/main.c', content: '' }, { name: '../\u001b[31mevil\u0007.txt', content: 'x' }]));
      await withSubmissions(zip, makeConfig(), async ([s]) => {
        const text = s?.warnings.join('\n') ?? '';
        expect(text).toContain('skipped unsafe ZIP entry: ../?[31mevil?.txt');
        expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      });

      const input = join(dir, 'proj');
      await writeFiles(input, { 'src/main.c': '' });
      await symlink('/etc/hostname', join(input, 'bad\u001b[2Jlink'));
      await withSubmissions(input, makeConfig(), async ([s]) => {
        expect(s?.warnings).toEqual(['skipped symlink: bad?[2Jlink']);
      });
    });
  });
});

describe('cleanupSubmission', () => {
  it('removes the work directory and tolerates being called twice', async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, 'alice');
      await writeFiles(input, { 'src/main.c': 'A' });
      const [s] = await discoverSubmissions(input, makeConfig());
      expect(existsSync((s as Submission).workDir)).toBe(true);
      await cleanupSubmission(s as Submission);
      expect(existsSync((s as Submission).workDir)).toBe(false);
      await cleanupSubmission(s as Submission);
    });
  });
});
