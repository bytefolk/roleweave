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
  if (!object(request) || Object.keys(request).some(k => !["id", "workspaceToken", "requestId", "expectedVersion", "decision", "reason", "scope", "delegatedFrom"].includes(k)) ||
      typeof request.id !== "string" || !/^[a-f0-9]{64}$/.test(request.id) ||
      typeof request.workspaceToken !== "string" || !UUID.test(request.workspaceToken) ||
      typeof request.requestId !== "string" || !UUID.test(request.requestId) ||
      !Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1 || !["granted", "denied"].includes(request.decision) ||
      (request.scope !== undefined && !["once", "run"].includes(request.scope)) ||
      (request.reason !== undefined && (typeof request.reason !== "string" || !request.reason.trim() || Buffer.byteLength(request.reason, "utf8") > 1024)) ||
      (request.delegatedFrom !== undefined && (typeof request.delegatedFrom !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(request.delegatedFrom)))) return invalid();
  const { id, ...body } = request;
  return apiRequest(`/approvals/${id}/decision`, { method: "POST", body });
}
async function approvalBatchDecision(request, apiRequest) {
  if (!object(request) || Object.keys(request).some(k => !["workspaceToken", "requestId", "decision", "reason", "items"].includes(k)) ||
      typeof request.workspaceToken !== "string" || !UUID.test(request.workspaceToken) ||
      typeof request.requestId !== "string" || !UUID.test(request.requestId) || request.decision !== "granted" ||
      (request.reason !== undefined && (typeof request.reason !== "string" || !request.reason.trim() || Buffer.byteLength(request.reason, "utf8") > 1024)) ||
      !Array.isArray(request.items) || request.items.length < 2 || request.items.length > 32 ||
      request.items.some(item => !object(item) || Object.keys(item).some(k => !["id", "expectedVersion"].includes(k) || typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1)) ||
      new Set(request.items.map(item => item.id)).size !== request.items.length) return invalid();
  return apiRequest("/approvals/batch/decision", { method: "POST", body: request });
}
module.exports = { approvalList, approvalDecision, approvalBatchDecision };
