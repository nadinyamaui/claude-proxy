import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimal zip support with no dependencies: enough to unpack an uploaded
 * working directory and pack one back up. Handles stored and deflated
 * entries. Does not handle zip64 (archives or entries over 4 GB, or more than
 * 65535 entries), encryption, or other compression methods.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export type ZipEntry = {
  /** Normalized, forward-slash relative path. Directories end with "/". */
  name: string;
  isDir: boolean;
  method: number;
  size: number;
  compressedSize: number;
  /** Offset of the local file header. */
  offset: number;
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_SYMLINK = 0xa000;
const UNIX_DIR = 0x4000;

/**
 * Rejects anything that could escape the extraction root: absolute paths,
 * drive letters, `..` segments, NUL bytes. Backslashes are treated as
 * separators because some Windows tools write them despite the spec.
 */
function safeName(raw: string): string {
  if (raw.includes("\0")) throw new ZipError("entry name contains a NUL byte");
  const slashed = raw.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw new ZipError(`entry ${JSON.stringify(raw)} has an absolute path`);
  }
  const isDir = slashed.endsWith("/");
  const segments = slashed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw new ZipError(`entry ${JSON.stringify(raw)} escapes the archive root`);
  if (segments.length === 0) throw new ZipError("entry has an empty name");
  return segments.join("/") + (isDir ? "/" : "");
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError("not a zip file (no end-of-central-directory record)");
}

/** Parses the central directory. Skips macOS resource-fork junk. */
export function readEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("not a zip file (too small)");
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("zip64 archives are not supported");
  }
  if (cdOffset + cdSize > eocd) throw new ZipError("central directory is out of bounds");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError("corrupt central directory");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & FLAG_UTF8 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.startsWith("__MACOSX/") || rawName === "__MACOSX") continue;
    const name = safeName(rawName);
    if (flags & FLAG_ENCRYPTED) throw new ZipError(`entry ${name} is encrypted`);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(`entry ${name} uses unsupported compression method ${method}`);
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ZipError(`entry ${name} needs zip64, which is not supported`);
    }
    const unixType = (externalAttrs >>> 16) & UNIX_TYPE_MASK;
    if (unixType === UNIX_SYMLINK) throw new ZipError(`entry ${name} is a symlink, which is not allowed`);
    const isDir = name.endsWith("/") || unixType === UNIX_DIR;

    entries.push({
      name: isDir && !name.endsWith("/") ? `${name}/` : name,
      isDir,
      method,
      size,
      compressedSize,
      offset,
    });
  }
  return entries;
}

export type ExtractOptions = {
  /** Cap on the total uncompressed size, as a defence against zip bombs. */
  maxBytes: number;
};

export type ExtractResult = { files: number; bytes: number };

/** Validates the archive without writing anything. Throws ZipError. */
export function inspectZip(buf: Buffer, opts: ExtractOptions): ZipEntry[] {
  const entries = readEntries(buf);
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (total > opts.maxBytes) {
      throw new ZipError(`archive expands to more than ${opts.maxBytes} bytes`);
    }
  }
  return entries;
}

function entryData(buf: Buffer, e: ZipEntry): Buffer {
  const h = e.offset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== SIG_LOCAL) {
    throw new ZipError(`entry ${e.name} has a corrupt local header`);
  }
  const nameLen = buf.readUInt16LE(h + 26);
  const extraLen = buf.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipError(`entry ${e.name} runs past the end of the archive`);
  const raw = buf.subarray(start, end);
  const data = e.method === METHOD_DEFLATE ? inflateRawSync(raw) : raw;
  if (data.length !== e.size) {
    throw new ZipError(`entry ${e.name} decompressed to ${data.length} bytes, expected ${e.size}`);
  }
  return data;
}

/** Unpacks the archive into `dest`, which must already exist. */
export function extractZip(buf: Buffer, dest: string, opts: ExtractOptions): ExtractResult {
  const entries = inspectZip(buf, opts);
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    const target = join(dest, ...e.name.split("/"));
    if (e.isDir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entryData(buf, e);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files++;
    bytes += data.length;
  }
  return { files, bytes };
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { time, date };
}

type PackedEntry = {
  name: Buffer;
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
  offset: number;
  time: number;
  date: number;
  externalAttrs: number;
  data: Buffer;
};

function walk(root: string, dir: string, out: { rel: string; isDir: boolean; abs: string }[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (ent.isSymbolicLink()) continue;
    const abs = join(dir, ent.name);
    const rel = relative(root, abs).split(sep).join(posix.sep);
    if (ent.isDirectory()) {
      out.push({ rel: `${rel}/`, isDir: true, abs });
      walk(root, abs, out);
    } else if (ent.isFile()) {
      out.push({ rel, isDir: false, abs });
    }
  }
}

/**
 * Packs a directory into an in-memory zip. Symlinks are skipped. Empty
 * directories are kept so the archive round-trips.
 */
export function zipDirectory(root: string): Buffer {
  const items: { rel: string; isDir: boolean; abs: string }[] = [];
  walk(root, root, items);
  if (items.length > 0xffff) throw new ZipError("too many entries for a non-zip64 archive");

  const parts: Buffer[] = [];
  const packed: PackedEntry[] = [];
  let offset = 0;

  for (const item of items) {
    const stat = statSync(item.abs);
    const { time, date } = dosDateTime(stat.mtime);
    const name = Buffer.from(item.rel, "utf8");
    let data = Buffer.alloc(0);
    let raw = data;
    let method = METHOD_STORED;
    let crc = 0;
    if (!item.isDir) {
      raw = readFileSync(item.abs);
      crc = crc32(raw);
      const deflated = deflateRawSync(raw);
      if (deflated.length < raw.length) {
        data = deflated;
        method = METHOD_DEFLATE;
      } else {
        data = raw;
      }
    }
    if (raw.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new ZipError("directory is too large for a non-zip64 archive");
    }
    const unixMode = (item.isDir ? 0o040755 : stat.mode & 0o777) | (item.isDir ? 0 : 0o100000);
    const externalAttrs = (unixMode << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, name, data);
    packed.push({
      name,
      method,
      crc,
      size: raw.length,
      compressedSize: data.length,
      offset,
      time,
      date,
      externalAttrs,
      data,
    });
    offset += local.length + name.length + data.length;
  }

  const cdStart = offset;
  for (const e of packed) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(e.time, 12);
    central.writeUInt16LE(e.date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compressedSize, 20);
    central.writeUInt32LE(e.size, 24);
    central.writeUInt16LE(e.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(e.externalAttrs, 38);
    central.writeUInt32LE(e.offset, 42);
    parts.push(central, e.name);
    offset += central.length + e.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(packed.length, 8);
  eocd.writeUInt16LE(packed.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}
