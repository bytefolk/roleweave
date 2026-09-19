import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { qoderLoginState, resetQoderLoginState, startQoderLogin } from "../src/routes/qoder-login.js";

// The one-click login flow spawns the operator's own Qoder CLI; these cases use
// a fake executable so no real credential or browser is ever touched.

const LOGIN_URL = "https://example.test/login?code=abc123";

async function writeFakeQoderCli(directory: string): Promise<string> {
  const bin = path.join(directory, "qodercli");
  await fs.writeFile(
    bin,
    `#!/bin/sh\nif [ "$1" = "login" ]; then echo "open ${LOGIN_URL}"; sleep 0.3; exit 0; fi\nexit 0\n`,
    "utf8",
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for the login state");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("startQoderLogin runs the resolved CLI login once and exposes its printed URL only while running", async () => {
  if (process.platform === "win32") return; // the fake CLI is a POSIX shell script
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-qoder-login-"));
  try {
    const bin = await writeFakeQoderCli(directory);
    resetQoderLoginState();
    const env = { ORG_WORKBENCH_QODER_BIN: bin } as NodeJS.ProcessEnv;
    const started = startQoderLogin(env);
    assert.equal(started.running, true);
    assert.equal(started.exitCode, null);
    await waitFor(() => qoderLoginState().loginUrl === LOGIN_URL);
    // A second start while the child lives must reuse it, not spawn a parallel login.
    const again = startQoderLogin(env);
    assert.equal(again.startedAt, started.startedAt);
    await waitFor(() => qoderLoginState().running === false);
    const finished = qoderLoginState();
    assert.equal(finished.exitCode, 0);
    // The live login URL is dropped with the process; a stale authorization
    // address must never be served after the child exits.
    assert.equal(finished.loginUrl, undefined);
  } finally {
    resetQoderLoginState();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("startQoderLogin fails closed when no executable Qoder CLI resolves", () => {
  resetQoderLoginState();
  const state = startQoderLogin({
    ORG_WORKBENCH_QODER_BIN: path.join(os.tmpdir(), "roleweave-missing-qodercli"),
  } as NodeJS.ProcessEnv);
  assert.equal(state.running, false);
  assert.equal(state.failure, "binary_unavailable");
  resetQoderLoginState();
});
