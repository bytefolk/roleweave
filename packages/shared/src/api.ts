/**
 * Control-plane API contract constants (frozen at v0, see docs/api-contract-v0.md).
 *
 * Single source of truth for endpoint routes, the version header, and the SSE
 * event vocabulary. Server and desktop shell both consume these constants so a
 * route can never drift between implementation and contract.
 */

export const API_VERSION = "v0" as const;

/** Response header carrying the contract version on every response. */
export const API_VERSION_HEADER = "x-orgworkbench-api" as const;

export const routes = {
  health: "/health",
  workspace: "/workspace",
  workspaceOpen: "/workspace/open",
  workspaceCreate: "/workspace/create",
  orgTree: "/org/tree",
  orgApply: "/org/apply",
  orgBackups: "/org/backups",
  orgRestore: "/org/restore",
  orgUndo: "/org/undo",
  hire: "/hire",
  positions: "/positions",
  reports: "/reports",
  sessions: "/sessions",
  turns: "/turns",
  turnsCancel: "/turns/cancel",
  /** Additive S2 group-chat surface (#52, DS-34-001 rev-1 §1.2). */
  groups: "/groups",
  /** Additive read-only document file routing (#35 S2, DS-35-001 rev-1 §5). */
  docsList: "/docs/list",
  docsRead: "/docs/read",
  /** Additive create/resolve surface (#35 S4, DS-35-001 rev-1 §3/§5). */
  docsCreate: "/docs/create",
  docsResolve: "/docs/resolve",
  /**
   * Additive external doc-plane bridge (#35 R2 MVP): list + detail proxied to
   * an external `bytefolk/doc` server pinned by `ORG_WORKBENCH_DOC_URL`. This
   * is a control-plane read proxy — it never mirrors the position-scoped file
   * surface above and is opt-in per env.
   */
  docPlaneList: "/doc-plane/list",
  docPlaneDetail: "/doc-plane/detail",
  /** Additive asset-layer foundation (#36 S1, DS-36-001 rev-1 §5). */
  assetsList: "/assets/list",
  assetsRead: "/assets/read",
  assetsCreate: "/assets/create",
  /** Additive drive (mem) plane proxy — MVP list/detail/upload; the workbench
   * never mirrors mem storage, it only forwards to the configured MEM_URL. */
  driveList: "/drive/list",
  driveDetail: "/drive/detail",
  driveUpload: "/drive/upload",
  events: "/events",
} as const;

export type RoutePath = (typeof routes)[keyof typeof routes];

/**
 * SSE event vocabulary. D3 wires `turn.*` against the engine S1 turn
 * contract (#165); D4 derives local read-only escalation/evidence views from
 * persisted turn records and does not synthesize new engine events.
 */
export const sseEventTypes = [
  "org.updated",
  "turn.started",
  "turn.model.delta",
  "turn.usage",
  "turn.completed",
  "turn.failed",
  "turn.indeterminate",
  // Additive approval-gate mirror of the engine.v1 #187 events (#25 Slice B).
  "turn.approval.requested",
  "turn.approval.granted",
  "turn.approval.denied",
  "escalation.created",
  "evidence.created",
  "hire.progress",
  // Additive S2 group-chat routing event (#52, DS-34-001 rev-1 §1.2): one per
  // @mentioned member spawn; group turn.* payloads additionally carry
  // additive groupRef/turnId/positionId fields for renderer attribution.
  "group.turn.spawned",
] as const;

export type SseEventType = (typeof sseEventTypes)[number];

export interface SseEventEnvelope<T = unknown> {
  /** Monotonic per-server sequence; used as SSE id and for resume. */
  seq: number;
  type: SseEventType;
  at: string;
  payload: T;
}
