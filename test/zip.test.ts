import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractZip, inspectZip, readEntries, zipDirectory, ZipError } from "../src/zip.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zip-test-"));
}

/**
 * Hand-rolls an archive so the reader is tested against bytes the writer did
 * not produce. Entries may carry an arbitrary name and unix mode.
 */
function buildZip(entries: { name: string; data?: Buffer; mode?: number; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = e.data ?? Buffer.alloc(0);
    const data = e.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

describe("readEntries", () => {
  it("lists files and directories with their sizes", () => {
    const zip = buildZip([
      { name: "dir/", mode: 0o040755 },
      { name: "dir/a.txt", data: Buffer.from("hello"), deflate: true },
      { name: "b.txt", data: Buffer.from("world") },
    ]);
    expect(readEntries(zip)).toMatchObject([
      { name: "dir/", isDir: true },
      { name: "dir/a.txt", isDir: false, size: 5, method: 8 },
      { name: "b.txt", isDir: false, size: 5, method: 0 },
    ]);
  });

  it("rejects something that is not a zip", () => {
    expect(() => readEntries(Buffer.from("definitely not a zip file, just text"))).toThrow(ZipError);
    expect(() => readEntries(Buffer.alloc(3))).toThrow(/too small/);
  });

  it("rejects path traversal and absolute paths", () => {
    expect(() => readEntries(buildZip([{ name: "../evil.txt" }]))).toThrow(/escapes/);
    expect(() => readEntries(buildZip([{ name: "a/../../evil.txt" }]))).toThrow(/escapes/);
    expect(() => readEntries(buildZip([{ name: "/etc/passwd" }]))).toThrow(/absolute/);
    expect(() => readEntries(buildZip([{ name: "C:\\Windows\\x" }]))).toThrow(/absolute/);
  });

  it("normalizes backslashes and dot segments", () => {
    expect(readEntries(buildZip([{ name: ".\\sub\\file.txt" }]))[0]?.name).toBe("sub/file.txt");
  });

  it("rejects symlink entries", () => {
    expect(() => readEntries(buildZip([{ name: "link", mode: 0o120777 }]))).toThrow(/symlink/);
  });

  it("skips macOS resource forks", () => {
    const zip = buildZip([{ name: "__MACOSX/._a.txt" }, { name: "a.txt" }]);
    expect(readEntries(zip).map((e) => e.name)).toEqual(["a.txt"]);
  });
});

describe("extractZip", () => {
  it("writes files into the destination, creating parent directories", () => {
    const dest = tmp();
    const zip = buildZip([
      { name: "deep/er/file.txt", data: Buffer.from("nested"), deflate: true },
      { name: "empty-dir/" },
    ]);
    expect(extractZip(zip, dest, { maxBytes: 1000 })).toEqual({ files: 1, bytes: 6 });
    expect(readFileSync(join(dest, "deep", "er", "file.txt"), "utf8")).toBe("nested");
    expect(readEntries(zipDirectory(dest)).map((e) => e.name)).toContain("empty-dir/");
  });

  it("refuses archives that expand past the cap before writing anything", () => {
    const zip = buildZip([{ name: "big.bin", data: Buffer.alloc(2000, 1), deflate: true }]);
    expect(() => inspectZip(zip, { maxBytes: 1000 })).toThrow(/expands to more than 1000 bytes/);
  });

  it("detects a size mismatch between header and content", () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("abc") }]);
    // Lie about the uncompressed size in the central directory.
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(99, cdOffset + 24);
    expect(() => extractZip(zip, tmp(), { maxBytes: 1000 })).toThrow(/expected 99/);
  });
});

describe("zipDirectory", () => {
  it("round-trips a directory tree and skips symlinks", () => {
    const src = tmp();
    mkdirSync(join(src, "a", "b"), { recursive: true });
    writeFileSync(join(src, "a", "b", "c.txt"), "c".repeat(500));
    writeFileSync(join(src, "top.json"), "{}");
    mkdirSync(join(src, "empty"));
    symlinkSync(join(src, "top.json"), join(src, "link.json"));

    const archive = zipDirectory(src);
    const names = readEntries(archive).map((e) => e.name);
    expect(names).toEqual(["a/", "a/b/", "a/b/c.txt", "empty/", "top.json"]);

    const dest = tmp();
    extractZip(archive, dest, { maxBytes: 10_000 });
    expect(readFileSync(join(dest, "a", "b", "c.txt"), "utf8")).toBe("c".repeat(500));
    expect(readFileSync(join(dest, "top.json"), "utf8")).toBe("{}");
  });

  it("stores incompressible data rather than inflating it", () => {
    const src = tmp();
    writeFileSync(join(src, "x"), "ab");
    expect(readEntries(zipDirectory(src))[0]?.method).toBe(0);
  });
});
