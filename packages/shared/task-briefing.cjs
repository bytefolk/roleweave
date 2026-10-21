/** Opt-in delegation request. Snapshot contents are exclusively server-owned. */
function isTaskBriefingRequest(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "expectedUpdatedAt,expectedWorkspacePath" &&
    typeof value.expectedWorkspacePath === "string" && value.expectedWorkspacePath.trim().length > 0 &&
    value.expectedWorkspacePath.length <= 4096 && !value.expectedWorkspacePath.includes("\0") &&
    typeof value.expectedUpdatedAt === "string" && value.expectedUpdatedAt.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expectedUpdatedAt) &&
    Number.isFinite(Date.parse(value.expectedUpdatedAt));
}
module.exports = { isTaskBriefingRequest };
