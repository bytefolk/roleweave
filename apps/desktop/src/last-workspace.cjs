const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const LAST_WORKSPACE_FILE = "last-workspace.json";

function lastWorkspaceFilePath(userDataPath) {
  return path.join(userDataPath, LAST_WORKSPACE_FILE);
}

function readLastWorkspacePath(userDataPath) {
  const filePath = lastWorkspaceFilePath(userDataPath);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.path === "string" && parsed.path.length > 0) {
      return parsed.path;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLastWorkspacePath(userDataPath, workspacePath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const filePath = lastWorkspaceFilePath(userDataPath);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ path: workspacePath }), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

function defaultUserDataPath() {
  return path.join(os.homedir(), ".roleweave");
}

module.exports = {
  lastWorkspaceFilePath,
  readLastWorkspacePath,
  writeLastWorkspacePath,
  defaultUserDataPath,
  LAST_WORKSPACE_FILE,
};
