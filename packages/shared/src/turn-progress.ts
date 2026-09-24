/** Manager live task-progress contracts (#480). Workbench-owned stages, not Host NDJSON. */

export const TURN_PROGRESS_SCHEMA_VERSION = "turn-progress.v1" as const;

export const turnProgressStepStatuses = ["pending", "running", "success", "failed", "skipped"] as const;
export type TurnProgressStepStatus = (typeof turnProgressStepStatuses)[number];

export const turnProgressOverallStatuses = ["running", "success", "failed", "stuck"] as const;
export type TurnProgressOverallStatus = (typeof turnProgressOverallStatuses)[number];

/** Workbench-reported phases. Hosts have no first-class step API in v0. */
export const WORKBENCH_PROGRESS_STEPS = [
  { id: "thread-context", name: "Assemble thread context" },
  { id: "spawn", name: "Reserve and spawn" },
  { id: "streaming", name: "Engine streaming" },
  { id: "persist", name: "Persist turn record" },
  { id: "terminal", name: "Publish terminal" },
] as const;

export type WorkbenchProgressStepId = (typeof WORKBENCH_PROGRESS_STEPS)[number]["id"];

export interface TurnProgressStepView {
  id: WorkbenchProgressStepId;
  name: string;
  status: TurnProgressStepStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** Bounded, operator-safe note. Never chain-of-thought or engine NDJSON. */
  message?: string;
}

/**
 * Progress event payload. Envelope `seq` / `at` live on `SseEventEnvelope`.
 * `employeeId` is a documented alias of `positionId`.
 */
export interface TaskProgressEvent {
  taskId: string;
  employeeId: string;
  positionId: string;
  employeeName?: string;
  taskTitle?: string;
  stepIndex: number;
  stepName: string;
  stepStatus: TurnProgressStepStatus;
  totalSteps: number;
  progress: number;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  timestamp: number;
  retryOf?: string;
  retryCount?: number;
}

export interface TaskProgressSnapshot {
  schemaVersion: typeof TURN_PROGRESS_SCHEMA_VERSION;
  taskId: string;
  employeeId: string;
  positionId: string;
  employeeName?: string;
  taskTitle?: string;
  progress: number;
  currentStep: number;
  steps: TurnProgressStepView[];
  overallStatus: TurnProgressOverallStatus;
  startedAt: number;
  updatedAt: number;
  retryOf?: string;
  retryCount?: number;
  workspacePath: string;
}

export interface TaskProgressListResponse {
  snapshots: TaskProgressSnapshot[];
}

export const STALE_PROGRESS_MS = 30_000;
