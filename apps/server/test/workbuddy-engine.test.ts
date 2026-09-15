import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ADAPTER = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));
const init = `emit({type:'system',subtype:'init',session_id:arg('--session-id'),cwd:process.cwd(),tools:[],mcp_servers:[],permissionMode:'default',model:arg('--model')});`;
const success = `emit({type:'result',subtype:'success',is_error:false,result:'done',usage:{input_tokens:2,output_tokens:1}});`;

async function fixture(body: string, overrides: NodeJS.ProcessEnv = {}, version = "2.137.1", cancel = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-workbuddy-test-"));
  const stub = path.join(root, process.platform === "win32" ? "workbuddy.cmd" : "workbuddy");
  const source = path.join(root, "workbuddy.cjs");
  const marker = path.join(root, "spawn.jsonl");
  const pidFile = path.join(root, "pid");
  const descendantFile = path.join(root, "descendant");
  const script = `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');const descendantFile=${JSON.stringify(descendantFile)};
const arg=k=>process.argv[process.argv.indexOf(k)+1];const emit=e=>console.log(JSON.stringify({session_id:arg('--session-id'),...(['stream_event','assistant'].includes(e.type)?{parent_tool_use_id:null}:{}),...e}));
fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
if(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0)}
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
${body}\n`;
  await fs.writeFile(source, script, { mode: 0o755 });
  if (process.platform === "win32") await fs.writeFile(stub, `@echo off\r\n"${process.execPath}" "${source}" %*\r\n`);
  else await fs.symlink(source, stub);
  const unexpected = path.join(root, "unexpected");
  await fs.writeFile(unexpected, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root, "wrong-host"))},'wrong host')`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, TMPDIR: root,
    DIGITAL_EMPLOYEE_ENGINE_MODEL: "workbuddy", DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: stub,
    DIGITAL_EMPLOYEE_QODER_COMMAND: unexpected, DIGITAL_EMPLOYEE_CLAUDE_COMMAND: unexpected, DIGITAL_EMPLOYEE_CODEX_COMMAND: unexpected,
    CODEBUDDY_API_KEY: "synthetic-workbuddy-key", CODEBUDDY_MODEL: "review-model",
    OPENAI_API_KEY: "synthetic-other-key", ANTHROPIC_API_KEY: "synthetic-anthropic-key",
    QODER_PERSONAL_ACCESS_TOKEN: "synthetic-qoder-key", ROLEWEAVE_BOOT_TOKEN: "synthetic-boot-token",
    ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--no-warnings", ...overrides,
  };
  const child = spawn(process.execPath, [ADAPTER, "turn", "run", root, "--position", "review", "--stdin"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end(JSON.stringify({ input: "Hello" }));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
  const cancellation = cancel ? setInterval(() => {
    fs.stat(descendantFile).then(() => child.kill("SIGTERM"), () => {});
  }, 20) : undefined;
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  if (cancellation) clearInterval(cancellation);
  const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const calls = await fs.readFile(marker, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line)), () => []);
  let alive = false;
  try { const pid = Number(await fs.readFile(pidFile, "utf8")); try { process.kill(pid, 0); alive = true; } catch {} if (alive) { try { process.kill(-pid, "SIGKILL"); } catch {} } } catch {}
  let descendantAlive = false;
  try {
    const pid = Number(await fs.readFile(descendantFile, "utf8"));
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); descendantAlive = true; } catch { descendantAlive = false; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (descendantAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
  } catch {}
  const wrongHost = await fs.stat(path.join(root, "wrong-host")).then(() => true, () => false);
  await fs.rm(root, { recursive: true, force: true });
  return { events, calls, timedOut, stderr, alive, wrongHost, descendantAlive, exitCode };
}

const posix = { skip: process.platform === "win32" ? "native WorkBuddy process tree lifecycle is explicitly not verified" : false };

test("WorkBuddy requires credentials and model before even probing a binary", posix, async () => {
  for (const [overrides, code] of [[{ CODEBUDDY_API_KEY: undefined }, "workbuddy.credential_missing"], [{ CODEBUDDY_MODEL: undefined }, "workbuddy.model_missing"], [{ CODEBUDDY_MODEL: "--bad" }, "workbuddy.model_invalid"]] as const) {
    const result = await fixture(init + success, overrides);
    assert.equal(result.events.at(-1)?.error?.code, code);
    assert.equal(result.calls.length, 0);
  }
});

test("WorkBuddy executes its selected host with a closed credential environment", posix, async () => {
  const result = await fixture(init + success);
  assert.equal(result.events.at(-1)?.type, "run.completed");
  assert.equal(result.wrongHost, false);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].env.CODEBUDDY_API_KEY, undefined);
  assert.equal(result.calls[1].env.CODEBUDDY_API_KEY, "synthetic-workbuddy-key");
  for (const call of result.calls) {
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "ROLEWEAVE_BOOT_TOKEN", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND", "DIGITAL_EMPLOYEE_ENGINE_MODEL"]) assert.equal(call.env[key], undefined, key);
    assert.ok(!JSON.stringify(call.argv).includes("synthetic-workbuddy-key"));
  }
});

test("WorkBuddy binds its deny profile to audited versions", posix, async () => {
  const result = await fixture(init + success, {}, "2.138.0");
  assert.equal(result.events.at(-1)?.error?.code, "workbuddy.version_not_supported");
  assert.equal(result.calls.length, 1);
});

test("WorkBuddy rejects absent or unsafe init and unrecognized tool events", posix, async () => {
  for (const body of [success, init.replace("tools:[]", "tools:['execute']") + success, init.replace("mcp_servers:[]", "mcp_servers:[{name:'unsafe'}]") + success, init.replace("permissionMode:'default'", "permissionMode:'bypassPermissions'") + success, init.replace("session_id:arg('--session-id')", "session_id:'wrong'") + success, init.replace("cwd:process.cwd()", "cwd:'/wrong'") + success, init.replace("model:arg('--model')", "model:'wrong'") + success, init + `emit({type:'tool_use',name:'execute'});` + success, init + `console.log('malformed json');` + success]) {
    const result = await fixture(body);
    assert.equal(result.events.at(-1)?.type, "run.failed", body);
    assert.equal(result.events.filter((event) => event.type === "run.completed").length, 0);
  }
});

test("WorkBuddy error result produces one terminal failure and kills the child", posix, async () => {
  const result = await fixture(init + `emit({type:'result',subtype:'error_max_turns',is_error:true,result:'synthetic-workbuddy-key'});setInterval(()=>{},1000);`);
  assert.equal(result.timedOut, false);
  assert.equal(result.events.at(-1)?.error?.code, "workbuddy.result_error");
  assert.equal(result.events.filter((event) => event.type === "run.failed").length, 1);
  assert.equal(result.alive, false);
  assert.ok(!JSON.stringify(result.events).includes("synthetic-workbuddy-key"));
});

test("WorkBuddy never persists raw diagnostic credentials", posix, async () => {
  const result = await fixture(init + `console.error('rejected '+process.env.CODEBUDDY_API_KEY);process.exit(2);`);
  assert.equal(result.events.at(-1)?.error?.code, "workbuddy.exit_nonzero");
  assert.ok(!JSON.stringify(result.events).includes("synthetic-workbuddy-key"));
});

test("WorkBuddy rejects a result from a child that fails to exit", posix, async () => {
  const result = await fixture(init + success + `setInterval(()=>{},1000);`);
  assert.equal(result.events.at(-1)?.error?.code, "workbuddy.exit_timeout");
  assert.equal(result.alive, false);
});

test("WorkBuddy nested stream deltas and assistant snapshots do not duplicate text", posix, async () => {
  const result = await fixture(init + `emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}}});emit({type:'assistant',message:{content:[{type:'text',text:'hello world'}]}});emit({type:'result',subtype:'success',is_error:false,result:'hello world'});`);
  assert.equal(result.events.at(-1)?.type, "run.completed");
  assert.equal(result.events.filter((event) => event.type === "model.delta").map((event) => event.text).join(""), "hello world");
});


test("WorkBuddy owns descendants on completion and cancellation", posix, async () => {
  const descendant = `const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});grandchild.unref();fs.writeFileSync(descendantFile,String(grandchild.pid));`;
  for (const cancel of [false, true]) {
    const result = await fixture(init + descendant + (cancel ? `setInterval(()=>{},1000);` : success), {}, "2.137.1", cancel);
    assert.equal(result.calls.length, 2);
    assert.equal(result.timedOut, false);
    assert.equal(result.alive, false);
    assert.equal(result.descendantAlive, false);
    if (cancel) assert.equal(result.exitCode, 143);
    else assert.equal(result.events.at(-1)?.type, "run.completed");
  }
});

test("WorkBuddy permits audited empty metadata and rejects mutation snapshots", posix, async () => {
  const status = `emit({type:'system',subtype:'status',status:null,uuid:'status-id'});`;
  const snapshot = `console.log(JSON.stringify({type:'file-history-snapshot',id:'snapshot-id',timestamp:1,isSnapshotUpdate:false,snapshot:{messageId:'message-id',trackedFileBackups:{}}}));`;
  const result = await fixture(init + status + snapshot + success);
  assert.equal(result.events.at(-1)?.type, "run.completed");
  const unsafe = await fixture(init + snapshot.replace("trackedFileBackups:{}", "trackedFileBackups:{file:'changed'}") + success);
  assert.equal(unsafe.events.at(-1)?.error?.code, "workbuddy.snapshot_invalid");
});

test("WorkBuddy validates result session, subagent frames and token counts", posix, async () => {
  for (const body of [
    success.replace("type:'result'", "session_id:'wrong',type:'result'"),
    `emit({type:'assistant',parent_tool_use_id:'tool',message:{content:[{type:'text',text:'unsafe'}]}});` + success,
    success.replace("input_tokens:2", "input_tokens:-1"),
    success.replace("is_error:false", "is_error:undefined"),
    `emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'input_json_delta',partial_json:'{}'}}});` + success,
  ]) assert.equal((await fixture(init + body)).events.at(-1)?.type, "run.failed", body);
});

test("WorkBuddy bounds output and requires a terminal result", posix, async () => {
  const noResult = await fixture(init);
  assert.equal(noResult.events.at(-1)?.error?.code, "workbuddy.no_terminal_event");
  const oversized = await fixture(init + `process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},1000);`);
  assert.equal(oversized.events.at(-1)?.error?.code, "workbuddy.output_limit");
  assert.equal(oversized.alive, false);
});

test("WorkBuddy preserves split UTF-8 and redacts a credential split across text frames", posix, async () => {
  const utf8 = await fixture(init + `const bytes=Buffer.from(JSON.stringify({session_id:arg('--session-id'),type:'assistant',parent_tool_use_id:null,message:{content:[{type:'text',text:'你好'}]}})+'\\n');const start=bytes.indexOf(Buffer.from('你'));process.stdout.write(bytes.subarray(0,start+1));setTimeout(()=>{process.stdout.write(bytes.subarray(start+1));${success}},20);`);
  assert.equal(utf8.events.filter((event) => event.type === "model.delta").map((event) => event.text).join(""), "你好");
  const secret = await fixture(init + `emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'synthetic-work'}}});emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'buddy-key'}}});emit({type:'result',subtype:'success',is_error:false,result:'synthetic-workbuddy-key'});`);
  assert.equal(secret.events.at(-1)?.output, "[redacted]");
  assert.equal(secret.events.filter((event) => event.type === "model.delta").map((event) => event.text).join(""), "[redacted]");
});

test("Selecting Codex never invokes the WorkBuddy stub", posix, async () => {
  const result = await fixture(init + success, { DIGITAL_EMPLOYEE_ENGINE_MODEL: "codex" });
  assert.equal(result.calls.length, 0);
  assert.equal(result.wrongHost, true, "the selected Codex stub must be executed");
});


test("WorkBuddy validates exit status and every frame after a result", posix, async () => {
  for (const body of [
    init + success + `process.exitCode=2;`,
    init + success + `emit({type:'tool_use',name:'Bash'});`,
    init + success + success,
  ]) {
    const result = await fixture(body);
    assert.equal(result.events.at(-1)?.type, "run.failed", body);
    assert.equal(result.events.filter((event) => event.type === "run.completed").length, 0);
  }
});
