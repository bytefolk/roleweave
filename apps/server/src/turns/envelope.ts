import crypto from "node:crypto";
import type { TurnEnvelope, TurnPendingApproval } from "@roleweave/shared";
import {
  TURN_ENVELOPE_SCHEMA_VERSION,
  TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2,
} from "@roleweave/shared";

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** Exact mirror of digital-employee computeEnvelopeDigest at 0c4cd54. */
export function computeEnvelopeDigest(body: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalJson(body));
  return `sha256:${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

const CONVERSATION_REF_MAX_LENGTH = 256;

/** Upstream schema bound (DE-CONVREF-001): string, minLength 1, maxLength 256. */
export function isValidConversationRef(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= CONVERSATION_REF_MAX_LENGTH
  );
}

export function createTurnEnvelope(input: {
  workspaceRef: string;
  positionId: string;
  turnId: string;
  message: string;
  /** Operator verdict for a resume turn (#193); included in the digest. */
  pendingApproval?: TurnPendingApproval;
  /** Contract-level back-link (de#205); included in the digest when present. */
  conversationRef?: string;
}): TurnEnvelope {
  if (input.conversationRef !== undefined && !isValidConversationRef(input.conversationRef)) {
    throw new Error(
      "conversationRef must be a non-empty string no longer than 256 characters",
    );
  }
  // Field⇔schemaVersion are paired strictly (#63 升级口径): presence upgrades
  // to v1alpha2, absence keeps v1 byte-exact. The "v1 + field" combination is
  // never produced, pre-empting the upstream fail-closed engine.input_invalid.
  const hasRef = input.conversationRef !== undefined;
  const body = {
    schemaVersion: hasRef ? TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2 : TURN_ENVELOPE_SCHEMA_VERSION,
    workspaceRef: input.workspaceRef,
    positionId: input.positionId,
    turnId: input.turnId,
    input: input.message,
    ...(input.pendingApproval !== undefined
      ? { pendingApproval: input.pendingApproval }
      : {}),
    ...(hasRef ? { conversationRef: input.conversationRef } : {}),
  };
  return { ...body, envelopeDigest: computeEnvelopeDigest(body) };
}
