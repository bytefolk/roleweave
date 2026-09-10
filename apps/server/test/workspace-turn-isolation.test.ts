import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { TurnRunDriver, WorkbenchSession } from "@roleweave/shared";
import { OrgApiError } from "@roleweave/shared";
import { handleTurnCancel, handleTurnPost } from "../src/routes/turns.js";
import { handleSessionContextPatch, handleSessionCreate, handleSessionRotate, handleSessionTurnPost } from "../src/routes/sessions.js";
import { handleGroupAddMember, handleGroupCreate, handleGroupTurnPost } from "../src/routes/groups.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

test("switching projects during session reservation cannot invoke a host or persist A's session in B", async () => {
  let calls = 0;
  const driver: TurnRunDriver = { async turnRun() { calls += 1; throw new Error("must not invoke a host"); } };
  const server = await startTestServer(undefined, driver);
  const firstWorkspace = await copyExampleWorkspace();
  const secondWorkspace = await copyExampleWorkspace();
  let entered!: () => void;
  const reserved = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pending: ReturnType<typeof api> | undefined;
  try {
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: firstWorkspace } });
    const created = await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
    const session = created.body as WorkbenchSession;
    const reserve = server.ctx.sessionStore.reserveTurn.bind(server.ctx.sessionStore);
    server.ctx.sessionStore.reserveTurn = async (...args) => {
      const value = await reserve(...args);
      entered();
      await gate;
      return value;
    };
    pending = api(server.baseUrl, `/sessions/${session.sessionId}/turns`, { method: "POST", token: server.token, body: { input: "PRIVATE PROJECT A TASK", engine: "qoder" } });
    await reserved;
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: secondWorkspace } });
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(calls, 0);
    for (const workspace of [firstWorkspace, secondWorkspace]) {
      const directory = path.join(workspace, ".digital-employee", "workbench", "sessions", "conversations", session.sessionId, "turns");
      const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.equal(names.length, 0, "a rejected turn must not create a record in either workspace");
    }
    await server.ctx.workspace.openWorkspace(firstWorkspace);
    const subsequent = await reserve(firstWorkspace, session.sessionId);
    assert.equal(subsequent.sessionId, session.sessionId, "rejected request releases the old workspace reservation");
    server.ctx.sessionStore.releaseTurn(firstWorkspace, session.sessionId);
  } finally {
    release();
    await pending;
    await server.close();
    await fs.rm(firstWorkspace, { recursive: true, force: true });
    await fs.rm(secondWorkspace, { recursive: true, force: true });
  }
});

test("body-read suspension never retargets personal, session, group, or cancellation mutations", async () => {
  const server = await startTestServer();
  const firstWorkspace = await copyExampleWorkspace();
  const secondWorkspace = await copyExampleWorkspace();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const cases: Array<{ name: string; body: unknown; run(req: IncomingMessage, res: ServerResponse): Promise<void> }> = [
    { name: "bare turn", body: { positionId: "repo-owner", input: "project A task", engine: "qoder" }, run: (req, res) => handleTurnPost(server.ctx, req, res) },
    { name: "cancel", body: { positionId: "repo-owner" }, run: (req, res) => handleTurnCancel(server.ctx, req, res) },
    { name: "create session", body: { positionId: "repo-owner" }, run: (req, res) => handleSessionCreate(server.ctx, req, res) },
    { name: "session turn", body: { input: "project A task", engine: "qoder" }, run: (req, res) => handleSessionTurnPost(server.ctx, req, res, sessionId) },
    { name: "session policy", body: { enabled: false }, run: (req, res) => handleSessionContextPatch(server.ctx, req, res, sessionId) },
    { name: "rotate session", body: {}, run: (req, res) => handleSessionRotate(server.ctx, req, res, sessionId) },
    { name: "create group", body: { memberPositionIds: ["repo-owner", "issue-researcher"] }, run: (req, res) => handleGroupCreate(server.ctx, req, res) },
    { name: "group turn", body: { input: "project A task", mentions: ["repo-owner"], engine: "qoder" }, run: (req, res) => handleGroupTurnPost(server.ctx, req, res, "group-a") },
    { name: "add group member", body: { positionId: "repo-owner" }, run: (req, res) => handleGroupAddMember(server.ctx, req, res, "group-a") },
  ];
  try {
    for (const item of cases) {
      await server.ctx.workspace.openWorkspace(firstWorkspace);
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const req = Readable.from((async function* () {
        entered();
        await gate;
        yield Buffer.from(JSON.stringify(item.body));
      })()) as IncomingMessage;
      const pending = item.run(req, {} as ServerResponse);
      const rejected = assert.rejects(pending, (error: unknown) => error instanceof OrgApiError && error.status === 409, item.name);
      await reading;
      await server.ctx.workspace.openWorkspace(secondWorkspace);
      release();
      await rejected;
    }
    await assert.rejects(fs.access(path.join(secondWorkspace, ".digital-employee", "workbench", "sessions")), { code: "ENOENT" });
  } finally {
    await server.close();
    await fs.rm(firstWorkspace, { recursive: true, force: true });
    await fs.rm(secondWorkspace, { recursive: true, force: true });
  }
});
