import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installAuthorizedKey,
  parseArgs,
  upsertSshConfig,
  usage,
  MARKER_BEGIN,
  MARKER_END,
} from "../setup-wsl-ssh.mjs";

test("parseArgs reads every documented flag", () => {
  const options = parseArgs(["--distro", "Ubuntu-22.04", "--user", "huyz", "--host", "devbox", "--key", "id_test", "--port", "2222", "--dry-run", "--check", "--force-key"]);
  assert.equal(options.distro, "Ubuntu-22.04");
  assert.equal(options.user, "huyz");
  assert.equal(options.host, "devbox");
  assert.equal(options.key, "id_test");
  assert.equal(options.port, 2222);
  assert.equal(options.dryRun, true);
  assert.equal(options.check, true);
  assert.equal(options.forceKey, true);
});

test("parseArgs keeps documented defaults", () => {
  const options = parseArgs([]);
  assert.equal(options.distro, "");
  assert.equal(options.user, "");
  assert.equal(options.host, "wsl");
  assert.equal(options.key, "id_ed25519");
  assert.equal(options.port, 22);
  assert.equal(options.dryRun, false);
  assert.equal(options.check, false);
});

test("parseArgs rejects a flag without a value", () => {
  assert.throws(() => parseArgs(["--port"]), /requires a value/);
});

test("parseArgs rejects a flag whose value looks like another flag", () => {
  assert.throws(() => parseArgs(["--distro", "--user"]), /requires a value/);
});

test("parseArgs rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("installAuthorizedKey is a no-op under dry-run", () => {
  const result = installAuthorizedKey({ distro: "Ubuntu-22.04", key: "ssh-ed25519 AAAA test", dryRun: true });
  assert.equal(result, "would install authorized key");
});

test("usage documents the operator-facing flags", () => {
  const text = usage();
  for (const flag of ["--distro", "--user", "--host", "--key", "--port", "--dry-run", "--check", "--force-key"]) {
    assert.ok(text.includes(flag), `usage should mention ${flag}`);
  }
  assert.ok(text.includes("id_ed25519"), "usage should name the default key");
});

test("upsertSshConfig writes a fenced, idempotent block", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roleweave-wsl-ssh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const original = { homedir: process.env.HOME };

  // upsertSshConfig resolves the config path from os.homedir(); point HOME at
  // the fixture so the test never touches the real ~/.ssh/config.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const first = upsertSshConfig({
      alias: "wsl",
      keyPath: join(home, ".ssh", "id_ed25519"),
      distro: "Ubuntu-22.04",
      user: "huyz",
      port: 22,
      dryRun: false,
    });
    const text = await readFile(first.configPath, "utf8");
    assert.ok(text.includes(MARKER_BEGIN));
    assert.ok(text.includes(MARKER_END));
    assert.ok(text.includes("Host wsl"));
    assert.ok(text.includes("HostName 127.0.0.1"));
    assert.ok(text.includes("User huyz"));
    assert.ok(text.includes("IdentitiesOnly yes"));

    const second = upsertSshConfig({
      alias: "wsl",
      keyPath: join(home, ".ssh", "id_ed25519"),
      distro: "Ubuntu-22.04",
      user: "huyz",
      port: 22,
      dryRun: false,
    });
    const after = await readFile(second.configPath, "utf8");
    assert.equal(second.changed, false, "re-running should be idempotent");
    assert.equal(after, text);
    assert.equal(after.split(MARKER_BEGIN).length - 1, 1, "marker must not duplicate");
  } finally {
    if (original.homedir === undefined) delete process.env.HOME;
    else process.env.HOME = original.homedir;
    delete process.env.USERPROFILE;
  }
});

test("upsertSshConfig preserves unrelated host entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roleweave-wsl-ssh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const configPath = join(home, ".ssh", "config");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(configPath, "Host existing\n  HostName example.test\n");
  const before = await readFile(configPath, "utf8");

  const original = { home: process.env.HOME };
  process.env.HOME = home;
  try {
    upsertSshConfig({ alias: "wsl", keyPath: join(home, ".ssh", "id_ed25519"), distro: "Ubuntu-22.04", user: "huyz", port: 22, dryRun: false });
    const after = await readFile(configPath, "utf8");
    assert.ok(after.includes("Host existing"), "existing entries must survive");
    assert.ok(after.includes(before.trim()), "original content must be kept verbatim");
    assert.ok(existsSync(configPath));
  } finally {
    if (original.home === undefined) delete process.env.HOME;
    else process.env.HOME = original.home;
  }
});
