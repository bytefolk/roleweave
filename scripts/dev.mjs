import { spawnSync as defaultSpawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "org-workbench-dev-orchestrator.v1";
export const SUPPORTED_PREVIEW_MODES = Object.freeze(["quick", "full"]);
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAX_TOOL_CHECK_MS = 2_000;
const MIN_NODE_MAJOR = 22;
const SAFE_ENV_KEYS = Object.freeze([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
]);

const WORKSPACE_PATHS = Object.freeze({
  electronPackage: "node_modules/electron/package.json",
  designSystemDist: "../design-system/dist",
});

const QUICK_STEPS = Object.freeze([
  {
    id: "build-control-plane",
    label: "构建本地控制面",
    command: "npm",
    args: ["run", "build"],
    longRunning: false,
  },
  {
    id: "build-renderer",
    label: "构建桌面渲染层",
    command: "npm",
    args: ["run", "build:renderer"],
    longRunning: false,
  },
]);

const FULL_EXTRA_STEPS = Object.freeze([
  {
    id: "server",
    label: "启动本地 server",
    command: "npm",
    args: ["run", "dev:server"],
    longRunning: true,
  },
  {
    id: "desktop",
    label: "启动 Electron desktop",
    command: "npm",
    args: ["run", "dev:desktop"],
    longRunning: true,
  },
]);

export class DevCliError extends Error {
  constructor(message, code = "INVALID_ARGUMENTS") {
    super(message);
    this.name = "DevCliError";
    this.code = code;
  }
}

export function sanitizeEnvironment(environment = process.env) {
  const safe = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof environment?.[key] === "string") safe[key] = environment[key];
  }
  return safe;
}

function toolCommand(name, platform) {
  return platform === "win32" && name === "npm" ? "npm.cmd" : name;
}

function parseVersion(output) {
  const match = String(output ?? "").match(/\b\d+(?:\.\d+){1,3}\b/);
  return match?.[0] ?? null;
}

function parseNodeMajor(version) {
  const match = String(version ?? "").match(/^(?:v)?(\d+)/);
  return match ? Number(match[1]) : null;
}

function classifyProcessResult(result) {
  if (result?.error?.code === "ENOENT") return { ok: false, status: "missing" };
  if (result?.error) return { ok: false, status: "error" };
  if (result?.signal) return { ok: false, status: "timeout" };
  if (result?.status !== 0) {
    return {
      ok: false,
      status: "non-zero",
      exitCode: Number.isInteger(result?.status) ? result.status : null,
    };
  }
  return { ok: true, status: "ready" };
}

function runVersionCheck(name, { platform, rootDir, environment, spawnSyncImpl }) {
  const command = toolCommand(name, platform);
  let result;
  try {
    result = spawnSyncImpl(command, ["--version"], {
      cwd: rootDir,
      env: environment,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAX_TOOL_CHECK_MS,
      windowsHide: true,
    });
  } catch {
    result = { error: { code: "SPAWN_ERROR" } };
  }

  const outcome = classifyProcessResult(result);
  const version = outcome.ok ? parseVersion(result.stdout) : null;
  return {
    id: name,
    command,
    ...outcome,
    ...(version ? { version } : {}),
  };
}

function readPackageVersion(fileSystem, absolutePath) {
  if (typeof fileSystem.readFileSync !== "function") return null;
  try {
    const packageJson = JSON.parse(fileSystem.readFileSync(absolutePath, "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function checkPath(id, relativePath, { rootDir, fileSystem, packageFile = false }) {
  const absolutePath = path.resolve(rootDir, relativePath);
  let exists = false;
  try {
    exists = fileSystem.existsSync(absolutePath);
  } catch {
    exists = false;
  }

  return {
    id,
    ok: exists,
    status: exists ? "ready" : "missing",
    path: relativePath,
    ...(exists && packageFile
      ? { version: readPackageVersion(fileSystem, absolutePath) }
      : {}),
  };
}

function checkNode(nodeVersion) {
  const major = parseNodeMajor(nodeVersion);
  const ok = major !== null && major >= MIN_NODE_MAJOR;
  return {
    id: "node",
    ok,
    status: major === null ? "invalid-version" : ok ? "ready" : "unsupported",
    version: String(nodeVersion ?? "unknown").replace(/^v/, ""),
    required: `>=${MIN_NODE_MAJOR}`,
  };
}

export function runDoctor({
  rootDir = PROJECT_ROOT,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  fileSystem = fs,
  spawnSyncImpl = defaultSpawnSync,
} = {}) {
  const safeEnvironment = sanitizeEnvironment(environment);
  const checks = [
    checkNode(nodeVersion),
    runVersionCheck("npm", {
      platform,
      rootDir,
      environment: safeEnvironment,
      spawnSyncImpl,
    }),
    runVersionCheck("git", {
      platform,
      rootDir,
      environment: safeEnvironment,
      spawnSyncImpl,
    }),
    checkPath("electron", WORKSPACE_PATHS.electronPackage, {
      rootDir,
      fileSystem,
      packageFile: true,
    }),
    checkPath("design-system-dist", WORKSPACE_PATHS.designSystemDist, {
      rootDir,
      fileSystem,
    }),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    command: "doctor",
    ok: checks.every((check) => check.ok),
    platform: {
      name: platform,
      arch,
    },
    checks,
    safety: {
      readOnly: true,
      network: false,
      installs: false,
      longRunningProcesses: false,
      environment: "allowlist-only",
    },
  };
}

export function parseArgs(argv = []) {
  if (argv.length === 1 && argv[0] === "doctor") {
    return { command: "doctor" };
  }

  if (argv[0] === "preview") {
    let mode = null;
    if (argv.length === 3 && argv[1] === "--mode") mode = argv[2];
    if (argv.length === 2 && argv[1].startsWith("--mode=")) mode = argv[1].slice("--mode=".length);
    if (SUPPORTED_PREVIEW_MODES.includes(mode)) return { command: "preview", mode };
  }

  throw new DevCliError(
    "未知命令或参数。支持：doctor；preview --mode quick|full",
  );
}

export function buildPreviewPlan(mode) {
  if (!SUPPORTED_PREVIEW_MODES.includes(mode)) {
    throw new DevCliError("未知 preview 模式。支持：quick|full");
  }

  const sourceSteps = mode === "full" ? [...QUICK_STEPS, ...FULL_EXTRA_STEPS] : [...QUICK_STEPS];
  return {
    mode,
    dryRun: true,
    execution: "plan-only",
    steps: sourceSteps.map((step, index) => ({
      order: index + 1,
      ...step,
      cwd: ".",
      status: "planned",
    })),
  };
}

export function executeCli(argv = [], options = {}) {
  try {
    const parsed = parseArgs(argv);
    const doctor = runDoctor(options);
    if (parsed.command === "doctor") {
      return {
        exitCode: doctor.ok ? 0 : 1,
        report: doctor,
      };
    }

    const plan = buildPreviewPlan(parsed.mode);
    return {
      exitCode: doctor.ok ? 0 : 1,
      report: {
        schemaVersion: SCHEMA_VERSION,
        command: "preview",
        mode: parsed.mode,
        dryRun: true,
        doctor,
        plan: {
          ...plan,
          status: doctor.ok ? "ready" : "blocked-by-doctor",
        },
      },
    };
  } catch (error) {
    const cliError = error instanceof DevCliError
      ? error
      : new DevCliError("开发编排器执行失败", "INTERNAL_ERROR");
    return {
      exitCode: cliError.code === "INVALID_ARGUMENTS" ? 2 : 1,
      report: {
        schemaVersion: SCHEMA_VERSION,
        command: "dev",
        ok: false,
        error: {
          code: cliError.code,
          message: cliError.message,
        },
      },
    };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = executeCli(process.argv.slice(2));
  const output = `${JSON.stringify(result.report)}\n`;
  (result.exitCode === 0 ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}
