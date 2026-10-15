const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { isTrustedWindowSender } = require("./window-ipc.cjs");

const failure = (status, code, message) => ({ status, body: { code, message, retryable: false } });
const invalidFile = () => failure(400, "drive_request_invalid", "The selected file is not a readable, unchanged regular file");
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".zip": "application/zip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime" };

/** Called exclusively with the main-process OS picker's result. Never read a
 * renderer-supplied path or send a Windows path to a WSL server. */
async function readPickedFile(filePath) {
  const { DRIVE_UPLOAD_MAX_BYTES } = await import("@roleweave/shared");
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.length > 4096) throw invalidFile();
  const name = path.basename(filePath);
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 512 || /[\\/\x00-\x1f\x7f]/u.test(name) || Buffer.from(name).toString("utf8") !== name) throw invalidFile();
  let handle;
  try {
    // Open first, then inspect the descriptor that will actually be read.
    // NOFOLLOW rejects a symlink atomically where supported; NONBLOCK keeps
    // a raced-in FIFO from hanging open before its type can be inspected.
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw invalidFile();
    if (opened.size > DRIVE_UPLOAD_MAX_BYTES) throw failure(413, "drive_upload_too_large", "Uploads are limited to 32 MiB; use Mem for larger files");
    // Windows may not implement NOFOLLOW. Compare the selected path with the
    // already-open descriptor, rejecting links/replacements before any read.
    const selected = await fs.lstat(filePath);
    if (!selected.isFile() || selected.isSymbolicLink() || opened.dev !== selected.dev || opened.ino !== selected.ino || opened.size !== selected.size || opened.mtimeMs !== selected.mtimeMs) throw invalidFile();
    // One extra byte detects growth without readFile's unbounded allocation.
    const buffer = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw invalidFile();
    return { name, mime: MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream", bytes: buffer.subarray(0, length) };
  } catch (error) {
    if (error?.body?.code) throw error;
    throw invalidFile();
  } finally { await handle?.close(); }
}

function registerDriveUploadIpc({ ipcMain, dialog, getMainWindow, getTrustedRendererUrl, apiRequest, readFile = readPickedFile }) {
  let busy = false;
  const trusted = event => isTrustedWindowSender(event, getMainWindow(), getTrustedRendererUrl());
  const denied = () => failure(403, "drive_request_invalid", "Untrusted sender");
  // Preserve the old channel as an explicit failure. Even a trusted renderer
  // cannot grant itself arbitrary local file-read access with a pathname.
  ipcMain.handle("owb:drive:upload", event => trusted(event)
    ? failure(501, "drive_action_unsupported", "Choose a file with the desktop upload picker") : denied());
  ipcMain.handle("owb:drive:pick-and-upload", async event => {
    if (!trusted(event)) return denied();
    if (busy) return failure(409, "drive_request_invalid", "An upload is already in progress");
    busy = true;
    try {
      const provider = await apiRequest("/drive/provider", { timeoutMs: 8000 });
      if (provider.status !== 200) return provider;
      if (provider.body?.status?.kind !== "mem") return failure(501, "drive_action_unsupported", "This storage provider does not support desktop uploads");
      if (provider.body.status.state !== "ready") return failure(503, "drive_not_configured", "Connect Mem in service settings before uploading");
      if (!trusted(event)) return denied();
      const picked = await dialog.showOpenDialog(getMainWindow(), { title: "Upload to Mem", properties: ["openFile"] });
      if (!trusted(event)) return denied();
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      if (picked.filePaths.length !== 1) return invalidFile();
      const file = await readFile(picked.filePaths[0]);
      if (!trusted(event)) return denied();
      const { DRIVE_UPLOAD_TIMEOUT_MS } = await import("@roleweave/shared");
      const query = new URLSearchParams({ name: file.name, mime: file.mime });
      return await apiRequest(`/drive/upload?${query}`, { method: "POST", binaryBody: file.bytes, timeoutMs: DRIVE_UPLOAD_TIMEOUT_MS + 5000 });
    } catch (error) {
      if (error?.body?.code) return error;
      return failure(502, "drive_upstream_unavailable", "Upload could not be confirmed; check the file list before trying again");
    } finally { busy = false; }
  });
}

module.exports = { readPickedFile, registerDriveUploadIpc };
