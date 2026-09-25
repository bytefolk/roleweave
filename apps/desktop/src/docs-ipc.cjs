// Document routing IPC validators (#35 S2/S4, DS-35-001 rev-1 §3/§5/§6).
// The server side owns the fail-closed path guards; here the whitelist only
// bounds the argument shapes and encodes them into the contract routes.

function invalidResponse(message) {
  return {
    ok: false,
    response: {
      status: 400,
      body: { code: "docs_request_invalid", message, retryable: false },
    },
  };
}

function parseDocsViewOptions(options) {
  if (options === undefined || options === null) return { ok: true, archived: false };
  if (!isPlainObject(options)) return invalidResponse("options must be an object");
  const keys = Object.keys(options).sort();
  if (keys.length === 0) return { ok: true, archived: false };
  if (keys.join(",") !== "archived") {
    return invalidResponse("options must carry only {archived?}");
  }
  if (options.archived !== true && options.archived !== false) {
    return invalidResponse("archived must be a boolean");
  }
  return { ok: true, archived: options.archived === true };
}

function validateDocsListRequest(positionId, options) {
  if (typeof positionId !== "string" || positionId.length === 0) {
    return invalidResponse("positionId required");
  }
  const parsed = parseDocsViewOptions(options);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    pathname: `/docs/list?position=${encodeURIComponent(positionId)}${parsed.archived ? "&archived=1" : ""}`,
  };
}

function validateDocsReadRequest(positionId, filePath, options) {
  if (typeof positionId !== "string" || positionId.length === 0) {
    return invalidResponse("positionId required");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    return invalidResponse("filePath required");
  }
  const parsed = parseDocsViewOptions(options);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    pathname: `/docs/read?position=${encodeURIComponent(positionId)}&path=${encodeURIComponent(filePath)}${parsed.archived ? "&archived=1" : ""}`,
  };
}

function authorizeDocsIpcSender(event, expectedWindow, allowedUrl) {
  const { isTrustedWindowSender } = require("./window-ipc.cjs");
  if (!isTrustedWindowSender(event, expectedWindow, allowedUrl)) {
    return { ok: false, response: { status: 403, body: { message: "Untrusted sender" } } };
  }
  return { ok: true };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDocsCreateRequest(request) {
  if (!isPlainObject(request)) return invalidResponse("request must be an object");
  const keys = Object.keys(request).sort().join(",");
  if (keys !== "content,path,positionId") {
    return invalidResponse("request must carry exactly {positionId, path, content}");
  }
  if (
    typeof request.positionId !== "string" ||
    request.positionId.length === 0 ||
    typeof request.path !== "string" ||
    request.path.length === 0 ||
    typeof request.content !== "string"
  ) {
    return invalidResponse("positionId, path and content must be strings");
  }
  return {
    ok: true,
    request: { positionId: request.positionId, path: request.path, content: request.content },
  };
}

function validateDocsResolveRequest(request) {
  if (!isPlainObject(request)) return invalidResponse("request must be an object");
  if (Object.keys(request).sort().join(",") !== "ref") {
    return invalidResponse("request must carry exactly {ref}");
  }
  const ref = request.ref;
  if (!isPlainObject(ref) || typeof ref.uri !== "string" || ref.uri.length === 0) {
    return invalidResponse("ref must carry a uri string");
  }
  const allowed = ["uri", "anchor", "version"];
  if (Object.keys(ref).some((key) => !allowed.includes(key))) {
    return invalidResponse("ref must carry at most {uri, anchor?, version?}");
  }
  return { ok: true, request: { ref } };
}

function validateDocsWriteRequest(request) {
  return validateDocsCreateRequest(request);
}

function validateDocsRenameRequest(request) {
  if (!isPlainObject(request)) return invalidResponse("request must be an object");
  const keys = Object.keys(request).sort().join(",");
  if (keys !== "from,positionId,to") {
    return invalidResponse("request must carry exactly {positionId, from, to}");
  }
  if (
    typeof request.positionId !== "string" ||
    request.positionId.length === 0 ||
    typeof request.from !== "string" ||
    request.from.length === 0 ||
    typeof request.to !== "string" ||
    request.to.length === 0
  ) {
    return invalidResponse("positionId, from and to must be strings");
  }
  return {
    ok: true,
    request: { positionId: request.positionId, from: request.from, to: request.to },
  };
}

function validateDocsPathRequest(request) {
  if (!isPlainObject(request)) return invalidResponse("request must be an object");
  const keys = Object.keys(request).sort().join(",");
  if (keys !== "path,positionId") {
    return invalidResponse("request must carry exactly {positionId, path}");
  }
  if (
    typeof request.positionId !== "string" ||
    request.positionId.length === 0 ||
    typeof request.path !== "string" ||
    request.path.length === 0
  ) {
    return invalidResponse("positionId and path must be strings");
  }
  return { ok: true, request: { positionId: request.positionId, path: request.path } };
}

function validateDocsDeleteRequest(request) {
  if (!isPlainObject(request)) return invalidResponse("request must be an object");
  const keys = Object.keys(request).sort().join(",");
  if (keys !== "path,positionId" && keys !== "archived,path,positionId") {
    return invalidResponse("request must carry exactly {positionId, path} or {positionId, path, archived}");
  }
  if (
    typeof request.positionId !== "string" ||
    request.positionId.length === 0 ||
    typeof request.path !== "string" ||
    request.path.length === 0
  ) {
    return invalidResponse("positionId and path must be strings");
  }
  if (request.archived !== undefined && typeof request.archived !== "boolean") {
    return invalidResponse("archived must be a boolean");
  }
  const parsed = { positionId: request.positionId, path: request.path };
  if (request.archived === true) parsed.archived = true;
  return { ok: true, request: parsed };
}

module.exports = {
  validateDocsListRequest,
  validateDocsReadRequest,
  validateDocsCreateRequest,
  validateDocsResolveRequest,
  validateDocsWriteRequest,
  validateDocsRenameRequest,
  validateDocsPathRequest,
  validateDocsDeleteRequest,
  authorizeDocsIpcSender,
};
