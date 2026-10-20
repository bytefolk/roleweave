const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ADAPTER = path.resolve(__dirname, "../../server/bin/qoder-engine.mjs");
const QUESTION = "你当前的资产文件夹下是在哪里？";
const INPUTS = [
  ["Chinese question", QUESTION],
  ["multiline context and metacharacters", `Thread context:\n{"input":"earlier request"}\n\nCurrent user request:\r\n${QUESTION}\r\nPreserve: "quotes" %PATH% !value! & | < > ^ \\ 😀\nFinal question: ${QUESTION}`],
  ["context exceeding the Windows command-line limit", "Context:\n" + "中文上下文 😀\n".repeat(3000) + `Current user request:\n${QUESTION}`],
];

async function fixture(t, earlyExit = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-codex-stdin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const workspace = path.join(root, "workspace 空间");
  await fs.mkdir(workspace);
  const script = path.join(root, "provider.cjs");
  const capture = path.join(root, "capture.json");
  const body = earlyExit ? "process.exit(0);" : `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  const write = event => console.log(JSON.stringify(event));
  write({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Fixture received the prompt.' } });
  write({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;
  await fs.writeFile(script, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  let command = script;
  if (process.platform === "win32") {
    command = path.join(root, "codex fixture.cmd");
    // Exercise the native npm-style cmd.exe -> Node argv boundary.
    await fs.writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
  }
  return { workspace, command, capture };
}

function runAdapter(workspace, command, engine, input) {
  const env = {};
  for (const key of ["PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TMPDIR", "TMP", "TEMP", "ELECTRON_RUN_AS_NODE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    DIGITAL_EMPLOYEE_ENGINE_MODEL: engine,
    DIGITAL_EMPLOYEE_CODEX_COMMAND: command,
    ROLEWEAVE_TURN_MODEL: "fixture-model",
    // Service mode exercises the provider argv without a real provider call.
    ...(engine === "codex" ? { OPENAI_BASE_URL: "https://provider.example.test/v1", OPENAI_API_KEY: "fixture-key" } : {}),
  });
  const result = spawnSync(process.execPath, [ADAPTER, "turn", "run", workspace, "--position", "tech-lead", "--stdin"], {
    env, input: JSON.stringify({ input }), encoding: "utf8", timeout: 15_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "run.completed" || event.type === "run.failed").length, 1);
  return { events, stderr: result.stderr };
}

for (const engine of ["codex", "codex-local"]) {
  for (const [label, input] of INPUTS) {
    test(`${engine} delivers ${label} intact through stdin`, { timeout: 20_000 }, async t => {
      const { workspace, command, capture } = await fixture(t);
      const { events } = runAdapter(workspace, command, engine, input);
      assert.equal(events.at(-1).type, "run.completed", JSON.stringify(events));
      const received = JSON.parse(await fs.readFile(capture, "utf8"));
      assert.equal(received.input, `[Position: tech-lead]\n[Workspace: ${workspace}]\n\n${input}`);
      assert.equal(received.argv.at(-1), "-");
      assert.equal(received.argv.some(arg => arg.includes(QUESTION) || /[\r\n]/.test(arg)), false);
      assert.equal(received.argv[received.argv.indexOf("--model") + 1], "fixture-model");
      assert.equal(received.argv[received.argv.indexOf("--sandbox") + 1], "read-only");
      assert.ok(received.argv.includes("--ignore-user-config"));
      assert.equal(received.argv.some(arg => arg.includes("base_url")), engine === "codex");
    });
  }

  test(`${engine} reports one typed failure if the input pipe closes early`, { timeout: 20_000 }, async t => {
    const { workspace, command } = await fixture(t, true);
    const { events, stderr } = runAdapter(workspace, command, engine, "问".repeat(60_000));
    assert.equal(events.at(-1).type, "run.failed");
    assert.ok(["codex.stdin_failed", "codex.no_terminal_event"].includes(events.at(-1).error.code));
    assert.doesNotMatch(stderr, /Unhandled 'error' event|Error: write EPIPE/);
  });
}
