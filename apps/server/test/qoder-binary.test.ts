import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { resolveQoderExecutable } from "../src/qoder-binary.js";
import { QoderModelCatalog } from "../src/qoder-model-catalog.js";
import { probeQoderLocalBinary } from "../src/routes/health.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roleweave-qoder-resolver-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root, PATH: "", PATHEXT: ".cmd" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { root, env };
}

async function command(file: string, script = "process.exit(0);") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (process.platform === "win32") {
    const module = `${file}.cjs`;
    await fs.writeFile(module, script);
    await fs.writeFile(file, `@"${process.execPath}" "${module}" %*\r\n`);
  } else {
    await fs.writeFile(file, `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  }
  return fs.realpath(file);
}

test("Windows Qoder discovery ignores the bare editor shim and prefers dedicated CLI names", async (t) => {
  const { root, env } = await fixture(t);
  const editor = await command(path.join(root, "Qoder IDE", "bin", "qoder.cmd"));
  const domestic = await command(path.join(root, "domestic", "qoderclicn.cmd"));
  const native = await command(path.join(root, "native", "qodercli.cmd"));
  const directories = [path.dirname(editor), path.dirname(domestic), path.dirname(native)];
  assert.equal(resolveQoderExecutable({ ...env, PATH: directories.join(";") }, "win32"), native);
  assert.equal(resolveQoderExecutable({ ...env, PATH: directories.slice(0, 2).join(";") }, "win32"), domestic);
  assert.equal(resolveQoderExecutable({ ...env, PATH: path.dirname(editor) }, "win32"), null);
  // A bare dispatcher outside the known editor installation is also ambiguous
  // during automatic Windows discovery; an explicit operator choice may use it.
  const dispatcher = await command(path.join(root, "other", "qoder.cmd"));
  const ambiguous = { ...env, PATH: path.dirname(dispatcher) };
  assert.equal(resolveQoderExecutable(ambiguous, "win32"), null);
  assert.equal(resolveQoderExecutable({ ...ambiguous, ORG_WORKBENCH_QODER_BIN: dispatcher }, "win32"), dispatcher);
});

test("known Qoder editor overrides fail before health or catalog can start the launcher", async (t) => {
  const { root, env } = await fixture(t);
  const marker = path.join(root, "editor-started");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected editor invocation');`;
  for (const relative of ["Qoder IDE/bin/qoder.cmd", "Qoder IDE/bin/code.cmd", "Qoder IDE/Qoder IDE.exe"]) {
    const editor = await command(path.join(root, relative), script);
    for (const override of ["ORG_WORKBENCH_QODER_BIN", "DIGITAL_EMPLOYEE_QODER_COMMAND"] as const) {
      const blocked = { ...env, [override]: editor };
      assert.equal(resolveQoderExecutable(blocked, "win32"), null);
      assert.deepEqual(await probeQoderLocalBinary(blocked, 500, "win32"), {
        installed: false, version: null, supported: false, failure: "unavailable",
      });
      assert.deepEqual(await new QoderModelCatalog().read(blocked), { status: "unavailable", options: [] });
    }
  }
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  const valid = await command(path.join(root, "native", "qodercli.cmd"));
  // An invalid authoritative override cannot silently fall back to another CLI.
  assert.equal(resolveQoderExecutable({ ...env, PATH: path.dirname(valid), ORG_WORKBENCH_QODER_BIN: path.join(root, "missing") }, "win32"), null);
});

test("Qoder resolver rejects an editor launcher reached through an explicit symlink", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = await fixture(t);
  const editor = await command(path.join(root, "Qoder IDE", "bin", "qoder.cmd"));
  const alias = path.join(root, "qodercli");
  await fs.symlink(editor, alias);
  assert.equal(resolveQoderExecutable({ ...env, ORG_WORKBENCH_QODER_BIN: alias }, "win32"), null);
});

test("Qoder POSIX dispatcher and macOS installer discovery remain compatible", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = await fixture(t);
  const dispatcher = await command(path.join(root, "path", "qoder"));
  assert.equal(resolveQoderExecutable({ ...env, PATH: path.dirname(dispatcher) }, "linux"), dispatcher);
  const installed = await command(path.join(root, ".qoder", "entry", "qoder"));
  assert.equal(resolveQoderExecutable(env, "darwin"), installed);
});
