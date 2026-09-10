const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  controlPlaneMode,
  serverPathForWorkspace,
} = require("./control-plane-launch.cjs");
const { readLastWorkspacePath } = require("./last-workspace.cjs");

function copyExampleWorkspace(source, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".digital-employee") continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyExampleWorkspace(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function workspaceOverride(env) {
  return env.ROLEWEAVE_DEFAULT_WORKSPACE ?? env.ORG_WORKBENCH_DEFAULT_WORKSPACE;
}

function defaultWorkspaceDir(env) {
  const override = workspaceOverride(env);
  if (override) return override;
  const source = path.resolve(__dirname, "..", "..", "..", "examples", "oss-maintainer");
  const runtime = path.join(os.homedir(), ".roleweave", "demo-workspace");
  const legacyRuntime = path.join(os.homedir(), ".org-workbench", "demo-workspace");
  if (!fs.existsSync(path.join(runtime, "workspace.json")) && fs.existsSync(path.join(legacyRuntime, "workspace.json"))) {
    return legacyRuntime;
  }
  if (fs.existsSync(path.join(source, "workspace.json"))) {
    if (!fs.existsSync(path.join(runtime, "workspace.json"))) {
      copyExampleWorkspace(source, runtime);
    }
    return runtime;
  }
  return source;
}

function safeWriteStderr(message, writeStderr) {
  try {
    writeStderr(message);
  } catch {
    // Diagnostics must never turn best-effort workspace opening into a failed startup.
  }
}

async function openDefaultWorkspace({
  apiRequest,
  env,
  userDataPath,
  writeStderr = process.stderr.write.bind(process.stderr),
}) {
  let fallbackNoticePath = null;

  const override = workspaceOverride(env);
  if (override) {
    const dir = override;
    if (!fs.existsSync(path.join(dir, "workspace.json"))) {
      safeWriteStderr(`auto-open skipped: workspace.json not found at ${dir}\n`, writeStderr);
      return { fallbackNoticePath: null };
    }
    try {
      const res = await apiRequest("/workspace/open", {
        method: "POST",
        body: { path: serverPathForWorkspace(dir, env) },
      });
      if (res.status !== 200) {
        safeWriteStderr(
          `auto-open workspace failed [mode=${controlPlaneMode(env)}, dir=${dir}]: `
          + `server responded ${res.status} — ${JSON.stringify(res.body)}\n`,
          writeStderr,
        );
      }
    } catch (err) {
      safeWriteStderr(
        `auto-open workspace failed [mode=${controlPlaneMode(env)}, dir=${dir}]: `
        + `${err.message ?? err}\n`,
        writeStderr,
      );
    }
    return { fallbackNoticePath: null };
  }

  const lastPath = readLastWorkspacePath(userDataPath);
  if (lastPath !== null) {
    if (fs.existsSync(path.join(lastPath, "workspace.json"))) {
      try {
        const res = await apiRequest("/workspace/open", {
          method: "POST",
          body: { path: serverPathForWorkspace(lastPath, env) },
        });
        if (res.status === 200) return { fallbackNoticePath: null };
        safeWriteStderr(
          `auto-open workspace failed [mode=${controlPlaneMode(env)}, dir=${lastPath}]: `
          + `server responded ${res.status} — ${JSON.stringify(res.body)}\n`,
          writeStderr,
        );
      } catch (err) {
        safeWriteStderr(
          `auto-open workspace failed [mode=${controlPlaneMode(env)}, dir=${lastPath}]: `
          + `${err.message ?? err}\n`,
          writeStderr,
        );
      }
    }
    fallbackNoticePath = lastPath;
  }

  const dir = defaultWorkspaceDir(env);
  if (!fs.existsSync(path.join(dir, "workspace.json"))) {
    safeWriteStderr(`auto-open skipped: workspace.json not found at ${dir}\n`, writeStderr);
    return { fallbackNoticePath };
  }
  try {
    const res = await apiRequest("/workspace/open", {
      method: "POST",
      body: { path: serverPathForWorkspace(dir, env) },
    });
    if (res.status !== 200) {
      safeWriteStderr(
        `auto-open workspace failed [mode=${controlPlaneMode(env)}, dir=${dir}]: `
        + `server responded ${res.status} — ${JSON.stringify(res.body)}\n`,
        writeStderr,
      );
    }
  } catch (err) {
    safeWriteStderr(
      `auto-open workspace failed [mode=${controlPlaneMode(env)}, dir=${dir}]: `
      + `${err.message ?? err}\n`,
      writeStderr,
    );
  }
  return { fallbackNoticePath };
}

module.exports = {
  copyExampleWorkspace,
  defaultWorkspaceDir,
  workspaceOverride,
  openDefaultWorkspace,
};
