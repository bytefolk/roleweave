/** Presentation-only redaction for legacy records whose server projection
 * predates approval context. The server also redacts public views; keeping a
 * renderer guard prevents a raw fixture or older control plane from putting a
 * credential into the approval drawer. */
export function safeApprovalText(value: string): string {
  let result = value;
  result = result.replace(/(https?:\/\/)([^/\s:@]+):([^@\s]+)@/gi, "$1[redacted]@");
  result = result.replace(/([?&](?:access[_-]?token|api[_-]?key|auth|credential|password|secret|token)=)[^&\s]+/gi, "$1[redacted]");
  result = result.replace(/(\b(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
  result = result.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  return result;
}
