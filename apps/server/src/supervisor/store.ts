import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";

/**
 * Additive #635: in-memory supervisor pairings for external read-only fleet
 * dashboards (e.g. an Orca supervisor plugin).
 *
 * Discipline (docs/api-contract-v0.md §4):
 * - Tokens are 32 random bytes (hex), created through the same constructor as
 *   the operator boot token. Only the SHA-256 digest is retained, and only in
 *   process memory — a control-plane restart invalidates every pairing. This
 *   is a feature, not a limitation: nothing to leak from disk, and the pairing
 *   flow is cheap to repeat on each desktop launch.
 * - Verification is constant-time over digests, mirroring `bearerAuthorized`.
 * - A supervisor token authorizes exactly two GET paths (snapshot + SSE
 *   events); the router owns the allowlist, the store only answers "which
 *   pairing id, if any, does this token belong to".
 */

export interface SupervisorPairing {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  lastUsedAt: string | null;
}

interface SupervisorPairingEntry extends SupervisorPairing {
  readonly tokenHash: Buffer;
}

/** Additive #635: active pairings are bounded to keep the surface auditable. */
export const MAX_SUPERVISOR_PAIRINGS = 8;

export interface SupervisorPairingView {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export function createSupervisorToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Additive #639: tears down one live SSE connection (idempotent). */
export type SupervisorConnectionCloser = () => void;

export class SupervisorStore {
  private readonly pairings = new Map<string, SupervisorPairingEntry>();
  /** Additive #639: live SSE connections per pairing id, so revocation can cut them. */
  private readonly connections = new Map<string, Set<SupervisorConnectionCloser>>();

  /** Creates a pairing; returns the plaintext token exactly once. */
  pair(label: string): { id: string; token: string; createdAt: string } {
    if (this.pairings.size >= MAX_SUPERVISOR_PAIRINGS) {
      throw new OrgApiError(errorCodes.supervisor_pairing_limit, 409, "supervisor pairing limit reached; revoke a pairing first");
    }
    const id = crypto.randomUUID();
    const token = createSupervisorToken();
    const createdAt = new Date().toISOString();
    this.pairings.set(id, {
      id,
      label,
      createdAt,
      lastUsedAt: null,
      tokenHash: sha256(token),
    });
    return { id, token, createdAt };
  }

  list(): SupervisorPairingView[] {
    return [...this.pairings.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt, "en"))
      .map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  has(pairingId: string): boolean {
    return this.pairings.has(pairingId);
  }

  /**
   * Additive #639: associates a live SSE connection with its pairing id so
   * `revoke` can immediately end already-established streams. Auth happens at
   * connect time only, so a pairing deleted afterwards must be able to reach
   * the still-open socket — the returned function unregisters the hook
   * (idempotent, safe to call from the stream's own close handler).
   */
  registerConnection(pairingId: string, close: SupervisorConnectionCloser): () => void {
    let set = this.connections.get(pairingId);
    if (set === undefined) {
      set = new Set();
      this.connections.set(pairingId, set);
    }
    set.add(close);
    return () => {
      const current = this.connections.get(pairingId);
      if (current === undefined) return;
      current.delete(close);
      if (current.size === 0) this.connections.delete(pairingId);
    };
  }

  /**
   * Additive #639 (review round 2): number of live SSE connections currently
   * retained for a pairing. Read-only visibility for tests and operator
   * diagnostics — after the unregister fix this must return to 0 once every
   * stream under the pairing has ended, for any end reason.
   */
  connectionCount(pairingId: string): number {
    return this.connections.get(pairingId)?.size ?? 0;
  }

  /**
   * Revokes a pairing and — additive #639 — immediately closes every live
   * SSE connection registered under it, so a deleted pairing stops receiving
   * events on long-lived streams. Returns false when the id is unknown or
   * already gone (revocation of connections still runs in that case).
   */
  revoke(pairingId: string): boolean {
    const existed = this.pairings.delete(pairingId);
    const closers = this.connections.get(pairingId);
    if (closers !== undefined) {
      this.connections.delete(pairingId);
      for (const close of closers) {
        try {
          close();
        } catch {
          // A half-broken socket must not block revocation of the others.
        }
      }
    }
    return existed;
  }

  /**
   * Constant-time verification of a bearer token against retained digests.
   * Returns the owning pairing id, or null. A successful read touches
   * `lastUsedAt` so the operator can see which pairing is actually in use.
   *
   * The Authorization header is parsed without a backtracking regex (the
   * header is attacker-controlled input; js/polynomial-redos): a whitespace
   * split has no nested quantifiers and cannot blow up on adversarial input.
   */
  verifyRequest(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header !== "string") return null;
    const parts = header.split(/\s+/).filter((part) => part.length > 0);
    if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer") return null;
    const given = parts[1]!;
    const digest = sha256(given);
    for (const entry of this.pairings.values()) {
      if (crypto.timingSafeEqual(digest, entry.tokenHash)) {
        entry.lastUsedAt = new Date().toISOString();
        return entry.id;
      }
    }
    // Still burn a comparison against every retained digest so timing does
    // not reveal how many pairings exist.
    for (let index = 0; index < MAX_SUPERVISOR_PAIRINGS - this.pairings.size; index++) {
      crypto.timingSafeEqual(digest, digest);
    }
    return null;
  }
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}
