import { digest, serializeContextPayload } from "./context-snapshot.js";
export { digest } from "./context-snapshot.js";
import { isPositionId } from "@roleweave/shared";
import type { GroupMessage, RelayHandoffPayload, RelayHandoffSnapshot, TurnRecord } from "@roleweave/shared";

/** Server-owned facts, never accepted from a request body. Sources are compact
 * visible projections of completed records, in accepted spawn order. */
export interface RelayExecutionContext {
  message: Pick<GroupMessage, "conversationRef" | "messageId" | "input" | "mentions" | "spawns" | "relaySteps">;
  sources: Array<Pick<TurnRecord, "turnId" | "positionId" | "conversationRef" | "updatedAt" | "status" | "output"> & { redacted?: boolean; truncated?: boolean }>;
}
export interface RelayAssemblyContext extends RelayExecutionContext { turnId: string; positionId: string; generatedAt: string }

/** Key ordering is independent of JSON reader/property insertion order. */
export function serializeRelayHandoff(payload: RelayHandoffPayload): string {
  return serializeContextPayload(payload);
}
export function snapshotRelayHandoff(payload: RelayHandoffPayload): RelayHandoffSnapshot {
  const text = serializeRelayHandoff(payload);
  return { payload, payloadBytes: Buffer.byteLength(text, "utf8"), payloadDigest: digest(text) };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function id(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 128; }
function text(value: unknown, max: number): value is string { return typeof value === "string" && Buffer.byteLength(value, "utf8") <= max; }
function integer(value: unknown, min: number, max: number): boolean { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max; }

export function isRelayHandoffSnapshot(value: unknown, validTimestamp: (value: unknown) => boolean): value is RelayHandoffSnapshot {
  if (!record(value) || !keys(value, ["payload", "payloadBytes", "payloadDigest"]) || !record(value.payload)) return false;
  const p = value.payload;
  if (!keys(p, ["schemaVersion", "generatedAt", "conversationRef", "messageId", "turnId", "step", "taskExcerpt", "instruction", "sources", "omittedSourceCount", "taskExcerptTruncated", "redacted"]) ||
      p.schemaVersion !== "relay-handoff.v1" || !validTimestamp(p.generatedAt) ||
      !id(p.conversationRef) || !id(p.messageId) || !id(p.turnId) || !record(p.step) ||
      !text(p.taskExcerpt, 2048) || !(p.instruction === null || (text(p.instruction, 4096) && p.instruction.trim().length > 0)) ||
      typeof p.taskExcerptTruncated !== "boolean" || typeof p.redacted !== "boolean" ||
      !Array.isArray(p.sources) || p.sources.length > 12 || !integer(p.omittedSourceCount, 0, 31)) return false;
  const step = p.step;
  if (!keys(step, ["positionId", "number", "total"], ["nextPositionId"]) || !isPositionId(step.positionId) ||
      !integer(step.total, 1, 32) || !integer(step.number, 1, step.total as number) ||
      ((step.number === step.total) ? Object.hasOwn(step, "nextPositionId") : (!isPositionId(step.nextPositionId) || step.nextPositionId === step.positionId)) ||
      p.sources.length + (p.omittedSourceCount as number) !== (step.number as number) - 1) return false;
  const turns = new Set<string>();
  const positions = new Set<string>();
  for (const source of p.sources) {
    if (!record(source) || !keys(source, ["turnId", "positionId", "sourceUpdatedAt", "outputExcerpt", "excerptDigest", "truncated", "redacted"]) ||
        !id(source.turnId) || source.turnId === p.turnId || turns.has(source.turnId) ||
        !isPositionId(source.positionId) || source.positionId === step.positionId || source.positionId === step.nextPositionId || positions.has(source.positionId) ||
        !validTimestamp(source.sourceUpdatedAt) || !text(source.outputExcerpt, 8192) || source.excerptDigest !== digest(source.outputExcerpt) ||
        typeof source.truncated !== "boolean" || typeof source.redacted !== "boolean" || (source.redacted && !p.redacted)) return false;
    turns.add(source.turnId); positions.add(source.positionId);
  }
  if ((step.number as number) > 1 && p.sources.length === 0) return false;
  const serialized = serializeRelayHandoff(p as unknown as RelayHandoffPayload);
  return Buffer.byteLength(serialized, "utf8") <= 64 * 1024 && value.payloadBytes === Buffer.byteLength(serialized, "utf8") && value.payloadDigest === digest(serialized);
}
