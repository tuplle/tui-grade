import JSZip from 'jszip';

export interface ZipEntrySpec {
  /** Entry name exactly as it will be stored (may be hostile, e.g. `../evil.txt`). */
  name: string;
  content?: string | Uint8Array;
  /** Unix mode stored in the external attributes, e.g. `0o120777` for a symlink. */
  mode?: number;
}

/** Builds a ZIP archive in memory from the given entries. */
export async function makeZip(entries: ZipEntrySpec[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const e of entries) {
    zip.file(e.name, e.content ?? '', {
      createFolders: false,
      ...(e.mode !== undefined && { unixPermissions: e.mode }),
    });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
  });
}
