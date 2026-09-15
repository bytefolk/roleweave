// Small, fail-closed IPC gate for POST /avatar/generate. The renderer supplies
// employee context only; the control plane owns the fixed image prompt.
const MAX_BRIEF_LENGTH = 320;

function invalid(message) {
  return { status: 400, body: { code: "avatar_request_invalid", message, retryable: false } };
}

function validateAvatarGenerateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: invalid("avatar request must be an object") };
  }
  if (Object.keys(value).length !== 1 || !("brief" in value)) {
    return { ok: false, response: invalid("avatar request only accepts brief") };
  }
  if (typeof value.brief !== "string") return { ok: false, response: invalid("brief must be a string") };
  const brief = value.brief.replace(/\s+/g, " ").trim();
  if (brief.length < 2 || brief.length > MAX_BRIEF_LENGTH) {
    return { ok: false, response: invalid(`brief must be between 2 and ${MAX_BRIEF_LENGTH} characters`) };
  }
  return { ok: true, request: { brief } };
}

module.exports = { validateAvatarGenerateRequest };
