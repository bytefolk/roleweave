#!/usr/bin/env node
// Configure passwordless SSH from the Windows host into a local WSL
// distribution, so the operator can drive a Linux workspace (for example a
// RoleWeave workspace under ~/data/... ) over a real SSH session instead of
// per-command `wsl.exe` invocations.
//
// This script is a developer-environment helper. It does not touch the
// RoleWeave runtime: the application keeps launching its control plane through
// `wsl.exe` (see docs/design/control-plane-lifecycle-v1.md). SSH is only an
// additional, optional path for humans and tooling.
//
// Run it from Windows (PowerShell or cmd):
//
//   node scripts/setup-wsl-ssh.mjs                 # detect distro + user
//   node scripts/setup-wsl-ssh.mjs --distro Ubuntu-22.04 --user huyz
//   node scripts/setup-wsl-ssh.mjs --host wsl        # add a Host alias
//   node scripts/setup-wsl-ssh.mjs --dry-run         # print, change nothing
//   node scripts/setup-wsl-ssh.mjs --check           # verify only
//
// It is idempotent: re-running it is safe and will not duplicate keys or
// config blocks.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_KEY_NAME = "id_ed25519";
const DEFAULT_HOST_ALIAS = "wsl";
const MARKER_BEGIN = "# >>> roleweave wsl ssh >>>";
const MARKER_END = "# <<< roleweave wsl ssh <<<";

function parseArgs(argv) {
  const options = {
    distro: "",
    user: "",
    host: DEFAULT_HOST_ALIAS,
    key: DEFAULT_KEY_NAME,
    port: 22,
    dryRun: false,
    check: false,
    forceKey: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--distro":
        options.distro = next();
        break;
      case "--user":
        options.user = next();
        break;
      case "--host":
        options.host = next();
        break;
      case "--key":
        options.key = next();
        break;
      case "--port":
        options.port = Number.parseInt(next(), 10);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--force-key":
        options.forceKey = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/setup-wsl-ssh.mjs [options]",
    "",
    "  --distro <name>   WSL distribution (auto-detected when omitted)",
    "  --user <name>     Linux user in the distribution (auto-detected)",
    "  --host <alias>    ssh_config Host alias to write (default: wsl)",
    "  --key <name>      Key file name under ~/.ssh (default: id_ed25519)",
    "  --port <n>        SSH port (default: 22)",
    "  --dry-run         Print planned changes without writing anything",
    "  --check           Verify the current login only; change nothing",
    "  --force-key       Generate a new key even if one already exists",
    "  -h, --help        Show this help",
    "",
    "Run this from Windows. The generated key stays on the Windows side; only",
    "its public half is copied into the distribution's ~/.ssh/authorized_keys.",
  ].join("\n");
}

function run(command, args, { input } = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    input,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  }).trim();
}

function tryRun(command, args, options) {
  try {
    return { ok: true, stdout: run(command, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function detectDistro(explicit) {
  if (explicit) return explicit;
  const listing = tryRun("wsl.exe", ["--list", "--quiet"]);
  if (!listing.ok) {
    throw new Error("cannot list WSL distributions; pass --distro explicitly");
  }
  const names = listing.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, "").trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error("no WSL distribution found; pass --distro explicitly");
  }
  return names[0];
}

function detectUser(distro, explicit) {
  if (explicit) return explicit;
  const args = [...(distro ? ["--distribution", distro] : []), "--exec", "id", "-un"];
  const result = tryRun("wsl.exe", args);
  if (!result.ok) {
    throw new Error("cannot detect the WSL user; pass --user explicitly");
  }
  return result.stdout.replace(/\u0000/g, "").trim();
}

function wslExec(distro, script, { input } = {}) {
  return run(
    "wsl.exe",
    [...(distro ? ["--distribution", distro] : []), "--exec", "/bin/sh", "-c", script],
    { input },
  );
}

function sshDir() {
  return join(homedir(), ".ssh");
}

function ensureKey(keyPath, { dryRun, forceKey }) {
  // Reuse an existing private key unless rotation was requested. The presence
  // test reads the file rather than stat-ing it, so there is no check-then-use
  // window; ssh-keygen then owns the write.
  const existingKey = readTextIfPresent(keyPath);
  if (existingKey !== "" && !forceKey) {
    return { created: false, keyPath };
  }
  if (dryRun) {
    return { created: true, keyPath, planned: true };
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const comment = `${process.env.USERNAME || "user"}@win-wsl`;
  const result = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("ssh-keygen failed");
  }
  return { created: true, keyPath };
}

function readPublicKey(keyPath) {
  const pubPath = `${keyPath}.pub`;
  const key = readTextIfPresent(pubPath).trim();
  if (key === "") throw new Error(`public key not found: ${pubPath}`);
  if (!/^ssh-(ed25519|rsa)\s/.test(key)) {
    throw new Error(`unexpected public key format in ${pubPath}`);
  }
  return key;
}

function installAuthorizedKey({ distro, key, dryRun }) {
  // Idempotent append: only add when the exact key is absent. Runs inside the
  // distribution so file ownership and modes are Linux-native.
  const script = [
    "set -eu",
    "mkdir -p ~/.ssh",
    "chmod 700 ~/.ssh",
    "touch ~/.ssh/authorized_keys",
    "chmod 600 ~/.ssh/authorized_keys",
    'if grep -qxF "$ROLEWEAVE_SSH_KEY" ~/.ssh/authorized_keys; then',
    '  echo "authorized key already present"',
    "else",
    '  printf \'%s\\n\' "$ROLEWEAVE_SSH_KEY" >> ~/.ssh/authorized_keys',
    '  echo "authorized key installed"',
    "fi",
  ].join("; ");
  if (dryRun) return "would install authorized key";
  return wslExec(distro, `ROLEWEAVE_SSH_KEY='${key.replace(/'/g, "'\\''")}'; ${script}`);
}

function readTextIfPresent(filePath) {
  // Read once and treat ENOENT as "no existing content". A separate existence
  // check would introduce a race between the check and the read.
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

function upsertSshConfig({ alias, keyPath, distro, user, port, dryRun }) {
  const configPath = join(sshDir(), "config");
  const block = [
    MARKER_BEGIN,
    `Host ${alias}`,
    "  HostName 127.0.0.1",
    `  User ${user}`,
    `  Port ${port}`,
    `  IdentityFile ${keyPath.replace(/\\/g, "/")}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking accept-new",
    distro ? `  # distribution: ${distro}` : "",
    MARKER_END,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const existing = readTextIfPresent(configPath);
  const begin = existing.indexOf(MARKER_BEGIN);
  const end = existing.indexOf(MARKER_END);
  let next;
  if (begin !== -1 && end !== -1 && end > begin) {
    next = `${existing.slice(0, begin)}${block}${existing.slice(end + MARKER_END.length).replace(/^\r?\n/, "")}`;
  } else {
    next = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n\n${block}` : `${existing}${existing.length ? "\n" : ""}${block}`;
  }
  if (dryRun) return { configPath, changed: next !== existing, planned: true };
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, next, { mode: 0o600 });
  return { configPath, changed: next !== existing };
}

function verifyLogin({ alias, distro, user, port }) {
  const target = alias ? alias : `${user}@127.0.0.1`;
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      ...(alias ? [] : ["-p", String(port)]),
      target,
      "printf 'ROLEWEAVE_SSH_OK %s %s\\n' \"$(id -un)\" \"$(uname -sr)\"",
    ],
    { encoding: "utf8" },
  );
  if (result.error) {
    return { ok: false, output: `cannot run ssh: ${result.error.message}`, target };
  }
  const combined = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return { ok: result.status === 0 && combined.includes("ROLEWEAVE_SSH_OK"), output: combined, target };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (process.platform !== "win32") {
    console.error("This helper targets Windows hosts. On Linux/macOS you already share the environment with the distribution.");
    process.exit(2);
  }
  if (!Number.isFinite(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("--port must be a valid TCP port");
  }

  const distro = detectDistro(options.distro);
  const user = detectUser(distro, options.user);
  const keyPath = join(sshDir(), options.key);
  console.log(`Distribution : ${distro}`);
  console.log(`Linux user   : ${user}`);
  console.log(`Host alias   : ${options.host}`);
  console.log(`Key file     : ${keyPath}`);

  if (options.check) {
    const result = verifyLogin({ alias: options.host, distro, user, port: options.port });
    console.log(result.ok ? `OK   ${result.target} -> ${result.output}` : `FAIL ${result.target} -> ${result.output}`);
    process.exit(result.ok ? 0 : 1);
  }

  const key = ensureKey(keyPath, { dryRun: options.dryRun, forceKey: options.forceKey });
  console.log(key.created ? (key.planned ? "[plan] generate key pair" : "generated key pair") : "reusing existing key pair");

  const publicKey = options.dryRun ? "<public key>" : readPublicKey(keyPath);
  const authorized = installAuthorizedKey({ distro, key: publicKey, dryRun: options.dryRun });
  console.log(`authorized_keys: ${authorized}`);

  const config = upsertSshConfig({
    alias: options.host,
    keyPath,
    distro,
    user,
    port: options.port,
    dryRun: options.dryRun,
  });
  console.log(`ssh config: ${config.configPath} (${config.changed ? "updated" : "unchanged"})`);

  if (options.dryRun) {
    console.log("\nDry run complete. No files were written.");
    return;
  }

  const result = verifyLogin({ alias: options.host, distro, user, port: options.port });
  console.log("");
  if (result.ok) {
    console.log(`Passwordless SSH is ready: ssh ${options.host}`);
    console.log(`Verified: ${result.output}`);
  } else {
    console.error(`Verification failed: ${result.output}`);
    console.error("If sshd is not running in the distribution, start it there, then re-run --check.");
    process.exit(1);
  }
}

export {
  parseArgs,
  usage,
  detectDistro,
  detectUser,
  ensureKey,
  readPublicKey,
  installAuthorizedKey,
  upsertSshConfig,
  verifyLogin,
  MARKER_BEGIN,
  MARKER_END,
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  try {
    main();
  } catch (error) {
    console.error(`setup-wsl-ssh: ${error.message}`);
    process.exit(1);
  }
}
