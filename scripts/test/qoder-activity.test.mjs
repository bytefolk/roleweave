import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicQoderActivityDetail } from "../../apps/server/bin/qoder-engine.mjs";

test("Glob exposes its pattern and search directory, including supported pattern aliases", () => {
  assert.equal(publicQoderActivityDetail({ name: "Glob", input: { pattern: "**/*.tsx", path: "apps/desktop" } }), "pattern: **/*.tsx · apps/desktop");
  assert.equal(publicQoderActivityDetail({ name: "Glob", input: { glob_pattern: "src/**" } }), "pattern: src/**");
  assert.equal(publicQoderActivityDetail({ name: "Glob", input: { glob: "*.md" } }), "pattern: *.md");
});

test("Grep and Read expose bounded call context without claiming a result", () => {
  assert.equal(publicQoderActivityDetail({ name: "Grep", input: { pattern: "ProgressTrail", path: "src", glob: "*.tsx" } }), "pattern: ProgressTrail · src · files: *.tsx");
  assert.equal(publicQoderActivityDetail({ name: "Read", input: { file_path: "README.md", offset: 12, limit: 40 } }), "README.md · offset: 12 · limit: 40");
  assert.equal(publicQoderActivityDetail({ name: "Read", input: { pattern: "private-pattern", query: "private-query", command: "private-command", url: "private-url", content: "private-content", token: "private-token" } }), undefined);
  assert.equal(publicQoderActivityDetail({ name: "Bash", input: { command: "curl --header 'Authorization: secret'", description: "private-description" } }), undefined);
});

test("multilingual parameter details preserve complete characters within the public UTF-8 bound", () => {
  const pattern = "资料/" + "说明📄".repeat(300);
  const detail = publicQoderActivityDetail({ name: "Glob", input: { pattern } });
  assert.ok(detail && Buffer.byteLength(detail, "utf8") <= 2048);
  assert.ok(`pattern: ${pattern}`.startsWith(detail));
  assert.equal(Buffer.from(detail, "utf8").toString("utf8"), detail);
});

test("public search details redact recognizable credentials before the byte bound", () => {
  const secret = "trace-fixture-secret-123456789";
  for (const pattern of [`Authorization: Bearer ${secret}`, `api_key=${secret}`, `https://user:${secret}@example.test/search?token=${secret}`]) {
    const detail = publicQoderActivityDetail({ name: "Grep", input: { pattern, path: "src" } });
    assert.doesNotMatch(detail, new RegExp(secret));
    assert.match(detail, /redacted/);
    assert.match(detail, /src/);
  }
  const detail = publicQoderActivityDetail({ name: "Grep", input: { pattern: `${"x".repeat(2030)} token=${secret}` } });
  assert.doesNotMatch(detail, /trace-fixture-secret/);
  assert.ok(Buffer.byteLength(detail, "utf8") <= 2048);
});

test("Qoder stream-json keeps the actual Glob parameters on completion without publishing tool results", async (t) => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(tempRoot, "owb-qoder-public-activity-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(fixture)), tempRoot, "cleanup stays in the generated temporary fixture");
    await fs.rm(fixture, { recursive: true, force: true });
  });
  const workspace = path.join(fixture, "workspace");
  const provider = path.join(fixture, "provider");
  await fs.mkdir(workspace);
  await fs.mkdir(provider);
  await fs.writeFile(path.join(workspace, "organization.v1alpha1.json"), JSON.stringify({
    schemaVersion: "organization.v1alpha1", business: "public activity fixture", owner: "repo-owner",
    roles: [{ id: "repo-owner", name: "Owner" }, { id: "docs-writer", name: "Writer" }],
  }));
  for (const [position, name] of [["repo-owner", "repo-owner"], ["repo-owner/docs-writer", "docs-writer"]]) {
    const dir = path.join(workspace, "positions", position);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "employee.json"), JSON.stringify({ name, version: "0.1.0", description: `${name} duties`, policy: { mode: "approval_required" } }));
    await fs.writeFile(path.join(dir, "budget.json"), JSON.stringify({ perTask: { tokens: 20000, iterations: 8 }, perDay: { tokens: 200000, iterations: 64 } }));
  }
  const fakeScript = path.join(fixture, "fixture.cjs");
  await fs.writeFile(fakeScript, `#!/usr/bin/env node
const emit = value => console.log(JSON.stringify(value));
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "glob-1", name: "Glob", input: { pattern: "**/*.tsx", path: "apps/desktop", command: "private-command" } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "glob-1", content: "private-result", is_error: false }] } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: process.env.QODER_PERSONAL_ACCESS_TOKEN, path: "src" } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "grep-1", content: "private-result", is_error: false }] } });
emit({ type: "result", subtype: "success", result: "Fixture completed" });
`);
  let executable = fakeScript;
  if (process.platform === "win32") {
    executable = path.join(fixture, "qoder.cmd");
    await fs.writeFile(executable, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
  } else {
    await fs.chmod(fakeScript, 0o755);
  }
  const adapter = fileURLToPath(new URL("../../apps/server/bin/qoder-engine.mjs", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adapter, "turn", "run", workspace, "--position", "docs-writer", "--stdin"], {
      env: { ...process.env, ORG_WORKBENCH_QODER_BIN: executable, QODER_CONFIG_DIR: provider,
        QODER_PERSONAL_ACCESS_TOKEN: "fixture-qoder-provider-secret-123456789", DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder", ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ input: "Find source files" }));
  });
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.at(-1)?.type, "run.completed", result.stdout);
  const activities = events.filter(event => event.type === "trace.activity");
  assert.deepEqual(activities.map(event => ({ status: event.status, title: event.title, detail: event.detail })), [
    { status: "running", title: "Glob", detail: "pattern: **/*.tsx · apps/desktop" },
    { status: "completed", title: "Glob", detail: "pattern: **/*.tsx · apps/desktop" },
    { status: "running", title: "Grep", detail: "pattern: [REDACTED] · src" },
    { status: "completed", title: "Grep", detail: "pattern: [REDACTED] · src" },
  ]);
  assert.doesNotMatch(result.stdout, /private-command|private-result|fixture-qoder-provider-secret/);
});
