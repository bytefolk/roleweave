const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => ({ status: 400, body: { code: "approval_request_invalid", message: "Invalid approval request", retryable: false } });
const object = value => value && typeof value === "object" && !Array.isArray(value);
async function approvalList(request, apiRequest) {
  if (!object(request) || Object.keys(request).some(k => !["workspacePath", "cursor"].includes(k)) ||
      typeof request.workspacePath !== "string" || !request.workspacePath || request.workspacePath.length > 4096 ||
      (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 128))) return invalid();
  const query = new URLSearchParams({ workspacePath: request.workspacePath, limit: "200" });
  if (request.cursor) query.set("cursor", request.cursor);
  return apiRequest(`/approvals?${query}`);
}
async function approvalDecision(request, apiRequest) {
  if (!object(request) || Object.keys(request).some(k => !["id", "workspaceToken", "requestId", "expectedVersion", "decision", "reason", "delegatedFrom"].includes(k)) ||
      typeof request.id !== "string" || !/^[a-f0-9]{64}$/.test(request.id) ||
      typeof request.workspaceToken !== "string" || !UUID.test(request.workspaceToken) ||
      typeof request.requestId !== "string" || !UUID.test(request.requestId) ||
      !Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1 || !["granted", "denied"].includes(request.decision) ||
      (request.reason !== undefined && (typeof request.reason !== "string" || !request.reason.trim() || Buffer.byteLength(request.reason, "utf8") > 1024)) ||
      (request.delegatedFrom !== undefined && (typeof request.delegatedFrom !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(request.delegatedFrom)))) return invalid();
  const { id, ...body } = request;
  return apiRequest(`/approvals/${id}/decision`, { method: "POST", body });
}
module.exports = { approvalList, approvalDecision };
