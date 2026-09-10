import { zhText } from "@roleweave/ui";
import type {
  EngineEvent,
  TurnHistory as ApiTurnHistory,
  TurnRecord as ApiTurnRecord,
} from "@roleweave/shared";
import type { TurnApprovalRequest, TurnProgressStep, TurnRecord } from "./types";

/** #146：展示兜底文案走目录；裸调用（测试/无 Provider）回退 zh 词。 */
function renderOutput(output: unknown, unrenderable: string): string | undefined {
  if (output === undefined) return undefined;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return unrenderable;
  }
}

/** A turn settled as engine.approval_required awaits an operator verdict;
 * project the requesting event so the renderer can render the card. */
function approvalRequest(record: ApiTurnRecord): TurnApprovalRequest | undefined {
  if (record.status !== "failed" || record.error?.code !== "engine.approval_required") {
    return undefined;
  }
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event === undefined) continue;
    if (event.type === "approval.requested") {
      return {
        approvalId: event.approvalId,
        kind: event.action.kind,
        description: event.action.description,
        ...(event.action.target !== undefined ? { target: event.action.target } : {}),
        ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Keep the useful execution shape while intentionally dropping raw event text
 * from the presentation model. The conversation UI needs to answer “where is
 * this run now?” rather than expose a private reasoning transcript.
 */
function progressSteps(record: ApiTurnRecord): TurnProgressStep[] {
  const steps: TurnProgressStep[] = [];
  const add = (kind: TurnProgressStep["kind"], at: string): void => {
    if (steps.at(-1)?.kind !== kind) steps.push({ kind, at });
  };

  for (const event of record.events as EngineEvent[]) {
    switch (event.type) {
      case "run.started":
        add("received", event.timestamp);
        break;
      case "model.delta":
        add("working", event.timestamp);
        break;
      case "approval.requested":
        add("awaiting_approval", event.timestamp);
        break;
      case "run.completed":
        add("completed", event.timestamp);
        break;
      case "run.failed":
        // engine.approval_required is represented as a retryable failed turn
        // by contract, but the user-facing state is still “waiting for
        // approval”, not a misleading terminal failure.
        if (steps.at(-1)?.kind !== "awaiting_approval") add("failed", event.timestamp);
        break;
      case "usage":
      case "approval.granted":
      case "approval.denied":
        break;
    }
  }

  if (steps.length === 0) {
    add("received", record.createdAt);
    if (record.status === "running") add("working", record.updatedAt);
    if (record.status === "completed") add("completed", record.updatedAt);
    if (record.status === "failed") add("failed", record.updatedAt);
    if (record.status === "indeterminate") add("unknown", record.updatedAt);
  } else if (record.status === "running" && steps.at(-1)?.kind === "received") {
    add("working", record.updatedAt);
  } else if (record.status === "indeterminate" && steps.at(-1)?.kind !== "unknown") {
    add("unknown", record.updatedAt);
  }
  return steps;
}

function totalTokens(record: ApiTurnRecord): number | undefined {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event?.type === "usage" && event.totalTokens !== undefined) return event.totalTokens;
  }
  return undefined;
}

/**
 * Explicit presentation adapter. The renderer never persists or reconstructs
 * turn-record.v1; it only gives the server-owned record a display shape.
 */
export function adaptTurnRecord(
  record: ApiTurnRecord,
  positionName: string,
  unrenderableOutput: string = zhText("turn.unrenderableOutput"),
): TurnRecord {
  const pendingApproval = approvalRequest(record);
  const progress = progressSteps(record);
  const usage = totalTokens(record);
  return {
    id: record.turnId,
    positionId: record.positionId,
    positionName,
    engine: record.engine,
    input: record.input,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.status !== "running" ? { completedAt: record.updatedAt } : {}),
    ...(record.output !== undefined ? { output: renderOutput(record.output, unrenderableOutput) } : {}),
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
    ...(record.error !== undefined ? { error: record.error.message, errorCode: record.error.code } : {}),
    ...(pendingApproval !== undefined ? { approvalRequest: pendingApproval } : {}),
    envelopeDigest: record.envelopeDigest,
    ...(record.threadContext !== undefined ? { threadContext: record.threadContext } : {}),
    ...(progress.length > 0 ? { progress } : {}),
    ...(usage !== undefined ? { totalTokens: usage } : {}),
  };
}

export function adaptTurnHistory(
  history: ApiTurnHistory,
  positionName: string,
  unrenderableOutput?: string,
): TurnRecord[] {
  return history.turns.map((record) => adaptTurnRecord(record, positionName, unrenderableOutput));
}
