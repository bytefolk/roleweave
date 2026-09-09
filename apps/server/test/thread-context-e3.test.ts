import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { TurnRecord, WorkbenchSession } from "@roleweave/shared";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { computeEnvelopeDigest } from "../src/turns/envelope.js";
import { api, copyExampleWorkspace, startTestServer, type TestServer } from "./helpers.js";

const ADAPTER = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));

test("E3 HTTP session -> spawned bundled adapter -> Qoder process receives persistent bounded context", {
  skip: process.platform === "win32" ? "POSIX shebang fixture; Windows adapter invocation has separate coverage" : false,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-context-e3-"));
  const workspace = await copyExampleWorkspace();
  const capture = path.join(dir, "input.json");
  const host = path.join(dir, "qoder.cjs");
  await fs.writeFile(host, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({type:"system",subtype:"init"});
emit({type:"assistant",message:{content:[{type:"thinking",thinking:"private-chain"},{type:"text",text:"Orion first draft"}]}});
emit({type:"result",subtype:"success",is_error:false,result:"Orion first draft"});
`, { mode: 0o755 });
  const previousCommand = process.env.DIGITAL_EMPLOYEE_QODER_COMMAND;
  process.env.DIGITAL_EMPLOYEE_QODER_COMMAND = host;
  const driver = () => new DigitalEmployeeCliDriver(`${JSON.stringify(process.execPath)} ${JSON.stringify(ADAPTER)}`, 20_000);
  let server: TestServer | undefined;
  const open = async (): Promise<TestServer> => {
    const next = await startTestServer(undefined, driver());
    const response = await api(next.baseUrl, "/workspace/open", { method: "POST", token: next.token, body: { path: workspace } });
    assert.equal(response.status, 200);
    return next;
  };
  try {
    server = await open();
    const created = await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "repo-owner" } });
    assert.equal(created.status, 201);
    let session = created.body as WorkbenchSession;
    assert.equal(session.threadContextEnabled, true);
    const post = async (input: string): Promise<TurnRecord> => {
      const result = await api(server!.baseUrl, `/sessions/${session.sessionId}/turns`, { method: "POST", token: server!.token, body: { input, engine: "qoder" } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const record = result.body as TurnRecord;
      assert.equal(record.status, "completed", JSON.stringify(result.body));
      assert.equal(record.input, input, "durable history keeps the raw request instead of duplicating context");
      return record;
    };
    const first = await post("Project Orion ships Friday. Prefer concise updates. API_KEY=privatecredential");
    assert.equal(first.threadContext?.contextBytes, 0);
    const second = await post("Revise the previous draft for the same project.");
    let hostInput = (JSON.parse(await fs.readFile(capture, "utf8")) as string[]).at(-1)!;
    assert.match(hostInput, /Project Orion ships Friday/);
    assert.match(hostInput, /Orion first draft/);
    assert.doesNotMatch(hostInput, /privatecredential|private-chain/);
    assert.equal(second.threadContext?.sourceTurnCount, 1);
    assert.match(second.threadContext!.summary, /Project Orion ships Friday/);
    assert.equal(second.envelopeDigest, computeEnvelopeDigest({ schemaVersion: "turn-envelope.v1alpha2", workspaceRef: workspace, positionId: "repo-owner", turnId: second.turnId, input: hostInput, conversationRef: session.sessionId }));
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    server = await open();
    await post("Continue after restarting the application.");
    hostInput = (JSON.parse(await fs.readFile(capture, "utf8")) as string[]).at(-1)!;
    assert.match(hostInput, /Project Orion ships Friday/);
    assert.match(hostInput, /Revise the previous draft/);

    const other = await api(server.baseUrl, "/sessions", { method: "POST", token: server.token, body: { positionId: "issue-researcher" } });
    assert.equal(other.status, 201);
    await api(server.baseUrl, `/sessions/${(other.body as WorkbenchSession).sessionId}/turns`, { method: "POST", token: server.token, body: { input: "Research independently", engine: "qoder" } });
    hostInput = (JSON.parse(await fs.readFile(capture, "utf8")) as string[]).at(-1)!;
    assert.equal(hostInput, "Research independently", "another employee cannot inherit personal history");

    const changed = await api(server.baseUrl, `/sessions/${session.sessionId}/context`, { method: "PATCH", token: server.token, body: { enabled: false } });
    assert.equal(changed.status, 200);
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    server = await open();
    const disabled = await post("Only this request should be present.");
    assert.equal(disabled.threadContext?.enabled, false);
    assert.equal(disabled.threadContext?.sourceTurnCount, 0);
    assert.equal((JSON.parse(await fs.readFile(capture, "utf8")) as string[]).at(-1), disabled.input);
    const history = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, { token: server.token });
    assert.equal(history.status, 200, "new metadata remains readable after restart");
    assert.equal((history.body as { turns: TurnRecord[] }).turns.length, 4);

    await api(server.baseUrl, `/sessions/${session.sessionId}/context`, { method: "PATCH", token: server.token, body: { enabled: true } });
    const rotated = await api(server.baseUrl, `/sessions/${session.sessionId}/rotate`, { method: "POST", token: server.token, body: {} });
    assert.equal(rotated.status, 201);
    session = rotated.body as WorkbenchSession;
    const fresh = await post("Start a separate project.");
    assert.equal(fresh.threadContext?.sourceTurnCount, 0);
    assert.equal((JSON.parse(await fs.readFile(capture, "utf8")) as string[]).at(-1), fresh.input);
  } finally {
    await server?.ctx.contextExporter.waitForIdle();
    await server?.close();
    if (previousCommand === undefined) delete process.env.DIGITAL_EMPLOYEE_QODER_COMMAND;
    else process.env.DIGITAL_EMPLOYEE_QODER_COMMAND = previousCommand;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
