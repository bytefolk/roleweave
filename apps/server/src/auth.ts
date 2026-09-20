import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Per-boot random bearer token (32 random bytes, hex). Never persisted. */
export function createBootToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Constant-time bearer token check. */
export function bearerAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const given = match?.[1];
  if (!given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The bearer credential authenticates one local operator identity.  Do not
 * accept an actor id from HTTP input: that would turn audit attribution into a
 * client assertion. */
export function authenticatedActor(req: IncomingMessage, token: string, actorId: string): string | undefined {
  return bearerAuthorized(req, token) ? actorId : undefined;
}
