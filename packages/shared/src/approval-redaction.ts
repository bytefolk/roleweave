/**
 * Remove credential material from text that may cross the approval UI/API
 * boundary. Keep this browser-safe: renderer fallbacks use it too.
 */
export function redactApprovalSecrets(value: string): string {
  let result = value;
  result = result.replace(/(https?:\/\/)([^/\s:@]+):([^@\s]+)@/gi, "$1[redacted]@");
  result = result.replace(/([?&](?:access[_-]?token|api[_-]?key|auth|credential|password|secret|token)=)[^&\s]+/gi, "$1[redacted]");
  result = result.replace(/(\b(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*(?:Bearer\s+)?)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
  result = result.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  return result;
}
