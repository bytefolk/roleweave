// Project consent crosses a narrow, authenticated control-plane surface.
const invalid = () => ({ status: 400, body: { code: "experiments_request_invalid", message: "Invalid experiment request", retryable: false } });
const object = value => value && typeof value === "object" && !Array.isArray(value);
const pathValid = value => typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.includes("\0");
const scopeValid = request => object(request) && pathValid(request.workspacePath) &&
  typeof request.workspaceSession === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.workspaceSession) &&
  Number.isSafeInteger(request.revision) && request.revision >= 0;

async function experimentsGet(workspacePath, apiRequest) {
  if (!pathValid(workspacePath)) return invalid();
  return apiRequest(`/experiments?${new URLSearchParams({ workspacePath })}`);
}

async function experimentsUpdate(request, apiRequest) {
  if (!scopeValid(request) || typeof request.enabled !== "boolean" ||
      Object.keys(request).some(key => !["workspacePath", "workspaceSession", "revision", "enabled"].includes(key))) return invalid();
  return apiRequest("/experiments", { method: "PATCH", body: request });
}

async function reportsAdvice(request, apiRequest) {
  if (!scopeValid(request) || Object.keys(request).some(key => !["workspacePath", "workspaceSession", "revision"].includes(key))) return invalid();
  return apiRequest("/reports/advice", { method: "POST", body: request });
}

module.exports = { experimentsGet, experimentsUpdate, reportsAdvice };
