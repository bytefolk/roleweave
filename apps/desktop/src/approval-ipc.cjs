// IPC boundary wrapper for the #193 pendingApproval verdict field (#46):
// the fail-closed checks live in @roleweave/shared/pending-approval
// (single source, shared with the control-plane HTTP route); this module only
// shapes the result into the IPC 400 response envelope.
const { validatePendingApproval: checkPendingApproval } = require("@roleweave/shared/pending-approval");

function validatePendingApproval(value) {
  const checked = checkPendingApproval(value);
  if (!checked.ok) {
    return {
      ok: false,
      response: { status: 400, body: { code: "turn_request_invalid", message: checked.message, retryable: false } },
    };
  }
  return checked;
}

module.exports = { validatePendingApproval };
