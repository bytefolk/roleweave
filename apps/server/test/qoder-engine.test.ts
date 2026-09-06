import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPosixMode } from "./helpers.js";

/** The adapter is a standalone script implementing the pinned digital-employee
 * CLI surface; tests drive it exactly like driver-cli spawns an engine. */
const ADAPTER = fileURLToPath(new URL("../../bin/qoder-engine.mjs", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runAdapter(
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER, ...args], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

const BUDGET = {
  perTask: { tokens: 20000, iterations: 8 },
  perDay: { tokens: 200000, iterations: 64 },
};

/** Byte-for-byte field values from the pinned digital-employee #194 fixture. */
function upstreamHireEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: "hire-request.v1alpha1",
    workspaceRef: "ws-main",
    packageRef: {
      name: "team-answer",
      version: "v1alpha1",
      digest: "sha256:0123456789abcdef",
    },
    targetParentId: "pos-parent-1",
    budget: {
      perTask: { tokens: 50_000, iterations: 8 },
      perDay: { tokens: 500_000 },
    },
    requestedBy: "cto",
    deadline: "2026-01-01T00:00:00Z",
    envelopeDigest: "sha256:abcdef0123456789",
  };
}

type ReadBoundedHireFile = (file: string, options?: Record<string, unknown>) => Promise<string>;

async function loadBoundedHireReader(): Promise<ReadBoundedHireFile> {
  const module = await import(pathToFileURL(ADAPTER).href) as { readBoundedHireFile: ReadBoundedHireFile };
  return module.readBoundedHireFile;
}

async function assertHireReadFailure(promise: Promise<string>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

async function writeHireEnvelope(dir: string, body: unknown): Promise<string> {
  const file = path.join(dir, "hire-request.json");
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function writePosition(dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "employee.json"),
    `${JSON.stringify({ name, version: "0.1.0", description: `${name} duties`, policy: { mode: "approval_required" } }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(dir, "budget.json"), `${JSON.stringify(BUDGET, null, 2)}\n`);
}

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-engine-"));
  await fs.writeFile(
    path.join(dir, "organization.v1alpha1.json"),
    `${JSON.stringify({
      schemaVersion: "organization.v1alpha1",
      business: "qoder-engine fixture",
      description: "adapter test workspace",
      owner: "repo-owner",
      roles: [
        { id: "repo-owner", name: "代码库负责人", description: "Owns the repo." },
        { id: "docs-writer", name: "文档负责人", description: "Keeps docs current." },
      ],
    }, null, 2)}\n`,
  );
  await writePosition(path.join(dir, "positions", "repo-owner"), "repo-owner");
  await writePosition(path.join(dir, "positions", "repo-owner", "docs-writer"), "docs-writer");
  return dir;
}

function fakeQoderOk(argsFile: string, envFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) process.exit(44);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
write({ type: "system", subtype: "init" });
write({ type: "assistant", message: { content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "正在核对" }], usage: { input_tokens: 10, output_tokens: 5 } } });
write({ type: "assistant", message: { content: [{ type: "text", text: "，门禁通过" }] } });
write({ type: "result", subtype: "success", is_error: false, result: "release gate passed", usage: { input_tokens: 100, output_tokens: 40 } });
`;
}

const FAKE_QODER_ERROR_RESULT = `#!/usr/bin/env node
const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
write({ type: "result", subtype: "error_max_turns", is_error: true, result: "qoder hit its turn cap" });
`;

const FAKE_QODER_SHELL_OK = `#!/bin/sh
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"restricted PATH reached"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"release gate passed"}'
`;

async function writeFakeQoder(dir: string, script: string): Promise<string> {
  const file = path.join(dir, "fake-qoder.cjs");
  await fs.writeFile(file, script);
  await fs.chmod(file, 0o755);
  return file;
}

test("qoder-engine Windows launcher invocation escapes untrusted argv without shell=true", async () => {
  const module = await import(pathToFileURL(ADAPTER).href) as {
    createQoderSpawnSpec: (
      command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
      platform?: NodeJS.Platform,
    ) => {
      command: string;
      args: string[];
      options: { env: NodeJS.ProcessEnv; shell: boolean; windowsVerbatimArguments?: boolean };
    };
  };
  const prompt = 'review "release" & whoami | echo injected > marker.txt';
  const spec = module.createQoderSpawnSpec(
    "C:\\Users\\Alice\\AppData\\Local\\Qoder\\qoder.cmd",
    ["-p", prompt],
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    "win32",
  );

  assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.windowsVerbatimArguments, true);
  assert.match(spec.args[3]!, /\^&/);
  assert.match(spec.args[3]!, /\^\|/);
  assert.match(spec.args[3]!, /\^>/);
  assert.doesNotMatch(spec.args[3]!, / & whoami/);
});

test("qoder-engine: --version satisfies the driver probe surface", async () => {
  const result = await runAdapter(["--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^qoder-engine \d+\.\d+\.\d+$/);
});

test("qoder-engine hire validate: help advertises the bounded static contract", async () => {
  const result = await runAdapter(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /hire validate <file> --json/);
});

test("qoder-engine hire validate: accepts the pinned upstream opaque-digest fixture without effects", async (t) => {
  const workspace = await makeWorkspace();
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-"));
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(fixtureDir, { recursive: true, force: true }),
  ]));
  const envelope = upstreamHireEnvelope();
  const file = await writeHireEnvelope(fixtureDir, envelope);
  const marker = path.join(fixtureDir, "qoder-spawned");
  const fakeQoder = await writeFakeQoder(
    fixtureDir,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.FAKE_QODER_SPAWN_MARKER, "spawned");\n`,
  );
  const before = await fs.readdir(path.join(workspace, "positions", "repo-owner"));

  const result = await runAdapter(["hire", "validate", file, "--json"], {
    env: { ORG_WORKBENCH_QODER_BIN: fakeQoder, FAKE_QODER_SPAWN_MARKER: marker },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "valid", hire: envelope });
  assert.equal(await exists(marker), false, "static hire validation never starts Qoder");
  assert.deepEqual(await fs.readdir(path.join(workspace, "positions", "repo-owner")), before);
  assert.equal(await exists(path.join(workspace, ".digital-employee")), false);
});

test("qoder-engine hire validate: preserves valid Unicode in bounded string fields", async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-unicode-"));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const envelope = {
    ...upstreamHireEnvelope(),
    workspaceRef: "工作区/研发",
    targetParentId: "岗位/负责人",
    requestedBy: "产品负责人·修雨",
  };
  const file = await writeHireEnvelope(fixtureDir, envelope);

  const result = await runAdapter(["hire", "validate", file, "--json"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "valid", hire: envelope });
});

test("qoder-engine hire validate: malformed and too-short opaque digests fail closed before any effect", async (t) => {
  const workspace = await makeWorkspace();
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-invalid-"));
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(fixtureDir, { recursive: true, force: true }),
  ]));
  const marker = path.join(fixtureDir, "qoder-spawned");
  const fakeQoder = await writeFakeQoder(
    fixtureDir,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.FAKE_QODER_SPAWN_MARKER, "spawned");\n`,
  );
  const before = await fs.readdir(path.join(workspace, "positions", "repo-owner"));
  const cases: Array<{ name: string; body: Record<string, unknown>; code: string }> = [
    {
      name: "unknown root field",
      body: { ...upstreamHireEnvelope(), approvedBy: "operator" },
      code: "hire_request_unknown_field:approvedBy",
    },
    {
      name: "missing budget",
      body: (() => {
        const body = upstreamHireEnvelope();
        delete body.budget;
        return body;
      })(),
      code: "hire_request_missing_budget",
    },
    {
      name: "invalid deadline",
      body: { ...upstreamHireEnvelope(), deadline: "not-a-date" },
      code: "hire_request_invalid_field:deadline",
    },
    {
      name: "opaque digest shorter than 16 characters",
      body: {
        ...upstreamHireEnvelope(),
        envelopeDigest: "123456789012345",
      },
      code: "hire_request_invalid_field:envelopeDigest",
    },
  ];

  for (const testCase of cases) {
    const file = await writeHireEnvelope(fixtureDir, testCase.body);
    const result = await runAdapter(["hire", "validate", file, "--json"], {
      env: { ORG_WORKBENCH_QODER_BIN: fakeQoder, FAKE_QODER_SPAWN_MARKER: marker },
    });
    assert.equal(result.code, 1, testCase.name);
    assert.deepEqual(JSON.parse(result.stdout), { status: "failed", code: testCase.code }, testCase.name);
  }

  const malformed = path.join(fixtureDir, "malformed.json");
  await fs.writeFile(malformed, "{not-json", { mode: 0o600 });
  const malformedResult = await runAdapter(["hire", "validate", malformed, "--json"]);
  assert.equal(malformedResult.code, 1);
  assert.deepEqual(JSON.parse(malformedResult.stdout), { status: "failed", code: "hire_request_invalid_json" });

  const malformedUtf8 = path.join(fixtureDir, "malformed-utf8.json");
  const markerBytes = Buffer.from("INVALID_UTF8_MARKER", "utf8");
  const otherwiseValid = Buffer.from(JSON.stringify({
    ...upstreamHireEnvelope(),
    requestedBy: markerBytes.toString("utf8"),
  }), "utf8");
  const markerOffset = otherwiseValid.indexOf(markerBytes);
  assert.notEqual(markerOffset, -1);
  await fs.writeFile(malformedUtf8, Buffer.concat([
    otherwiseValid.subarray(0, markerOffset),
    Buffer.from([0x80]),
    otherwiseValid.subarray(markerOffset + markerBytes.length),
    Buffer.from("\n", "utf8"),
  ]), { mode: 0o600 });
  const malformedUtf8Result = await runAdapter(["hire", "validate", malformedUtf8, "--json"], {
    env: { ORG_WORKBENCH_QODER_BIN: fakeQoder, FAKE_QODER_SPAWN_MARKER: marker },
  });
  assert.equal(malformedUtf8Result.code, 1);
  assert.deepEqual(JSON.parse(malformedUtf8Result.stdout), { status: "failed", code: "hire_request_invalid_json" });
  assert.equal(malformedUtf8Result.stderr, "", "fatal UTF-8 failure does not disclose request bytes");

  const symlink = path.join(fixtureDir, "hire-request-link.json");
  await fs.symlink(malformed, symlink);
  const symlinkResult = await runAdapter(["hire", "validate", symlink, "--json"]);
  assert.equal(symlinkResult.code, 1);
  assert.deepEqual(JSON.parse(symlinkResult.stdout), { status: "failed", code: "hire_request_file_unreadable" });

  const missingResult = await runAdapter(["hire", "validate", path.join(fixtureDir, "missing.json"), "--json"]);
  assert.equal(missingResult.code, 1);
  assert.deepEqual(JSON.parse(missingResult.stdout), { status: "failed", code: "hire_request_file_unreadable" });

  const directoryResult = await runAdapter(["hire", "validate", fixtureDir, "--json"]);
  assert.equal(directoryResult.code, 1);
  assert.deepEqual(JSON.parse(directoryResult.stdout), { status: "failed", code: "hire_request_file_unreadable" });

  const oversized = path.join(fixtureDir, "oversized.json");
  await fs.writeFile(oversized, " ".repeat(256 * 1024 + 1), { mode: 0o600 });
  const oversizedResult = await runAdapter(["hire", "validate", oversized, "--json"]);
  assert.equal(oversizedResult.code, 1);
  assert.deepEqual(JSON.parse(oversizedResult.stdout), { status: "failed", code: "hire_request_too_large" });

  assert.equal(await exists(marker), false, "rejected hire envelopes never start Qoder");
  assert.deepEqual(await fs.readdir(path.join(workspace, "positions", "repo-owner")), before);
  assert.equal(await exists(path.join(workspace, ".digital-employee")), false);
});

test("qoder-engine hire read: deterministic pathname replacement race fails closed", async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-race-"));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const requested = await writeHireEnvelope(fixtureDir, upstreamHireEnvelope());
  const replacement = path.join(fixtureDir, "replacement.json");
  const displaced = path.join(fixtureDir, "displaced.json");
  await fs.writeFile(replacement, `${JSON.stringify({ ...upstreamHireEnvelope(), requestedBy: "replacement" })}\n`, { mode: 0o600 });
  const readBoundedHireFile = await loadBoundedHireReader();

  await assertHireReadFailure(
    readBoundedHireFile(requested, {
      hooks: {
        beforeOpen: async () => {
          await fs.rename(requested, displaced);
          await fs.rename(replacement, requested);
        },
      },
    }),
    "hire_request_file_unreadable",
  );
});

test("qoder-engine hire read: concurrent growth is detected by the MAX+1 positional read", async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-growth-"));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const requested = await writeHireEnvelope(fixtureDir, upstreamHireEnvelope());
  const readBoundedHireFile = await loadBoundedHireReader();
  let grown = false;

  await assertHireReadFailure(
    readBoundedHireFile(requested, {
      hooks: {
        afterReadChunk: async () => {
          if (grown) return;
          grown = true;
          await fs.appendFile(requested, Buffer.alloc(256 * 1024 + 1, 0x20));
        },
      },
    }),
    "hire_request_too_large",
  );
  assert.equal(grown, true);
});

test("qoder-engine hire read: same-inode same-length rewrite fails closed before effects", async (t) => {
  const workspace = await makeWorkspace();
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-rewrite-"));
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(fixtureDir, { recursive: true, force: true }),
  ]));
  const requested = await writeHireEnvelope(fixtureDir, upstreamHireEnvelope());
  const original = await fs.readFile(requested, "utf8");
  const replacement = original.replace('"requestedBy": "cto"', '"requestedBy": "bot"');
  assert.notEqual(replacement, original);
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  const beforeRequest = await fs.lstat(requested, { bigint: true });
  const beforeWorkspace = await fs.readdir(path.join(workspace, "positions", "repo-owner"));
  const qoderMarker = path.join(fixtureDir, "qoder-spawned");
  const readBoundedHireFile = await loadBoundedHireReader();
  let rewritten = false;

  await assertHireReadFailure(
    readBoundedHireFile(requested, {
      hooks: {
        afterReadChunk: async () => {
          if (rewritten) return;
          rewritten = true;
          const writer = await fs.open(requested, "r+");
          try {
            const bytes = Buffer.from(replacement);
            await writer.write(bytes, 0, bytes.length, 0);
            await writer.sync();
            await writer.utimes(new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
          } finally {
            await writer.close();
          }
          const afterRequest = await fs.lstat(requested, { bigint: true });
          assert.equal(afterRequest.dev, beforeRequest.dev);
          assert.equal(afterRequest.ino, beforeRequest.ino);
          assert.equal(afterRequest.size, beforeRequest.size);
          assert.notEqual(afterRequest.mtimeNs, beforeRequest.mtimeNs);
          assert.notEqual(afterRequest.ctimeNs, beforeRequest.ctimeNs);
        },
      },
    }),
    "hire_request_file_unreadable",
  );
  assert.equal(rewritten, true);
  assert.equal(await exists(qoderMarker), false, "rejected rewrite never starts Qoder");
  assert.deepEqual(await fs.readdir(path.join(workspace, "positions", "repo-owner")), beforeWorkspace);
  assert.equal(await exists(path.join(workspace, ".digital-employee")), false);
});

test("qoder-engine hire read: Windows/no-O_NOFOLLOW fallback remains bounded and fail-closed", async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-hire-win-"));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const requested = await writeHireEnvelope(fixtureDir, upstreamHireEnvelope());
  const expected = await fs.readFile(requested, "utf8");
  const readBoundedHireFile = await loadBoundedHireReader();
  let windowsFlags: number | undefined;

  const actual = await readBoundedHireFile(requested, {
    platform: "win32",
    constants: { O_RDONLY: fsConstants.O_RDONLY },
    hooks: { beforeOpen: ({ flags }: { flags: number }) => { windowsFlags = flags; } },
  });
  assert.equal(actual, expected);
  assert.equal(windowsFlags, fsConstants.O_RDONLY, "Windows fallback adds neither unavailable O_NOFOLLOW nor O_NONBLOCK");

  if (fsConstants.O_NONBLOCK !== undefined) {
    let posixFlags: number | undefined;
    await readBoundedHireFile(requested, {
      platform: "darwin",
      constants: { O_RDONLY: fsConstants.O_RDONLY, O_NONBLOCK: fsConstants.O_NONBLOCK },
      hooks: { beforeOpen: ({ flags }: { flags: number }) => { posixFlags = flags; } },
    });
    assert.equal((posixFlags ?? 0) & fsConstants.O_NONBLOCK, fsConstants.O_NONBLOCK, "POSIX adds O_NONBLOCK when available");
  }

  const replacement = path.join(fixtureDir, "windows-replacement.json");
  const displaced = path.join(fixtureDir, "windows-displaced.json");
  await fs.writeFile(replacement, `${JSON.stringify({ ...upstreamHireEnvelope(), requestedBy: "replacement" })}\n`, { mode: 0o600 });
  await assertHireReadFailure(
    readBoundedHireFile(requested, {
      platform: "win32",
      constants: { O_RDONLY: fsConstants.O_RDONLY },
      hooks: {
        beforeOpen: async () => {
          await fs.rename(requested, displaced);
          await fs.rename(replacement, requested);
        },
      },
    }),
    "hire_request_file_unreadable",
  );
});

test("qoder-engine org apply: bootstrap writes 0600 applied state and reports EngineOrgApplySuccess", async () => {
  const dir = await makeWorkspace();
  const result = await runAdapter(["org", "apply", dir, "--json"]);
  assert.equal(result.code, 0);
  const applied = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(applied.status, "applied");
  assert.equal(applied.bootstrapped, true);
  assert.equal(applied.positions, 2);
  assert.equal(applied.owner, "repo-owner");
  assert.deepEqual([...(applied.changes as { hired: string[] }).hired].sort(), ["docs-writer", "repo-owner"]);
  assert.match(String(applied.organization), /^sha256:[0-9a-f]{64}$/);

  const runtime = path.join(dir, ".digital-employee");
  await assertPosixMode(path.join(runtime, "org.json"), 0o600);
  const model = JSON.parse(await fs.readFile(path.join(runtime, "org.json"), "utf8")) as { roles: Array<{ id: string; reportTo: string | null; name: string }> };
  const docs = model.roles.find((role) => role.id === "docs-writer");
  assert.equal(docs?.reportTo, "repo-owner");
  assert.equal(docs?.name, "文档负责人", "declared role names win over raw ids");
  const audits = (await fs.readFile(path.join(runtime, "org-audit.jsonl"), "utf8")).trim().split("\n");
  assert.equal(audits.length, 1);
  // The reports route projects org-audit.v1 hired/dismissed as full role
  // objects; the audit line must carry them (contract mirror).
  const audit = JSON.parse(audits[0]!) as {
    changes: { hired: Array<{ id: string; name: string; package: { digest: string }; budget: { perTask: { tokens: number } } }>; dismissed: unknown[] };
  };
  const hiredIds = audit.changes.hired.map((role) => role.id).sort();
  assert.deepEqual(hiredIds, ["docs-writer", "repo-owner"]);
  for (const role of audit.changes.hired) {
    assert.match(role.package.digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(role.budget.perTask.tokens > 0);
  }
  await assertPosixMode(path.join(runtime, "permissions.json"), 0o600);
});

test("qoder-engine org apply: a moved position is diffed against the previous applied state", async () => {
  const dir = await makeWorkspace();
  await runAdapter(["org", "apply", dir, "--json"]);
  await fs.rename(path.join(dir, "positions", "repo-owner", "docs-writer"), path.join(dir, "positions", "docs-writer"));
  const result = await runAdapter(["org", "apply", dir, "--json"]);
  const applied = JSON.parse(result.stdout) as { bootstrapped: boolean; changes: { hired: string[]; moved: Array<{ id: string; from: string | null; to: string | null }>; dismissed: string[] } };
  assert.equal(applied.bootstrapped, false);
  assert.deepEqual(applied.changes.hired, []);
  assert.deepEqual(applied.changes.dismissed, []);
  assert.deepEqual(applied.changes.moved, [{ id: "docs-writer", from: "repo-owner", to: null }]);
});

test("qoder-engine org apply: a stray top-level directory fails with the actionable scan error", async () => {
  const dir = await makeWorkspace();
  await fs.mkdir(path.join(dir, "positions", "client-lead"), { recursive: true });
  const result = await runAdapter(["org", "apply", dir, "--json"]);
  assert.equal(result.code, 0, "engine failures print status=failed and exit 0");
  const failed = JSON.parse(result.stdout) as { status: string; code: string; message: string };
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "qoder.org_apply_failed");
  assert.match(failed.message, /invalid top-level position entry: client-lead/);
});

test("qoder-engine turn run: maps qoder stream-json into engine.v1 events and passes --agent <position>", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture; the Windows package smoke leg covers the win32 .cmd spawn path" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-fake-qoder-"));
  const argsFile = path.join(fakeDir, "args.json");
  const envFile = path.join(fakeDir, "env.json");
  const fakeBin = await writeFakeQoder(fakeDir, fakeQoderOk(argsFile, envFile));
  const inheritedPath = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const qoderRuntimeEnvironment = {
    LOGNAME: "qoder-user",
    TMP: path.join(fakeDir, "tmp"),
    TEMP: path.join(fakeDir, "temp"),
    LC_CTYPE: "en_US.UTF-8",
    XDG_CONFIG_HOME: path.join(fakeDir, "config"),
    XDG_CACHE_HOME: path.join(fakeDir, "cache"),
    HTTP_PROXY: "http://127.0.0.1:9001",
    HTTPS_PROXY: "http://127.0.0.1:9002",
    NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "http://127.0.0.1:9003",
    https_proxy: "http://127.0.0.1:9004",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "",
    SSL_CERT_FILE: path.join(fakeDir, "ca.pem"),
    SSL_CERT_DIR: path.join(fakeDir, "certs"),
  };
  const result = await runAdapter(["turn", "run", dir, "--position", "docs-writer", "--stdin"], {
    stdin: JSON.stringify({ input: "检查发布门禁" }),
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ORG_WORKBENCH_QODER_BIN: fakeBin,
      ORG_WORKBENCH_QODER_PERMISSION_MODE: "auto",
      ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE: "1",
      ORG_WORKBENCH_BOOT_TOKEN: "boot-secret",
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder",
      CONTEXT_RUNTIME_TOKEN: "context-secret",
      CONTEXT_VAULT: "/private/context-vault",
      ARBITRARY_SECRET: "arbitrary-secret",
      QODER_PERSONAL_ACCESS_TOKEN: "qoder-credential",
      PATH: inheritedPath,
      ...qoderRuntimeEnvironment,
    },
  });
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events[0]?.type, "run.started");
  const runId = events[0]?.runId;
  assert.ok(events.every((event) => event.runId === runId), "one runId per turn");
  assert.deepEqual(
    events.filter((event) => event.type === "model.delta").map((event) => event.text),
    ["正在核对", "，门禁通过"],
  );
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual({ input: usage?.inputTokens, output: usage?.outputTokens }, { input: 100, output: 40 });
  const completed = events.at(-1);
  assert.equal(completed?.type, "run.completed");
  assert.equal(completed?.output, "release gate passed");
  assert.equal(completed?.terminalReason, "goal_met");

  const qoderArgs = JSON.parse(await fs.readFile(argsFile, "utf8")) as string[];
  assert.ok(qoderArgs.includes("-w") && qoderArgs[qoderArgs.indexOf("-w") + 1] === dir);
  assert.ok(qoderArgs.includes("--agent") && qoderArgs[qoderArgs.indexOf("--agent") + 1] === "docs-writer");
  assert.ok(qoderArgs.includes("--permission-mode") && qoderArgs[qoderArgs.indexOf("--permission-mode") + 1] === "auto");
  assert.equal(qoderArgs.at(-1), "检查发布门禁", "envelope input becomes the qoder prompt");
  const qoderEnv = JSON.parse(await fs.readFile(envFile, "utf8")) as Record<string, string>;
  assert.equal(qoderEnv.PATH, inheritedPath, "qoder-engine must not replace or truncate the inherited user PATH");
  assert.equal(qoderEnv.QODER_PERSONAL_ACCESS_TOKEN, "qoder-credential");
  for (const [key, value] of Object.entries(qoderRuntimeEnvironment)) {
    assert.equal(qoderEnv[key], value, `${key} must reach the real Qoder/MCP runtime`);
  }
  for (const forbidden of [
    "ELECTRON_RUN_AS_NODE",
    "ORG_WORKBENCH_QODER_BIN",
    "ORG_WORKBENCH_QODER_PERMISSION_MODE",
    "ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE",
    "ORG_WORKBENCH_BOOT_TOKEN",
    "DIGITAL_EMPLOYEE_ENGINE_MODEL",
    "CONTEXT_RUNTIME_TOKEN",
    "CONTEXT_VAULT",
    "ARBITRARY_SECRET",
  ]) {
    assert.equal(forbidden in qoderEnv, false, `${forbidden} reached Qoder or its MCP descendants`);
  }
});

test("qoder-engine turn run: an unsupported permission mode fails before spawning Qoder", async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-mode-"));
  const fakeBin = await writeFakeQoder(fakeDir, "#!/usr/bin/env node\nprocess.exit(91);\n");
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hi" }),
    env: {
      ORG_WORKBENCH_QODER_BIN: fakeBin,
      ORG_WORKBENCH_QODER_PERMISSION_MODE: "unrestricted",
    },
  });
  assert.equal(result.code, 0);
  const failed = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.type === "run.failed");
  assert.equal((failed?.error as { code: string }).code, "qoder.permission_mode_invalid");
  assert.equal((failed?.error as { retryable: boolean }).retryable, false);
});

test("qoder-engine turn run uses the same PATH resolver without an explicit binary override", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture; the Windows package smoke leg covers the win32 .cmd spawn path" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-qoder-path-"));
  const fakeBin = path.join(fakeDir, "qodercli");
  await fs.writeFile(fakeBin, FAKE_QODER_SHELL_OK, { mode: 0o755 });
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "restricted PATH smoke" }),
    env: {
      ORG_WORKBENCH_QODER_BIN: "",
      PATH: `${fakeDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: path.join(fakeDir, "empty-home"),
    },
  });
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.equal(events.at(-1)?.output, "release gate passed");
});

test("qoder-engine turn run: an error result becomes run.failed with retryable=false", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture; the Windows package smoke leg covers the win32 .cmd spawn path" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-fake-qoder-"));
  const fakeBin = await writeFakeQoder(fakeDir, FAKE_QODER_ERROR_RESULT);
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hi" }),
    env: { ORG_WORKBENCH_QODER_BIN: fakeBin },
  });
  assert.equal(result.code, 0);
  const failed = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.type === "run.failed");
  assert.equal((failed?.error as { code: string }).code, "qoder.result_error");
  assert.equal((failed?.error as { message: string }).message, "qoder hit its turn cap");
  assert.equal((failed?.error as { retryable: boolean }).retryable, false);
});

test("qoder-engine turn run: a missing qoder binary is turn_engine_unavailable and retryable", async () => {
  const dir = await makeWorkspace();
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hi" }),
    env: { ORG_WORKBENCH_QODER_BIN: path.join(dir, "does-not-exist") },
  });
  assert.equal(result.code, 0);
  const failed = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.type === "run.failed");
  assert.equal((failed?.error as { code: string }).code, "turn_engine_unavailable");
  assert.equal((failed?.error as { retryable: boolean }).retryable, true);
});

test("qoder-engine turn run: an unspawnable resolved binary never discloses its absolute path", async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-unspawnable-qoder-"));
  const fakeBin = path.join(fakeDir, "private-qoder-location");
  await fs.writeFile(fakeBin, "#!/definitely/missing/qoder-interpreter\n", { mode: 0o755 });
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hi" }),
    env: { ORG_WORKBENCH_QODER_BIN: fakeBin },
  });
  assert.equal(result.code, 0);
  const failed = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.type === "run.failed");
  assert.equal((failed?.error as { code: string }).code, "turn_engine_unavailable");
  assert.equal((failed?.error as { retryable: boolean }).retryable, true);
  assert.doesNotMatch(result.stdout, new RegExp(fakeBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

function fakeClaudeOk(argsFile: string, envFile: string, stdinFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdinData += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, stdinData);
  const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  write({ type: "system", subtype: "init", session_id: "test-session", claude_code_version: "2.1.300", permissionMode: "dontAsk", tools: [], mcp_servers: [], apiKeySource: "ANTHROPIC_API_KEY" });
  write({ type: "assistant", message: { content: [{ type: "text", text: "Hello from" }] } });
  write({ type: "assistant", message: { content: [{ type: "text", text: "Hello from Claude" }] } });
  write({ type: "result", subtype: "success", is_error: false, result: "claude output", usage: { input_tokens: 50, output_tokens: 20 } });
});
`;
}

async function writeFakeClaude(dir: string, script: string): Promise<string> {
  const file = path.join(dir, "fake-claude.cjs");
  await fs.writeFile(file, script);
  await fs.chmod(file, 0o755);
  return file;
}

const FAKE_CLAUDE_VERSION_SCRIPT = `#!/usr/bin/env node
console.log("2.1.300");
`;

test("qoder-engine turn run: claude-code dispatches to Claude binary, never Qoder", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-fake-claude-"));
  const argsFile = path.join(fakeDir, "claude-args.json");
  const envFile = path.join(fakeDir, "claude-env.json");
  const stdinFile = path.join(fakeDir, "claude-stdin.txt");
  const fakeClaude = await writeFakeClaude(fakeDir, fakeClaudeOk(argsFile, envFile, stdinFile));

  const qoderStub = path.join(fakeDir, "qoder-stub.cjs");
  await fs.writeFile(qoderStub, "#!/usr/bin/env node\nprocess.stderr.write(\"QODER_SHOULD_NOT_BE_CALLED\\n\");process.exit(1);\n");
  await fs.chmod(qoderStub, 0o755);

  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hello from test" }),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-code",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: fakeClaude,
      ORG_WORKBENCH_QODER_BIN: qoderStub,
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: "https://proxy.example.com/v1",
      QODER_PERSONAL_ACCESS_TOKEN: "qoder-secret",
      CONTEXT_RUNTIME_TOKEN: "context-secret",
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(result.code, 0);

  assert.doesNotMatch(result.stderr, /QODER_SHOULD_NOT_BE_CALLED/, "claude-code turn must never reach the Qoder binary");
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const failedEvent = events.find((event) => event.type === "run.failed");
  assert.equal(failedEvent, undefined, "claude-code turn must not emit run.failed");
  assert.equal(events[0]?.type, "run.started");
  const runId = events[0]?.runId;
  assert.ok(events.every((event) => event.runId === runId), "one runId per turn");

  const deltas = events.filter((event) => event.type === "model.delta").map((event) => event.text);
  assert.deepEqual(deltas, ["Hello from", " Claude"]);

  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual({ input: usage?.inputTokens, output: usage?.outputTokens }, { input: 50, output: 20 });

  const completed = events.at(-1);
  assert.equal(completed?.type, "run.completed");
  assert.equal(completed?.output, "claude output");

  const claudeArgs = JSON.parse(await fs.readFile(argsFile, "utf8")) as string[];
  assert.ok(claudeArgs.includes("--bare"));
  assert.ok(claudeArgs.includes("--print"));
  assert.ok(claudeArgs.includes("--permission-mode"));
  assert.equal(claudeArgs[claudeArgs.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(claudeArgs.includes("--max-turns"));
  assert.equal(claudeArgs[claudeArgs.indexOf("--max-turns") + 1], "1");

  const claudeEnv = JSON.parse(await fs.readFile(envFile, "utf8")) as Record<string, string>;
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, "test-key");
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, "https://proxy.example.com/v1");
  assert.equal(claudeEnv.QODER_PERSONAL_ACCESS_TOKEN, undefined, "claude-code child must not receive Qoder credentials");
  assert.equal(claudeEnv.CONTEXT_RUNTIME_TOKEN, undefined, "claude-code child must not receive context tokens");

  const stdinContent = await fs.readFile(stdinFile, "utf8");
  assert.ok(stdinContent.includes("hello from test"), "input is piped to Claude stdin");
});

test("qoder-engine turn run: claude-local dispatches to Claude without service credentials", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-fake-claude-local-"));
  const argsFile = path.join(fakeDir, "claude-args.json");
  const envFile = path.join(fakeDir, "claude-env.json");
  const stdinFile = path.join(fakeDir, "claude-stdin.txt");
  const fakeClaude = await writeFakeClaude(fakeDir, fakeClaudeOk(argsFile, envFile, stdinFile));

  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "local test" }),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-local",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: fakeClaude,
      ANTHROPIC_API_KEY: "should-not-leak",
      ANTHROPIC_BASE_URL: "https://should-not-leak.example.com",
      QODER_PERSONAL_ACCESS_TOKEN: "also-should-not-leak",
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.at(-1)?.type, "run.completed");

  const claudeEnv = JSON.parse(await fs.readFile(envFile, "utf8")) as Record<string, string>;
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, undefined, "claude-local must not receive ANTHROPIC_API_KEY");
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, undefined, "claude-local must not receive ANTHROPIC_BASE_URL");
  assert.equal(claudeEnv.QODER_PERSONAL_ACCESS_TOKEN, undefined, "claude-local must not receive Qoder credentials");
  assert.equal(claudeEnv.DIGITAL_EMPLOYEE_CLAUDE_COMMAND, fakeClaude, "claude-local receives the binary override");
});

test("qoder-engine turn run: claude-code fails closed when Claude binary is missing", async () => {
  const dir = await makeWorkspace();
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hi" }),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-code",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: "/nonexistent/claude-binary",
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
    },
  });
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events[0]?.type, "run.started");
  const failed = events.find((event) => event.type === "run.failed");
  assert.ok(failed, "must emit run.failed when binary is missing");
  assert.equal((failed?.error as { code: string }).code, "claude.binary_unresolved");
  assert.equal((failed?.error as { retryable: boolean }).retryable, false);
});

test("qoder-engine turn run: claude-code escapes @ in input to prevent mention expansion", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-claude-at-escape-"));
  const argsFile = path.join(fakeDir, "claude-args.json");
  const envFile = path.join(fakeDir, "claude-env.json");
  const stdinFile = path.join(fakeDir, "claude-stdin.txt");
  const fakeClaude = await writeFakeClaude(fakeDir, fakeClaudeOk(argsFile, envFile, stdinFile));

  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hello @user please review" }),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-code",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: fakeClaude,
      ANTHROPIC_API_KEY: "test-key",
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(result.code, 0);
  const stdinContent = await fs.readFile(stdinFile, "utf8");
  assert.ok(!stdinContent.includes("@user"), "@ must be escaped");
  assert.ok(stdinContent.includes("\\u0040user"), "@ must be escaped to \\u0040");
});

test("qoder-engine turn run: claude-code rejects version 2.2.0 (ceiling)", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-claude-ceiling-"));
  const fakeClaude = await writeFakeClaude(fakeDir, `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("2.2.0"); process.exit(0); }\nprocess.exit(1);\n`);

  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "hello" }),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-code",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: fakeClaude,
      ANTHROPIC_API_KEY: "test-key",
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const failed = events.find((event) => event.type === "run.failed");
  assert.ok(failed, "must emit run.failed for version 2.2.0");
  assert.equal((failed?.error as { code: string }).code, "claude.version_unsupported");
  assert.equal((failed?.error as { retryable: boolean }).retryable, false);
});

test("qoder-engine turn run: default engine model is qoder when DIGITAL_EMPLOYEE_ENGINE_MODEL is unset", { skip: process.platform === "win32" ? "requires POSIX exec of a shebang fixture" : false }, async () => {
  const dir = await makeWorkspace();
  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-default-engine-"));
  const argsFile = path.join(fakeDir, "args.json");
  const envFile = path.join(fakeDir, "env.json");
  const fakeBin = await writeFakeQoder(fakeDir, fakeQoderOk(argsFile, envFile));
  const result = await runAdapter(["turn", "run", dir, "--position", "repo-owner", "--stdin"], {
    stdin: JSON.stringify({ input: "default engine test" }),
    env: {
      ORG_WORKBENCH_QODER_BIN: fakeBin,
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.at(-1)?.type, "run.completed");
  const qoderArgs = JSON.parse(await fs.readFile(argsFile, "utf8")) as string[];
  assert.ok(qoderArgs.includes("--agent"), "default engine must spawn Qoder with --agent");
});
