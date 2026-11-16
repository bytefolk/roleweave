import type { SseEventEnvelope } from "@roleweave/shared";

/**
 * Additive #639 (review hardening): server-side field projection for
 * supervisor SSE consumers.
 *
 * A supervisor token unlocks GET /events. Without a projection that stream
 * carries model output (`turn.model.delta`), task titles and step messages
 * (`turn.progress`), approval action descriptions (`turn.approval.requested`),
 * trace details and failure diagnostics — exactly the payload text an
 * external dashboard must not read. A reference client printing only metadata
 * is a display choice, not a security boundary; this module is the boundary.
 *
 * Discipline:
 * - Per-type payload field allowlist over scalar values only
 *   (string | number | boolean | null). Nested objects and arrays never pass.
 * - Event types without an allowlist entry are dropped entirely for the
 *   supervisor consumer (fail closed).
 * - Applied to both the Last-Event-ID replay and the live push, so a resumed
 *   supervisor stream cannot read projected-out text from the ring buffer.
 * - The operator stream is never projected; its semantics stay frozen by the
 *   v0 contract (docs/api-contract-v0.md §2.10).
 */

const SUPERVISOR_PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "org.updated": ["workspace", "version"],
  "turn.started": ["runId", "positionId", "turnId", "engine", "sessionId", "workspacePath"],
  "turn.usage": ["runId", "positionId", "turnId", "inputTokens", "outputTokens", "totalTokens", "workspacePath"],
  "turn.completed": ["runId", "positionId", "turnId", "workspacePath"],
  "turn.failed": ["runId", "positionId", "turnId", "workspacePath"],
  "turn.indeterminate": ["code", "positionId", "turnId", "envelopeDigest", "workspacePath"],
  // Review round 2: the only producer of this type is ProgressTracker.publish()
  // (apps/server/src/turns/progress.ts), which emits TaskProgressEvent —
  // stepIndex/stepStatus/totalSteps/timestamp — not the TaskProgressSnapshot
  // shape (currentStep/overallStatus/updatedAt) the first allowlist guessed.
  // Safe step names come from the fixed WORKBENCH_PROGRESS_STEPS constant, so
  // stepName is metadata too; taskTitle/employeeName/message and the
  // step-detail objects stay projected out.
  "turn.progress": [
    "taskId",
    "employeeId",
    "positionId",
    "stepIndex",
    "stepName",
    "stepStatus",
    "totalSteps",
    "progress",
    "timestamp",
    "retryOf",
    "retryCount",
  ],
  // Approval action description/target/preview and the reason field never
  // cross to a supervisor consumer; only identifiers and expiry do.
  "turn.approval.requested": ["runId", "approvalId", "positionId", "turnId", "expiresAt", "workspacePath"],
  "turn.approval.granted": ["runId", "approvalId", "positionId", "turnId", "workspacePath"],
  "turn.approval.denied": ["runId", "approvalId", "positionId", "turnId", "workspacePath"],
  "approvals.changed": ["id", "version", "workspacePath"],
  "escalation.created": ["id", "positionId", "workspacePath"],
  "evidence.created": ["id", "positionId", "workspacePath"],
  "hire.progress": ["positionId", "phase"],
  "group.turn.spawned": ["groupRef", "conversationRef", "messageId", "positionId", "turnId", "sessionId", "workspacePath"],
  "group.relay.stop.suggested": ["groupRef", "messageId", "completedTurnId", "remainingCount", "probability", "expiresAt", "workspacePath"],
  "group.relay.stop.resolved": ["groupRef", "messageId", "decision", "workspacePath"],
  "group.updated": ["conversationRef", "groupRef", "workspacePath"],
  "goal.created": ["goalId", "workspacePath"],
  "goal.updated": ["goalId", "taskId", "acceptanceId", "deleted", "workspacePath"],
};

/**
 * Projects one envelope for a supervisor consumer. Returns null when the
 * event type is not part of the read-only supervisor surface.
 */
export function projectSupervisorEvent(event: SseEventEnvelope): SseEventEnvelope | null {
  const fields = SUPERVISOR_PAYLOAD_FIELDS[event.type];
  if (fields === undefined) return null;
  const source = event.payload as Record<string, unknown> | null | undefined;
  const payload: Record<string, unknown> = {};
  if (source !== null && typeof source === "object") {
    for (const field of fields) {
      const value = (source as Record<string, unknown>)[field];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        payload[field] = value;
      }
    }
  }
  return { seq: event.seq, type: event.type, at: event.at, payload };
}
