import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type {
  AtomicTurnDirectoryHandle,
  AtomicTurnTemporaryHandle,
  AtomicTurnWriteOperations,
} from "../src/turns/store.js";
import {
  atomicWriteJson,
  nodeAtomicTurnWriteOperations,
  TurnStore,
} from "../src/turns/store.js";

function testStorageError(message: string): OrgApiError {
  return new OrgApiError(errorCodes.turn_storage_failed, 500, message);
}

function epermDirectoryOperations(): AtomicTurnWriteOperations {
  return {
    async openTemporary(file): Promise<AtomicTurnTemporaryHandle> {
      const handle = await fs.open(file, "wx", 0o600);
      return {
        writeFile: (payload) => handle.writeFile(payload, "utf8"),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    rename: (source, target) => fs.rename(source, target),
    chmod: (file, mode) => fs.chmod(file, mode),
    async openDirectory(_directory): Promise<AtomicTurnDirectoryHandle> {
      return {
        sync: async () => {
          const error = new Error("operation not permitted, fsync") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
        close: async () => {},
      };
    },
    removeTemporary: (file) => fs.rm(file, { force: true }),
  };
}

test("atomicWriteJson succeeds when directory sync rejects with EPERM (#155)", { skip: process.platform !== "win32" ? "EPERM directory sync is only swallowed on Windows" : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-eperm-test-"));
  try {
    const file = path.join(dir, "record.json");
    const operations = epermDirectoryOperations();
    await atomicWriteJson(file, { hello: "world" }, 4096, operations, testStorageError);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(raw, { hello: "world" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson propagates EPERM on non-Windows platforms", { skip: process.platform === "win32" ? "EPERM is only swallowed on Windows" : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-eperm-posix-"));
  try {
    const file = path.join(dir, "record.json");
    const operations = epermDirectoryOperations();
    await assert.rejects(
      atomicWriteJson(file, { hello: "world" }, 4096, operations, testStorageError),
      (error: NodeJS.ErrnoException) => error.code === "EPERM",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson still rejects on non-EPERM directory sync errors", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-eio-test-"));
  try {
    const file = path.join(dir, "record.json");
    const operations: AtomicTurnWriteOperations = {
      ...epermDirectoryOperations(),
      async openDirectory(_directory): Promise<AtomicTurnDirectoryHandle> {
        return {
          sync: async () => {
            const error = new Error("input/output error") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          },
          close: async () => {},
        };
      },
    };
    await assert.rejects(
      atomicWriteJson(file, { hello: "world" }, 4096, operations, testStorageError),
      (error: NodeJS.ErrnoException) => error.code === "EIO",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TurnStore succeeds with EPERM directory sync via injected operations", { skip: process.platform !== "win32" ? "EPERM directory sync is only swallowed on Windows" : false }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "owb-turnstore-eperm-"));
  try {
    const store = new TurnStore({ atomicWriteOperations: epermDirectoryOperations() });
    const record = await store.begin({
      workspace,
      positionId: "test-position",
      turnId: "test-turn",
      engine: "qoder",
      message: "hello",
      envelopeDigest: "sha256:" + "a".repeat(64),
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(record.status, "running");
    assert.equal(record.turnId, "test-turn");
    const turnFile = path.join(
      workspace, ".digital-employee", "workbench", "conversations",
      "test-position", "turns", "test-turn.json",
    );
    const raw = JSON.parse(await fs.readFile(turnFile, "utf8"));
    assert.equal(raw.turnId, "test-turn");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("nodeAtomicTurnWriteOperations handles real directory sync without error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-real-dir-sync-"));
  try {
    const file = path.join(dir, "record.json");
    await atomicWriteJson(file, { test: true }, 4096, nodeAtomicTurnWriteOperations, testStorageError);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(raw, { test: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
