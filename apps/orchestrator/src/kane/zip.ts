// Minimal, strict ZIP reader for Kane evidence packs (built-in zlib only).
//
// Safety rules:
//  - archive size, entry count, per-entry and total uncompressed size limits
//  - only "stored" (0) and "deflate" (8) entries; no encryption, no ZIP64
//  - entry names must be relative, without "..", backslashes, drive letters,
//    NUL or absolute paths, and must match an allow-list of known Kane paths
//  - entries are only ever read into memory by name; nothing is written to
//    disk using a path taken from the archive
//  - inflated size must equal the declared size (zip-bomb protection)

import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = {
  maxArchiveBytes: 50 * 1024 * 1024,
  maxEntries: 500,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxNameLength: 200,
};

/** Paths Kane 0.10.5 puts in a sealed evidence pack. Anything else is rejected. */
const ALLOWED_PATHS: RegExp[] = [
  /^run\.yaml$/,
  /^failure\.yaml$/,
  /^coverage\/\.keep$/,
  /^meta\/[a-z0-9._-]+\.yaml$/,
  /^tests\/[a-z0-9-]+\/(?:result\.yaml|test\.md)$/,
  /^tests\/[a-z0-9-]+\/auteur\/execution\.json$/,
  /^tests\/[a-z0-9-]+\/logs\/[a-z0-9._-]+$/i,
  /^tests\/[a-z0-9-]+\/steps\/[0-9]+-[0-9]+-[0-9]+\/(?:screenshot\.jpg|annotated\.png|step\.json|failure\.yaml)$/,
  /^tests\/[a-z0-9-]+\/v16-trajectory\/[a-z0-9._-]+$/i,
];

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export interface ZipIndex {
  entries: Map<string, ZipEntry>;
  /** Entries that were present but rejected (name only, for diagnostics). */
  rejected: string[];
}

export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > ZIP_LIMITS.maxNameLength) return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  if (name.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return true;
}

export function isAllowedEntryName(name: string): boolean {
  return isSafeEntryName(name) && ALLOWED_PATHS.some((re) => re.test(name));
}

export function readIndex(buf: Buffer): ZipIndex {
  if (buf.length > ZIP_LIMITS.maxArchiveBytes) throw new ZipError('Evidence pack is too large.');
  if (buf.length < 22) throw new ZipError('Not a ZIP archive.');
  // End of central directory: search the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipError('Not a ZIP archive (no end-of-directory record).');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (total > ZIP_LIMITS.maxEntries) throw new ZipError(`Too many entries in evidence pack (${total}).`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('Corrupt central directory.');

  const entries = new Map<string, ZipEntry>();
  const rejected: string[] = [];
  let totalSize = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('Corrupt central directory entry.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (flags & 0x1) throw new ZipError('Encrypted entries are not supported.');
    if (!isAllowedEntryName(name)) {
      rejected.push(name.slice(0, 120));
      continue;
    }
    if (method !== 0 && method !== 8) {
      rejected.push(name);
      continue;
    }
    if (size > ZIP_LIMITS.maxEntryBytes || compressedSize > ZIP_LIMITS.maxEntryBytes) {
      rejected.push(name);
      continue;
    }
    totalSize += size;
    if (totalSize > ZIP_LIMITS.maxTotalBytes) throw new ZipError('Evidence pack expands beyond the size limit.');
    if (entries.has(name)) throw new ZipError(`Duplicate entry name: ${name}`);
    entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
  }
  return { entries, rejected };
}

export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) throw new ZipError(`Corrupt local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new ZipError(`Entry data out of range for ${entry.name}`);
  const raw = buf.subarray(start, end);
  const data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: ZIP_LIMITS.maxEntryBytes });
  if (data.length !== entry.size) throw new ZipError(`Size mismatch for ${entry.name}`);
  return data;
}

export function isJpeg(b: Buffer): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function isPng(b: Buffer): boolean {
  return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
