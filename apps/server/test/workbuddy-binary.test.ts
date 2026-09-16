import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkbuddyExecutable, validatedWorkbuddyModel } from "../src/workbuddy-binary.js";
import { workbuddyVersionProfile } from "../src/workbuddy-runtime.js";

test("WorkBuddy resolver respects authoritative overrides and executable symlink targets", { skip: process.platform === "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-workbuddy-resolver-"));
  try {
    const binary = path.join(root, "codebuddy");
    const link = path.join(root, "cbc");
    await fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink(binary, link);
    const env = { PATH: root, HOME: root };
    assert.equal(resolveWorkbuddyExecutable(env, "linux"), await fs.realpath(binary));
    assert.equal(resolveWorkbuddyExecutable({ ...env, DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: link }), await fs.realpath(binary));
    assert.equal(resolveWorkbuddyExecutable({ ...env, DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: "cbc" }), await fs.realpath(binary));
    for (const override of [path.join(root, "absent"), root, "invalid\0name"]) assert.equal(resolveWorkbuddyExecutable({ ...env, DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: override }), null);
    await fs.chmod(binary, 0o600);
    assert.equal(resolveWorkbuddyExecutable({ ...env, DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND: link }), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("WorkBuddy resolver finds its per-user desktop CLI when PATH is empty", { skip: process.platform === "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-workbuddy-install-"));
  try {
    const binary = path.join(root, "Applications", "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveWorkbuddyExecutable({ PATH: "", HOME: root }, "darwin"), await fs.realpath(binary));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("WorkBuddy model identifiers and version profiles reject non-authoritative values", () => {
  assert.equal(validatedWorkbuddyModel("model:production/v2"), "model:production/v2");
  for (const model of ["--model", "bad\nmodel", "x".repeat(257)]) assert.equal(validatedWorkbuddyModel(model), null);
  for (const version of ["__proto__", "constructor", "2.137.1-beta", "2.137.2", "2.106.5"]) assert.equal(workbuddyVersionProfile(version), null);
  for (const version of ["2.106.4", "2.137.1"]) {
    const profile = workbuddyVersionProfile(version);
    assert.ok(profile?.disallowedTools.includes("Bash"));
    assert.ok(profile?.disallowedTools.includes("PowerShell"));
    assert.ok(profile?.disallowedTools.includes("Skill"));
    assert.ok(profile?.disallowedTools.includes("ListMcpResources"));
  }
});
