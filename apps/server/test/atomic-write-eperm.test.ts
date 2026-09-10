import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TurnRecord, WorkbenchSession } from "@roleweave/shared";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import {
  ContextExportService,
  readContextExportState,
  type ContextAdapterClient,
} from "../src/context-export/exporter.js";
import type {
  AtomicTurnDirectoryHandle,
  AtomicTurnTemporaryHandle,
  AtomicTurnWriteOperations,
} from "../src/turns/store.js";
import { GroupStore } from "../src/groups/store.js";
import {
  atomicWriteJson,
  nodeAtomicTurnWriteOperations,
  TurnStore,
} from "../src/turns/store.js";
import { copyExampleWorkspace } from "./helpers.js";

function testStorageError(message: string): OrgApiError {
  return new OrgApiError(errorCodes.turn_storage_failed, 500, message);
}

function epermDirectoryOperations(platform: NodeJS.Platform = process.platform): AtomicTurnWriteOperations {
  return {
    platform,
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

test("atomicWriteJson succeeds when directory sync rejects with EPERM on win32 (#155)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-eperm-test-"));
  try {
    const file = path.join(dir, "record.json");
    const operations = epermDirectoryOperations("win32");
    await atomicWriteJson(file, { hello: "world" }, 4096, operations, testStorageError);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(raw, { hello: "world" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson propagates EPERM on non-Windows platforms", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-eperm-posix-"));
  try {
    const file = path.join(dir, "record.json");
    const operations = epermDirectoryOperations("linux");
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

test("TurnStore succeeds with EPERM directory sync via injected operations", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "owb-turnstore-eperm-"));
  try {
    const store = new TurnStore({ atomicWriteOperations: epermDirectoryOperations("win32") });
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

function exportSession(): WorkbenchSession {
  return {
    schemaVersion: "workbench-session.v1",
    sessionId: "28d2702d-6fc6-4eb0-bd4e-99d93c2e4534",
    workspaceInstanceId: "466fdb7a-041c-49e6-8711-6f7ffb9c2507",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    status: "active",
    rotatedFrom: null,
    rotatedTo: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    rotatedAt: null,
  };
}

function exportTurn(): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: "28d2702d-6fc6-4eb0-bd4e-99d93c2e4534",
    turnId: "turn-001",
    positionId: "repo-owner",
    engine: "qoder",
    status: "completed",
    input: "Summarize the release decision.",
    envelopeDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-24T00:00:01.000Z",
    updatedAt: "2026-08-24T00:00:02.000Z",
    events: [
      { type: "run.started", runId: "run-001", timestamp: "2026-08-24T00:00:01.000Z" },
      {
        type: "run.completed",
        runId: "run-001",
        timestamp: "2026-08-24T00:00:02.000Z",
        output: "The release remains gated on CI.",
        terminalReason: "goal_met",
      },
    ],
    runId: "run-001",
    output: "The release remains gated on CI.",
  };
}

class DoneAdapter implements ContextAdapterClient {
  async ingest(occurrence: { occurrenceId: string }): Promise<{
    inserted: boolean;
    occurrenceId: string;
    status: "pending" | "done" | "failed";
  }> {
    return { inserted: true, occurrenceId: occurrence.occurrenceId, status: "done" };
  }

  async distill(occurrenceId: string): Promise<{ occurrenceId: string; status: "done"; artifacts: number }> {
    return { occurrenceId, status: "done", artifacts: 1 };
  }
}

test("the context exporter shares the win32 EPERM gate instead of keeping its own (#155 AC-002)", async () => {
  const workspace = await copyExampleWorkspace();
  try {
    const session = exportSession();
    const turn = exportTurn();
    const exporter = new ContextExportService(new DoneAdapter(), epermDirectoryOperations("win32"));
    await exporter.enqueueCompletedTurn(workspace, session, turn);
    await exporter.waitForIdle();
    const state = await readContextExportState(workspace, session.sessionId, turn.turnId);
    assert.equal(state.status, "done", "every exporter write must survive a win32 directory-sync EPERM");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("the context exporter still propagates directory-sync EPERM on POSIX", async () => {
  const workspace = await copyExampleWorkspace();
  try {
    const exporter = new ContextExportService(new DoneAdapter(), epermDirectoryOperations("linux"));
    await assert.rejects(
      exporter.enqueueCompletedTurn(workspace, exportSession(), exportTurn()),
      (error: Error) => error.message === "context export state could not be persisted",
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a raw platform errno from the shared writer survives the store boundary (#155 AC-005)", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "owb-ac005-"));
  try {
    const store = new GroupStore();
    const group = await store.create({
      workspace,
      sessionId: "28d2702d-6fc6-4eb0-bd4e-99d93c2e4534",
      members: ["repo-owner"],
      now: "2026-08-24T00:00:00.000Z",
    });
    // A directory at the message path makes the real rename() in the shared
    // writer fail with a raw errno, which is the shape AC-005 says must stay
    // distinguishable from a domain failure. rename() onto an existing
    // directory reports EISDIR on POSIX and EPERM on win32, so the expected
    // errno has to follow the host platform.
    await fs.mkdir(path.join(workspace, ".digital-employee", "workbench", "groups", group.conversationRef, "messages", "m1.json"));
    await assert.rejects(
      store.appendMessage(workspace, group.conversationRef, {
        messageId: "m1",
        input: "hello",
        mentions: [],
        createdAt: "2026-08-24T00:00:01.000Z",
      }),
      (error: unknown) => {
        assert.ok(error instanceof OrgApiError);
        assert.equal(error.code, errorCodes.group_storage_failed);
        assert.equal(error.status, 500);
        const cause = error.cause as NodeJS.ErrnoException | undefined;
        assert.equal(
          cause?.code,
          process.platform === "win32" ? "EPERM" : "EISDIR",
          "AC-005: the errno must survive, not just a fixed message",
        );
        assert.equal(cause?.syscall, "rename");
        return true;
      },
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
