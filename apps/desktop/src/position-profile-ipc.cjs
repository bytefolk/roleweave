// IPC boundary gate for PATCH /positions/:id/profile. Mirrors the control
// plane's request gate at reduced depth: shape and bounds only, fail-closed.
// The control plane stays authoritative — it re-validates the whole patch and
// is the only side that knows the Skill / MCP catalogs, so a grant that is
// structurally fine but not registered must be rejected there, never here.
const { isPositionId } = require("@roleweave/shared/position-id");

const MODES = new Set(["read_only", "approval_required"]);
const SCOPES = new Set(["position", "workspace", "project"]);
const ACTIONS = new Set(["read", "create", "update", "delete", "execute"]);
const EFFECTS = new Set(["allow", "deny"]);
const PATCH_KEYS = new Set(["positionId", "name", "mode", "permissions"]);
const PERMISSION_KEYS = new Set(["tools", "rules", "skills", "mcpServers"]);
/** Mirrors the control plane's MAX_NAME_BYTES (UTF-8 bytes, not code units). */
const MAX_NAME_BYTES = 128;
const MAX_TOOLS = 32;
const MAX_TOOL_LENGTH = 64;
const MAX_RULES = 64;
const MAX_RULE_RESOURCE_LENGTH = 512;
const MAX_ACTIONS_PER_RULE = 5;
const MAX_SKILLS = 32;
const MAX_MCP_SERVERS = 16;

function invalid(message) {
  return { status: 400, body: { code: "position_profile_invalid", message, retryable: false } };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePermissions(value) {
  if (!isPlainObject(value)) return "permissions must be an object";
  for (const key of Object.keys(value)) {
    if (!PERMISSION_KEYS.has(key)) return `permissions.${key} is not part of the permission shape`;
  }
  if (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS ||
      !value.tools.every((tool) => typeof tool === "string" && tool.length > 0 && tool.length <= MAX_TOOL_LENGTH)) {
    return "permissions.tools must be a bounded string array";
  }
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) return "permissions.rules must be a bounded array";
  for (const [index, rule] of value.rules.entries()) {
    if (!isPlainObject(rule)) return `permissions.rules[${index}] must be an object`;
    if (!SCOPES.has(rule.scope)) return `permissions.rules[${index}].scope is invalid`;
    if (typeof rule.resource !== "string" || rule.resource.trim().length === 0 || rule.resource.length > MAX_RULE_RESOURCE_LENGTH) {
      return `permissions.rules[${index}].resource is invalid`;
    }
    if (!Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.length > MAX_ACTIONS_PER_RULE ||
        !rule.actions.every((action) => ACTIONS.has(action))) {
      return `permissions.rules[${index}].actions are invalid`;
    }
    if (rule.effect !== undefined && !EFFECTS.has(rule.effect)) return `permissions.rules[${index}].effect is invalid`;
    if (rule.approval !== undefined && typeof rule.approval !== "boolean") return `permissions.rules[${index}].approval is invalid`;
  }
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills) || value.skills.length > MAX_SKILLS) return "permissions.skills must be a bounded array";
    for (const [index, skill] of value.skills.entries()) {
      if (!isPlainObject(skill) || typeof skill.id !== "string" || skill.id.length === 0) return `permissions.skills[${index}] is invalid`;
      if (skill.version !== undefined && typeof skill.version !== "string") return `permissions.skills[${index}].version is invalid`;
    }
  }
  if (value.mcpServers !== undefined) {
    if (!Array.isArray(value.mcpServers) || value.mcpServers.length > MAX_MCP_SERVERS) return "permissions.mcpServers must be a bounded array";
    for (const [index, server] of value.mcpServers.entries()) {
      if (!isPlainObject(server) || typeof server.id !== "string" || server.id.length === 0) return `permissions.mcpServers[${index}] is invalid`;
      if (!Array.isArray(server.tools) || !server.tools.every((tool) => typeof tool === "string")) return `permissions.mcpServers[${index}].tools is invalid`;
    }
  }
  return null;
}

function validatePositionProfileRequest(value) {
  if (!isPlainObject(value)) {
    return { ok: false, response: invalid("profile update must be an object") };
  }
  for (const key of Object.keys(value)) {
    if (!PATCH_KEYS.has(key)) {
      return { ok: false, response: invalid(`unknown field: ${key}`) };
    }
  }
  if (!isPositionId(value.positionId)) {
    return { ok: false, response: invalid("positionId is invalid") };
  }
  // The position id is the route, not a patchable field: rename of the id is a
  // migration, and an empty patch would report success while changing nothing.
  if (value.name === undefined && value.mode === undefined && value.permissions === undefined) {
    return { ok: false, response: invalid("profile update must change at least one of name, mode, permissions") };
  }
  if (value.name !== undefined) {
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, response: invalid("name must be a non-empty string") };
    }
    if (Buffer.byteLength(value.name.trim(), "utf8") > MAX_NAME_BYTES) {
      return { ok: false, response: invalid(`name must be no larger than ${MAX_NAME_BYTES} bytes`) };
    }
  }
  if (value.mode !== undefined && !MODES.has(value.mode)) {
    return { ok: false, response: invalid("mode must be read_only or approval_required") };
  }
  if (value.permissions !== undefined) {
    const reason = validatePermissions(value.permissions);
    if (reason !== null) return { ok: false, response: invalid(reason) };
  }
  return { ok: true, request: value };
}

module.exports = { validatePositionProfileRequest };
