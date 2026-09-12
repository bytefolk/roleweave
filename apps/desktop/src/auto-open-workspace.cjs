const fs = require("node:fs");
const path = require("node:path");
const {
  controlPlaneMode,
  serverPathForWorkspace,
} = require("./control-plane-launch.cjs");
const { readLastWorkspacePath } = require("./last-workspace.cjs");

function workspaceOverride(env) {
  return env.ROLEWEAVE_DEFAULT_WORKSPACE ?? env.ORG_WORKBENCH_DEFAULT_WORKSPACE;
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
    // In WSL mode the override may be a Linux path (for example /mnt/c/...),
    // which the Windows-side desktop process cannot stat. Let the server
    // validate it after serverPathForWorkspace applies the boundary mapping.
    const isWsl = controlPlaneMode(env) === "wsl";
    if (!isWsl && !fs.existsSync(path.join(dir, "workspace.json"))) {
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
    if (controlPlaneMode(env) === "wsl" || fs.existsSync(path.join(lastPath, "workspace.json"))) {
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

  // With no accessible user-selected workspace, leave the app empty so the
  // user can create or open a project. Never copy or auto-select demo data.
  return { fallbackNoticePath };
}

module.exports = {
  workspaceOverride,
  openDefaultWorkspace,
};
