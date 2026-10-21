import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readVaultFile } from "../src/vault/file-read.js";

const errors = { unsafe: () => new Error("unsafe"), changed: () => new Error("changed"), limit: () => new Error("limit") };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rw-vault-read-"));
  const root = path.join(dir, "workspace"); await fs.mkdir(root);
  const file = path.join(root, "note.md"); await fs.writeFile(file, "note");
  return { dir, root, file, async close() {
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(absolute), /^rw-vault-read-/);
    await fs.rm(absolute, { recursive: true, force: true });
  } };
}

test("descriptor reads preserve exact bytes and empty notes within their byte limit", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x0a]); await fs.writeFile(f.file, bytes);
    assert.deepEqual(await readVaultFile(f.root, f.file, bytes.length, errors), bytes);
    await assert.rejects(readVaultFile(f.root, f.file, bytes.length - 1, errors), /limit/);
    const empty = path.join(f.root, "empty.md"); await fs.writeFile(empty, "");
    assert.deepEqual(await readVaultFile(f.root, empty, 0, errors), Buffer.alloc(0));
    await assert.rejects(readVaultFile(f.root, path.join(f.root, "missing.md"), 4, errors), { code: "ENOENT" });
    await assert.rejects(readVaultFile(f.root, path.join(f.dir, "outside.md"), 4, errors), /unsafe/);
  } finally { await f.close(); }
});

test("descriptor is opened once with no-follow/nonblocking flags and always closed on limits", async t => {
  const f = await fixture(); const originalOpen = fs.open; let opens = 0; let closes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    opens++; assert.equal(args[1], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const handle = await originalOpen(...args); const originalClose = handle.close.bind(handle);
    handle.close = async () => { closes++; await originalClose(); }; return handle;
  });
  try { await assert.rejects(readVaultFile(f.root, f.file, 3, errors), /limit/); assert.equal(opens, 1); assert.equal(closes, 1); }
  finally { t.mock.restoreAll(); await f.close(); }
});

test("leaf and parent symlinks are rejected before reading their external contents", async t => {
  const f = await fixture();
  try {
    const outside = path.join(f.dir, "secret.md"); await fs.writeFile(outside, "private");
    const link = path.join(f.root, "linked.md");
    try { await fs.symlink(outside, link, "file"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Creating symlinks requires privileges on this Windows host"); return; } throw error; }
    await assert.rejects(readVaultFile(f.root, link, 64, errors), /unsafe/);
    await fs.symlink(f.dir, path.join(f.root, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readVaultFile(f.root, path.join(f.root, "linked-dir", "secret.md"), 64, errors), /unsafe/);
  } finally { await f.close(); }
});

test("replacement between open and validation never reads the replaced path", async t => {
  const f = await fixture(); const originalOpen = fs.open; let reads = 0; let closes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); const originalRead = handle.read.bind(handle); const originalClose = handle.close.bind(handle);
    handle.read = (...readArgs: any[]) => { reads++; return (originalRead as any)(...readArgs); };
    handle.close = async () => { closes++; await originalClose(); };
    await fs.rename(f.file, path.join(f.root, "old.md")); await fs.writeFile(f.file, "other"); return handle;
  });
  try { await assert.rejects(readVaultFile(f.root, f.file, 64, errors), /changed/); assert.equal(reads, 0); assert.equal(closes, 1); }
  finally { t.mock.restoreAll(); await f.close(); }
});

test("growth during a descriptor read is bounded and rejected", async t => {
  const f = await fixture(); const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); const originalRead = handle.read.bind(handle); let changed = false;
    handle.read = async (...readArgs: any[]) => {
      assert.ok(readArgs[2] <= 9, "each read is bounded by maximum + 1");
      if (!changed) { changed = true; await fs.appendFile(f.file, "growth"); }
      return (originalRead as any)(...readArgs);
    }; return handle;
  });
  try { await assert.rejects(readVaultFile(f.root, f.file, 8, errors), /limit/); }
  finally { t.mock.restoreAll(); await f.close(); }
});

test("replacement after descriptor reading is rejected by the final path identity check", async t => {
  const f = await fixture(); const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); const originalRead = handle.read.bind(handle); let changed = false;
    handle.read = async (...readArgs: any[]) => {
      const result = await (originalRead as any)(...readArgs);
      if (!changed) { changed = true; await fs.rename(f.file, path.join(f.root, "old.md")); await fs.writeFile(f.file, "note"); }
      return result;
    }; return handle;
  });
  try { await assert.rejects(readVaultFile(f.root, f.file, 64, errors), /changed/); }
  finally { t.mock.restoreAll(); await f.close(); }
});
