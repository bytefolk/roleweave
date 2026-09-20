/**
 * Per-deployment login session model (#395).
 *
 * Each deployment (local control plane or remote server) gets its own session,
 * similar to git-credentials: one identity + token per URL. Tokens are stored
 * encrypted via Electron safeStorage and never enter the renderer plaintext.
 */

export interface DeploymentSession {
  /** Normalized deployment URL (origin + optional base path). */
  deploymentUrl: string;
  provider: "local" | "remote";
  /** Email or identity string. */
  accountIdentity: string;
  /** Session token — encrypted at rest, never exposed to renderer. */
  token: string;
  /** ISO-8601 expiry or null for no expiry. */
  expiresAt: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Metadata returned to the renderer (no token). */
export interface DeploymentSessionSummary {
  deploymentUrl: string;
  provider: "local" | "remote";
  accountIdentity: string;
  expiresAt: string | null;
  createdAt: string;
}
