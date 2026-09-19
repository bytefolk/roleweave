import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGeminiClient, resolveGeminiExecutable } from "../src/gemini-binary.js";

async function executable(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return fs.realpath(file);
}

test("Gemini client resolver prefers Gemini CLI and falls back to Antigravity CLI", async (t) => {
  if (process.platform === "win32") return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-gemini-resolver-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const agy = await executable(dir, "agy");

  assert.deepEqual(resolveGeminiClient({ PATH: dir }), { command: agy, client: "antigravity" });
  const gemini = await executable(dir, "gemini");
  assert.deepEqual(resolveGeminiClient({ PATH: dir }), { command: gemini, client: "gemini" });
  assert.equal(resolveGeminiExecutable({ PATH: dir }), gemini);
});

test("explicit wrappers can select either supported client protocol", async (t) => {
  if (process.platform === "win32") return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-gemini-wrapper-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const wrapper = await executable(dir, "google-agent-wrapper");

  assert.deepEqual(resolveGeminiClient({
    PATH: dir,
    DIGITAL_EMPLOYEE_GEMINI_COMMAND: wrapper,
    DIGITAL_EMPLOYEE_GEMINI_CLIENT: "antigravity",
  }), { command: wrapper, client: "antigravity" });
  assert.equal(resolveGeminiClient({
    PATH: dir,
    DIGITAL_EMPLOYEE_GEMINI_COMMAND: wrapper,
    DIGITAL_EMPLOYEE_GEMINI_CLIENT: "unsupported",
  }), null);
});
