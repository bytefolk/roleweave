import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TurnRecord, WorkbenchSession } from "@roleweave/shared";
import { DigitalEmployeeCliDriver } from "../src/engine/driver-cli.js";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

const { validateSessionTurnRequest } = createRequire(import.meta.url)("../../../desktop/src/session-ipc.cjs");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4AAAAABJRU5ErkJggg==";

test("desktop IPC and real HTTP/driver/adapter pass image bytes to Codex with the same text", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-image-pipeline-"));
  const captured = path.join(root, "captured.json");
  const script = path.join(root, "fake-codex.cjs");
  await fs.writeFile(script, `#!${process.execPath}\nconst fs=require('node:fs');
let text=''; process.stdin.setEncoding('utf8');process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>{
const args=process.argv.slice(2), images=args.flatMap((a,i)=>a==='--image'?[fs.readFileSync(args[i+1]).toString('base64')]:[]);
fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({args,images,text}));
const marker=${JSON.stringify(path.join(root, "retry-marker"))},fail=text.includes('retry image')&&!fs.existsSync(marker);if(fail)fs.writeFileSync(marker,'failed');
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},...(fail?[{type:'turn.failed',error:{message:'fixture failure'}}]:[{type:'item.completed',item:{id:'answer',type:'agent_message',text:'image input received'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}])])console.log(JSON.stringify(event));
});`, { mode: 0o700 });
  let command = script;
  if (process.platform === "win32") {
    command = path.join(root, "fake-codex.cmd");
    await fs.writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
  }
  const oldCommand = process.env.DIGITAL_EMPLOYEE_CODEX_COMMAND;
  process.env.DIGITAL_EMPLOYEE_CODEX_COMMAND = command;
  const adapter = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
  const driver = new DigitalEmployeeCliDriver(`${JSON.stringify(process.execPath)} ${JSON.stringify(adapter)}`, 10_000, true);
  const server = await startTestServer(undefined, driver);
  const workspace = await copyExampleWorkspace();
  t.after(async () => {
    if (oldCommand === undefined) delete process.env.DIGITAL_EMPLOYEE_CODEX_COMMAND; else process.env.DIGITAL_EMPLOYEE_CODEX_COMMAND = oldCommand;
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const post = (url: string, body: unknown) => api(server.baseUrl, url, { method: "POST", body, token: server.token });
  assert.equal((await post("/workspace/open", { path: workspace })).status, 200);
  const session = (await post("/sessions", { positionId: "repo-owner" })).body as WorkbenchSession;
  const uploaded = await post("/attachments/upload", { sessionId: session.sessionId, fileName: "screenshot.png", mimeType: "image/png", dataBase64: PNG });
  assert.equal(uploaded.status, 200);
  const attachment = (uploaded.body as { attachment: { id: string } }).attachment;
  const request = { sessionId: session.sessionId, input: "请分析截图", engine: "codex-local", attachmentIds: [attachment.id] };
  const checked = validateSessionTurnRequest(request);
  assert.equal(checked.ok, true);
  const reply = await post(`/sessions/${checked.sessionId}/turns`, checked.request);
  assert.equal(reply.status, 200);
  assert.equal((reply.body as TurnRecord).status, "completed");
  assert.equal((reply.body as TurnRecord).attachments?.[0]?.id, attachment.id);
  const actual = JSON.parse(await fs.readFile(captured, "utf8"));
  assert.deepEqual(actual.images, [PNG]);
  assert.match(actual.text, /请分析截图/);
  assert.equal(actual.args[actual.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(actual.args.includes("view_image"), "initial image inputs do not require enabling the image-reading tool");

  const empty = await post(`/sessions/${session.sessionId}/turns`, { ...checked.request, input: "" });
  assert.equal(empty.status, 400);
  assert.equal((empty.body as { code: string }).code, "turn_input_empty");
  const oversized = await post(`/sessions/${session.sessionId}/turns`, { ...checked.request, input: "汉".repeat(87382) });
  assert.equal(oversized.status, 400);
  assert.equal((oversized.body as { code: string }).code, "turn_input_too_large");

  const failed = (await post(`/sessions/${session.sessionId}/turns`, { ...checked.request, input: "retry image" })).body as TurnRecord;
  assert.equal(failed.status, "failed");
  const retry = await post(`/sessions/${session.sessionId}/turns`, { input: failed.input, engine: "codex-local", retryOf: failed.turnId });
  assert.equal(retry.status, 200);
  assert.equal((retry.body as TurnRecord).status, "completed");
  assert.deepEqual(JSON.parse(await fs.readFile(captured, "utf8")).images, [PNG]);
  assert.equal((retry.body as TurnRecord).attachments?.[0]?.id, attachment.id);

  const other = (await post("/sessions", { positionId: "release-engineer" })).body as WorkbenchSession;
  const foreign = await post(`/sessions/${other.sessionId}/turns`, checked.request);
  assert.equal(foreign.status, 400);
  assert.equal((foreign.body as { code: string }).code, "attachment_missing");
  const external = await new DigitalEmployeeCliDriver("missing-binary").turnRun({ workspace, positionId: "repo-owner", engine: "codex-local", imagePaths: ["/untrusted"], envelope: { schemaVersion: "turn-envelope.v1", workspaceRef: workspace, positionId: "repo-owner", turnId: "fixture", input: "review", envelopeDigest: `sha256:${"a".repeat(64)}` } });
  assert.equal(external.status, "indeterminate");
  if (external.status === "indeterminate") assert.equal(external.code, "attachment_images_unsupported");
});

test("unsupported image engines return an explicit error before invoking a model", async t => {
  let calls = 0;
  const server = await startTestServer(undefined, { async turnRun() { calls++; throw new Error("must not run"); } });
  const workspace = await copyExampleWorkspace();
  t.after(async () => { await server.ctx.contextExporter.waitForIdle(); await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const post = (url: string, body: unknown) => api(server.baseUrl, url, { method: "POST", body, token: server.token });
  await post("/workspace/open", { path: workspace });
  const session = (await post("/sessions", { positionId: "repo-owner" })).body as WorkbenchSession;
  const uploaded = await post("/attachments/upload", { sessionId: session.sessionId, fileName: "image.png", mimeType: "image/png", dataBase64: PNG });
  const id = (uploaded.body as { attachment: { id: string } }).attachment.id;
  const result = await post(`/sessions/${session.sessionId}/turns`, { input: "review", engine: "qoder", attachmentIds: [id] });
  assert.equal(result.status, 400);
  assert.equal((result.body as { code: string }).code, "attachment_images_unsupported");
  assert.equal(calls, 0);
});
