import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";

interface ReadErrors { unsafe: () => Error; changed: () => Error; limit: () => Error }

async function regularPath(root: string, file: string, errors: ReadErrors): Promise<Stats> {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw errors.unsafe();
  const base = await fs.lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink()) throw errors.unsafe();
  let current = root;
  const segments = relative.split(path.sep);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]!);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw errors.unsafe();
    if (i === segments.length - 1) return stat;
  }
  throw errors.unsafe();
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Open once, then validate and read that descriptor. O_NOFOLLOW prevents a
 * leaf symlink race on POSIX; Windows lacks that flag, so both path checks and
 * descriptor identity checks remain mandatory there. Parent directories are
 * checked before reading and again before returning any bytes. */
export async function readVaultFile(root: string, file: string, maximum: number, errors: ReadErrors): Promise<Buffer> {
  root = path.resolve(root); file = path.resolve(file);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw errors.unsafe();
  let handle;
  try {
    // O_NONBLOCK prevents an exchanged FIFO from blocking before fstat rejects it.
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw errors.unsafe();
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw errors.unsafe();
    if (before.size > maximum) throw errors.limit();
    if (!sameFile(before, await regularPath(root, file, errors))) throw errors.changed();
    const buffer = Buffer.allocUnsafe(Math.min(maximum + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (length > maximum || after.size > maximum) throw errors.limit();
    if (length !== before.size || !sameFile(before, after) || !sameFile(after, await regularPath(root, file, errors))) throw errors.changed();
    return Buffer.from(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
