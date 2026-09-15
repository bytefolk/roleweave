import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWorkbuddyCli } from "../verify-workbuddy-cli.mjs";

async function fixture(t, tools) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owb-verifier-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, "codebuddy.cjs");
  await fs.writeFile(cli, `#!${process.execPath}
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('2.137.1'); process.exit(0); }
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const emit = value => console.log(JSON.stringify({session_id:arg('--session-id'),parent_tool_use_id:null,...value}));
emit({type:'system',subtype:'init',session_id:arg('--session-id'),cwd:process.cwd(),tools:[],mcp_servers:[],permissionMode:'default',model:arg('--model')});
const request = http.request(process.env.CODEBUDDY_BASE_URL + '/chat/completions', {method:'POST',headers:{'content-type':'application/json'}}, response => {
  response.resume();
  response.on('end', () => {
    emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'WORKBUDDY_LOOPBACK_OK'}}});
    emit({type:'result',subtype:'success',is_error:false,result:'WORKBUDDY_LOOPBACK_OK'});
  });
});
request.end(JSON.stringify({model:process.env.CODEBUDDY_MODEL,tools:${JSON.stringify(tools)},stream:true}));
`, { mode: 0o755 });
  return cli;
}

// The full scripts suite runs child-process and packaging tests concurrently.
// Leave room for their CPU contention without changing production deadlines.
const posix = { skip: process.platform === "win32" ? "native WorkBuddy lifecycle is not yet qualified" : false, timeout: 30000 };

for (const [tools, toolsField] of [[[], "empty-array"], [undefined, "omitted"]]) {
  test(`manual WorkBuddy verifier accepts ${toolsField} provider tools through the adapter`, posix, async (t) => {
    const result = await verifyWorkbuddyCli(await fixture(t, tools), { timeoutMs: 20000 });
    assert.deepEqual(result, {
      ok: true, evidence: "E3 real CLI with simulated loopback provider", version: "2.137.1",
      modelRequests: 1, modelVisibleTools: 0, providerToolsField: toolsField, deltaFrames: 1, terminalEvents: 1, residualProcesses: 0,
    });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-loopback|API_KEY|owb-verifier-test/);
  });
}

test("manual WorkBuddy verifier rejects a real outbound tool payload despite a tool-free init", posix, async (t) => {
  await assert.rejects(verifyWorkbuddyCli(await fixture(t, [{ type: "function", function: { name: "Bash" } }]), { timeoutMs: 20000 }), /verification.provider_tools_not_empty/);
});
