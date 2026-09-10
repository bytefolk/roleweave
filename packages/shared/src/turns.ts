/**
 * D3 local turn-control contracts. The execution wire mirrors the
 * digital-employee `turn-envelope.v1` / `engine.v1` source of truth; this
 * package only adds workbench-local persistence records.
 */

export const TURN_ENVELOPE_SCHEMA_VERSION = "turn-envelope.v1" as const;
/** Upstream de#205 (DE-CONVREF-001): v1alpha2 = v1 + optional conversationRef. */
export const TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2 = "turn-envelope.v1alpha2" as const;
export type TurnEnvelopeSchemaVersion =
  | typeof TURN_ENVELOPE_SCHEMA_VERSION
  | typeof TURN_ENVELOPE_SCHEMA_VERSION_V1ALPHA2;
export const TURN_RECORD_SCHEMA_VERSION = "turn-record.v1" as const;
export const TURN_HISTORY_SCHEMA_VERSION = "turn-history.v1" as const;

export const turnEngines = ["qoder", "claude-code", "claude-local"] as const;
export type TurnEngine = (typeof turnEngines)[number];

/** Explicit owner paths select only an already active in-memory reservation. */
export type CancelTurnRequest = { positionId: string } | {
  positionId: string;
  workspacePath: string;
  turnId?: string;
};

export type TurnTerminalReason =
  | "goal_met"
  | "invalid_output_exhausted"
  | "turn_budget_exceeded"
  | "position_budget_exceeded"
  | "iteration_cap"
  | "doom_loop"
  | "deadline_exceeded"
  | "cancelled"
  | "engine_internal_error";

interface EngineEventBase {
  runId: string;
  timestamp: string;
  /** Upstream de#205: envelope conversationRef echoed verbatim on every
   * engine.v1 event; absent when the envelope was legacy v1 without it. */
  conversationRef?: string;
}

/** Capability-gate action kinds; verbatim mirror of the engine #187 vocabulary. */
export type TurnApprovalActionKind = "exec" | "write" | "network" | "tool";

/**
 * Approval event shapes mirror digital-employee engine.v1 (#187 Option 1,
 * terminal-and-resume) verbatim: the requesting run settles as a retryable
 * run.failed(engine.approval_required); the verdict returns via the next
 * turn's sealed envelope, never through an in-run channel.
 */
export interface ApprovalRequestedEvent extends EngineEventBase {
  type: "approval.requested";
  approvalId: string;
  action: {
    kind: TurnApprovalActionKind;
    description: string;
    target?: string;
  };
  reason?: string;
  expiresAt?: string;
}

export interface ApprovalGrantedEvent extends EngineEventBase {
  type: "approval.granted";
  approvalId: string;
  grantedBy: "operator";
  scope: "once" | "run";
}

export interface ApprovalDeniedEvent extends EngineEventBase {
  type: "approval.denied";
  approvalId: string;
  deniedBy: "operator";
  reason?: string;
}

export type EngineEvent =
  | (EngineEventBase & { type: "run.started" })
  | (EngineEventBase & { type: "model.delta"; text: string })
  | (EngineEventBase & {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    })
  | (EngineEventBase & {
      type: "run.completed";
      output: unknown;
      terminalReason: "goal_met";
    })
  | (EngineEventBase & {
      type: "run.failed";
      error: {
        code: string;
        message: string;
        retryable: boolean;
        terminalReason: TurnTerminalReason;
      };
    })
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent
  | ApprovalDeniedEvent;

/**
 * Operator verdict carried by the resume turn's envelope (#193). Shape is
 * the engine TurnPendingApprovalInput verbatim — no parallel vocabulary.
 */
export interface TurnPendingApproval {
  approvalId: string;
  decision: "granted" | "denied";
  decidedBy: "operator";
  scope?: "once" | "run";
  reason?: string;
  expiresAt?: string;
}

export interface TurnEnvelope {
  schemaVersion: TurnEnvelopeSchemaVersion;
  workspaceRef: string;
  positionId: string;
  turnId: string;
  input: string;
  pendingApproval?: TurnPendingApproval;
  /** Upstream de#205 (DE-CONVREF-001): only present under v1alpha2; the
   * builder pairs field⇔schemaVersion strictly (v1 + field is fail-closed
   * upstream, so that combination is never produced locally). Non-empty,
   * ≤256 UTF-16 code units per the upstream schema string bounds. */
  conversationRef?: string;
  envelopeDigest: string;
}

export interface TurnRunRequest {
  workspace: string;
  positionId: string;
  engine: TurnEngine;
  envelope: TurnEnvelope;
  /** Called once for each strictly validated engine.v1 event. */
  onEvent?: (event: EngineEvent) => void;
  /** Registers a control-plane hook that terminates the engine process. */
  setAbort?: (abort: () => void) => void;
}

export type TurnRunResult =
  | { status: "trusted"; events: EngineEvent[]; diagnostic: string }
  | {
      status: "indeterminate";
      events: EngineEvent[];
      diagnostic: string;
      code: string;
    };

export interface TurnRunDriver {
  turnRun(request: TurnRunRequest): Promise<TurnRunResult>;
}

export type TurnRecordStatus = "running" | "completed" | "failed" | "indeterminate";

/** Evidence of the bounded data actually included in this turn's sealed input. */
export interface ThreadContextMetadata {
  schemaVersion: "thread-context.v1";
  enabled: boolean;
  sourceTurnCount: number;
  omittedTurnCount: number;
  contextBytes: number;
  contextDigest: string;
  summary: string;
  redacted: boolean;
  truncated: boolean;
}

export interface TurnRecord {
  schemaVersion: typeof TURN_RECORD_SCHEMA_VERSION;
  conversationId: string;
  turnId: string;
  positionId: string;
  engine: TurnEngine;
  status: TurnRecordStatus;
  input: string;
  envelopeDigest: string;
  createdAt: string;
  updatedAt: string;
  events: EngineEvent[];
  runId?: string;
  output?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  /** owb#63 (clearing of DS-34-001 rev-1 缺口①): contract-level back-link
   * carried by the v1alpha2 envelope; equals the group conversationRef for
   * group spawns and the sessionId for personal session turns. Absent for
   * personal no-session turns and all pre-clearing (v1) records. */
  conversationRef?: string;
  /** Legacy #52 local link, read-only from the clearing onward: kept so
   * pre-clearing group records stay readable on the timeline; new records
   * are written with conversationRef instead. */
  groupRef?: string;
  threadContext?: ThreadContextMetadata;
}

export interface TurnHistory {
  schemaVersion: typeof TURN_HISTORY_SCHEMA_VERSION;
  conversationId: string;
  positionId: string;
  turns: TurnRecord[];
}
