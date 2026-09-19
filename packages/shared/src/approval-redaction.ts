function redactUrlCredentials(value: string): string {
  const lower = value.toLowerCase();
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const http = lower.indexOf("http://", cursor);
    const https = lower.indexOf("https://", cursor);
    const start = http === -1 ? https : https === -1 ? http : Math.min(http, https);
    if (start === -1) return result + value.slice(cursor);

    const protocolEnd = start + (lower.startsWith("https://", start) ? 8 : 7);
    let authorityEnd = protocolEnd;
    while (authorityEnd < value.length && !"/?# \t\r\n".includes(value[authorityEnd]!)) authorityEnd++;
    const authority = value.slice(protocolEnd, authorityEnd);
    const separator = authority.indexOf(":");
    const at = authority.lastIndexOf("@");
    result += value.slice(cursor, protocolEnd);
    result += separator >= 0 && at > separator ? `[redacted]@${authority.slice(at + 1)}` : authority;
    cursor = authorityEnd;
  }
  return result;
}

/**
 * Remove credential material from text that may cross the approval UI/API
 * boundary. Keep this browser-safe: renderer fallbacks use it too.
 */
export function redactApprovalSecrets(value: string): string {
  let result = redactUrlCredentials(value);
  result = result.replace(/([?&](?:access[_-]?token|api[_-]?key|auth|credential|password|secret|token)=)[^&\s]+/gi, "$1[redacted]");
  result = result.replace(/(\b(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*(?:Bearer\s+)?)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
  result = result.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  return result;
}
