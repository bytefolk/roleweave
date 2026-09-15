import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeServiceEnvironment } from "../service-environment.mjs";

const DOC_TEMPLATE = "# Doc local defaults\nAUTH_SECRET=replace-with-a-random-secret\nCOLLABORATE_API_AUTH_KEY=replace-with-a-shared-token-key\nCOLLABORATE_INTERNAL_API_KEY=replace-with-an-internal-service-key\nDOC_WEB_PORT=3100\nEMAIL_CONTAINER_HOST=mailpit\nEMAIL_CONTAINER_PORT=1025\nEMAIL_FROM=doc@example.test\nDEEP_SEEK_API_KEY=\n";
const MEM_TEMPLATE = "# Mem local defaults\nMEM_POSTGRES_PASSWORD=\nMEM_REDIS_PASSWORD=\nMEM_S3_ACCESS_KEY=\nMEM_S3_SECRET_KEY=\nMEM_WORKER_AUTH_KEY_B64=\nMEM_WORKER_AUTH_KEY_ID=memd-primary\nMEM_BIND_ADDRESS=0.0.0.0\nMEM_EDGE_PORT=8080\nMEM_REGISTRATION_MODE=first_user\nMEM_WORKER_EXTRAS=\nMEM_IMAGE_TAG=local\n";

async function fixture(t, kind = "doc", template) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, "roleweave-env-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temporaryRoot);
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, "source");
  const relativeTemplate = kind === "doc" ? ".env.example" : "deploy/compose/.env.example";
  const templateFile = path.join(sourcePath, relativeTemplate);
  await fs.mkdir(path.dirname(templateFile), { recursive: true });
  await fs.writeFile(templateFile, template ?? (kind === "doc" ? DOC_TEMPLATE : MEM_TEMPLATE));
  const envFile = path.join(root, "runtime", ".env");
  return { root, sourcePath, templateFile, envFile, args: { kind, sourcePath, envFile } };
}

function values(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line)).map((line) => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
}

test("doc initializes three independent secrets while preserving local authentication defaults", async (t) => {
  const f = await fixture(t);
  const result = await initializeServiceEnvironment(f.args);
  assert.deepEqual(result, { created: true, envFile: f.envFile });
  const content = await fs.readFile(f.envFile, "utf8");
  const config = values(content);
  const secrets = [config.AUTH_SECRET, config.COLLABORATE_API_AUTH_KEY, config.COLLABORATE_INTERNAL_API_KEY];
  for (const secret of secrets) assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set(secrets).size, 3);
  assert.equal(config.EMAIL_CONTAINER_HOST, "mailpit");
  assert.equal(config.EMAIL_CONTAINER_PORT, "1025");
  assert.equal(config.DOC_WEB_PORT, "3100");
  assert.equal(config.DEEP_SEEK_API_KEY, "");
  assert.equal(await fs.readFile(f.templateFile, "utf8"), DOC_TEMPLATE);
  assert.deepEqual(await fs.readdir(path.dirname(f.envFile)), [".env"]);
  if (process.platform !== "win32") assert.equal((await fs.stat(f.envFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.envFile)).nlink, 1);
  assert.ok(secrets.every((secret) => !JSON.stringify(result).includes(secret)));
});

test("mem initializes valid secrets and worker key, forces new loopback default and retains model-free settings", async (t) => {
  const f = await fixture(t, "mem");
  const result = await initializeServiceEnvironment(f.args);
  const config = values(await fs.readFile(f.envFile, "utf8"));
  assert.match(config.MEM_POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
  assert.match(config.MEM_REDIS_PASSWORD, /^[a-f0-9]{48}$/);
  assert.notEqual(config.MEM_POSTGRES_PASSWORD, config.MEM_REDIS_PASSWORD);
  assert.match(config.MEM_S3_ACCESS_KEY, /^[a-f0-9]{24}$/);
  assert.equal(Buffer.from(config.MEM_S3_SECRET_KEY, "base64").length, 36);
  assert.equal(Buffer.from(config.MEM_WORKER_AUTH_KEY_B64, "base64").length, 32);
  assert.equal(config.MEM_BIND_ADDRESS, "127.0.0.1");
  assert.equal(config.MEM_EDGE_PORT, "8080");
  assert.equal(config.MEM_WORKER_AUTH_KEY_ID, "memd-primary");
  assert.equal(config.MEM_REGISTRATION_MODE, "first_user");
  assert.equal(config.MEM_WORKER_EXTRAS, "");
  assert.equal(config.MEM_IMAGE_TAG, "local");
  assert.deepEqual(result, { created: true, envFile: f.envFile });
});

test("existing environment is preserved byte-for-byte without even requiring an upstream template", async (t) => {
  const f = await fixture(t, "mem");
  await fs.mkdir(path.dirname(f.envFile));
  const original = "# user-owned\r\nMEM_BIND_ADDRESS=192.168.1.20\r\nSECRET=retain-exactly\r\n";
  await fs.writeFile(f.envFile, original);
  await fs.unlink(f.templateFile);
  assert.deepEqual(await initializeServiceEnvironment(f.args), { created: false, envFile: f.envFile });
  assert.equal(await fs.readFile(f.envFile, "utf8"), original);
  assert.deepEqual(await fs.readdir(path.dirname(f.envFile)), [".env"]);
});

test("concurrent initialization has one winner and never overwrites the published environment", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => initializeServiceEnvironment(f.args)));
  assert.equal(results.filter((result) => result.created).length, 1);
  const content = await fs.readFile(f.envFile, "utf8");
  assert.match(values(content).AUTH_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await fs.readdir(path.dirname(f.envFile)), [".env"]);
  await initializeServiceEnvironment(f.args);
  assert.equal(await fs.readFile(f.envFile, "utf8"), content);
});

test("missing required keys, duplicate keys and unsupported syntax fail without publishing secrets", async (t) => {
  for (const [template, message] of [
    ["AUTH_SECRET=placeholder\n", /missing required keys/],
    [DOC_TEMPLATE + "AUTH_SECRET=second\n", /duplicate key/],
    [DOC_TEMPLATE + "execute something\n", /unsupported .env syntax/],
  ]) {
    const f = await fixture(t, "doc", template);
    await assert.rejects(initializeServiceEnvironment(f.args), message);
    assert.deepEqual(await fs.readdir(path.dirname(f.envFile)), []);
  }
  const mem = await fixture(t, "mem", MEM_TEMPLATE.replace("MEM_BIND_ADDRESS=0.0.0.0\n", ""));
  await assert.rejects(initializeServiceEnvironment(mem.args), /MEM_BIND_ADDRESS/);
});

test("CRLF templates preserve line endings and comments", async (t) => {
  const f = await fixture(t, "doc", DOC_TEMPLATE.replaceAll("\n", "\r\n"));
  await initializeServiceEnvironment(f.args);
  const text = await fs.readFile(f.envFile, "utf8");
  assert.ok(text.startsWith("# Doc local defaults\r\n"));
  assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
});

test("non-file environment and template paths are rejected", async (t) => {
  const first = await fixture(t);
  await fs.mkdir(first.envFile, { recursive: true });
  await assert.rejects(initializeServiceEnvironment(first.args), /regular file/);
  const second = await fixture(t);
  await fs.unlink(second.templateFile);
  await fs.mkdir(second.templateFile);
  await assert.rejects(initializeServiceEnvironment(second.args), /regular file/);
});

test("environment/template symlinks and linked parent directories cannot redirect initialization", { skip: process.platform === "win32" }, async (t) => {
  const env = await fixture(t);
  const original = path.join(env.root, "original");
  await fs.writeFile(original, "untouched");
  await fs.mkdir(path.dirname(env.envFile));
  await fs.symlink(original, env.envFile);
  await assert.rejects(initializeServiceEnvironment(env.args), /symbolic links/);
  assert.equal(await fs.readFile(original, "utf8"), "untouched");
  const template = await fixture(t);
  await fs.rename(template.templateFile, path.join(template.root, "template"));
  await fs.symlink(path.join(template.root, "template"), template.templateFile);
  await assert.rejects(initializeServiceEnvironment(template.args), /symbolic links/);
  const parent = await fixture(t);
  const destination = path.join(parent.root, "elsewhere");
  await fs.mkdir(destination);
  await fs.symlink(destination, path.dirname(parent.envFile));
  await assert.rejects(initializeServiceEnvironment(parent.args), /symbolic links/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test("unsupported kinds and relative paths are rejected before any filesystem mutation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(initializeServiceEnvironment({ ...f.args, kind: "../doc" }), /doc or mem/);
  await assert.rejects(initializeServiceEnvironment({ ...f.args, sourcePath: "source" }), /absolute/);
  await assert.rejects(initializeServiceEnvironment({ ...f.args, envFile: ".env" }), /absolute/);
  assert.deepEqual(await fs.readdir(f.root), ["source"]);
});
