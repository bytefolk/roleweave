// Drive plane IPC validators (bytefolk/mem proxy MVP).
//
// The renderer never opens a raw channel to mem; the whitelist below just
// bounds argument shapes and encodes them into the frozen /drive/* routes.
// Upload validation is intentionally minimal — the OS file picker in main
// returns the absolute path, and the server route today is a stub (see
// apps/server/src/routes/drive.ts). When mem's multipart contract is pinned,
// the actual PUT will be added inside main.js against a validated filePath.

function invalidResponse(message) {
  return {
    ok: false,
    response: {
      status: 400,
      body: { code: "drive_request_invalid", message, retryable: false },
    },
  };
}

function validateDriveListRequest(query) {
  const q = typeof query === "string" ? query : "";
  if (q.length > 256) return invalidResponse("q exceeds 256 chars");
  const pathname = q === "" ? "/drive/list" : `/drive/list?q=${encodeURIComponent(q)}`;
  return { ok: true, pathname };
}

function validateDriveDetailRequest(id) {
  if (typeof id !== "string" || id.length === 0) {
    return invalidResponse("id required");
  }
  if (id.length > 128) return invalidResponse("id exceeds 128 chars");
  return { ok: true, pathname: `/drive/detail?id=${encodeURIComponent(id)}` };
}

function validateDrivePreviewRequest(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    return invalidResponse("a bounded object id is required");
  }
  return { ok: true, pathname: `/drive/preview?id=${encodeURIComponent(id)}` };
}

function authorizeDriveReadSender(event, expectedWindow, allowedUrl) {
  const { isTrustedWindowSender } = require("./window-ipc.cjs");
  if (!isTrustedWindowSender(event, expectedWindow, allowedUrl)) {
    return { ok: false, response: { status: 403, body: { code: "drive_request_invalid", message: "Untrusted sender", retryable: false } } };
  }
  return { ok: true };
}

function validateDriveUploadRequest(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return invalidResponse("filePath required");
  }
  if (filePath.length > 4096) return invalidResponse("filePath exceeds 4096 chars");
  return { ok: true, request: { filePath } };
}

module.exports = {
  validateDriveListRequest,
  validateDriveDetailRequest,
  validateDrivePreviewRequest,
  authorizeDriveReadSender,
  authorizeDrivePreviewSender: authorizeDriveReadSender,
  validateDriveUploadRequest,
};
