export const CREDENTIAL_FIELDS = [
  { host: "Qoder", key: "QODER_PERSONAL_ACCESS_TOKEN", label: "credentials.token" },
  { host: "Claude", key: "ANTHROPIC_API_KEY", label: "credentials.apiKey" },
  { host: "Claude", key: "ANTHROPIC_AUTH_TOKEN", label: "credentials.authToken" },
  { host: "Claude", key: "ANTHROPIC_BASE_URL", label: "credentials.baseUrl" },
  { host: "Codex", key: "OPENAI_API_KEY", label: "credentials.apiKey" },
  { host: "Codex", key: "OPENAI_BASE_URL", label: "credentials.baseUrl" },
] as const;

export type CredentialKey = typeof CREDENTIAL_FIELDS[number]["key"];
export type CredentialView = { key: CredentialKey; configured: boolean; last4: string | null };
export type SettingsResult = { ok: true } | { ok: false; code: "invalid_value" | "storage_unavailable" | "untrusted_sender" };
export type SettingsSnapshot = { ok: true; storageAvailable: boolean; credentials: CredentialView[] } | Exclude<SettingsResult, { ok: true }>;

export function validCredential(key: CredentialKey, value: string): boolean {
  if (value.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(value)) return false;
  if (!key.endsWith("_BASE_URL")) return value.length >= 5;
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const local = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return !!url.hostname && (url.protocol === "https:" || (url.protocol === "http:" && local)) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Explicit projection keeps unexpected bridge properties out of React state. */
export function credentialViews(value: unknown): CredentialView[] | null {
  if (!Array.isArray(value) || value.length !== CREDENTIAL_FIELDS.length) return null;
  const rows: CredentialView[] = [];
  for (const { key } of CREDENTIAL_FIELDS) {
    const entries = value.filter((entry) => entry?.key === key);
    if (entries.length !== 1) return null;
    const entry = entries[0];
    if (typeof entry.configured !== "boolean" ||
        (entry.configured ? typeof entry.last4 !== "string" || entry.last4.length !== 4 || /[\s\x00-\x1f\x7f]/u.test(entry.last4) : entry.last4 !== null)) return null;
    rows.push({ key, configured: entry.configured, last4: entry.last4 });
  }
  return rows;
}
