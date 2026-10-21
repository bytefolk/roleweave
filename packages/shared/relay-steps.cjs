// Shared HTTP, desktop IPC and durable-message boundary for explicit relay steps.
const { isPositionId } = require("./position-id.cjs");
const MAX_RELAY_INSTRUCTION_BYTES = 4 * 1024;
const MAX_RELAY_INSTRUCTIONS_BYTES = 32 * 1024;
function isRelaySteps(value, mentions, mode) {
  if (mode !== "relay" || !Array.isArray(value) || value.length > 32) return false;
  const seen = new Set();
  let total = 0;
  return value.every(step => {
    if (!step || typeof step !== "object" || Array.isArray(step) ||
        Object.keys(step).sort().join(",") !== "instruction,positionId" ||
        !isPositionId(step.positionId) || !mentions.includes(step.positionId) || seen.has(step.positionId) ||
        typeof step.instruction !== "string" || !step.instruction.trim()) return false;
    const bytes = Buffer.byteLength(step.instruction, "utf8");
    total += bytes;
    seen.add(step.positionId);
    return bytes <= MAX_RELAY_INSTRUCTION_BYTES && total <= MAX_RELAY_INSTRUCTIONS_BYTES;
  });
}
module.exports = { MAX_RELAY_INSTRUCTION_BYTES, MAX_RELAY_INSTRUCTIONS_BYTES, isRelaySteps };
