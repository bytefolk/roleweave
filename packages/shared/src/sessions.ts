export const WORKBENCH_SESSION_SCHEMA_VERSION = "workbench-session.v1" as const;
export const WORKBENCH_SESSION_LIST_SCHEMA_VERSION = "workbench-session-list.v1" as const;

export type WorkbenchSessionStatus = "active" | "rotated";

export interface WorkbenchSession {
  schemaVersion: typeof WORKBENCH_SESSION_SCHEMA_VERSION;
  sessionId: string;
  workspaceInstanceId: string;
  positionId: string;
  principal: string;
  status: WorkbenchSessionStatus;
  rotatedFrom: string | null;
  rotatedTo: string | null;
  createdAt: string;
  rotatedAt: string | null;
  /** Workbench-owned history policy. Absent on legacy records means enabled. */
  threadContextEnabled?: boolean;
}

export interface WorkbenchSessionList {
  schemaVersion: typeof WORKBENCH_SESSION_LIST_SCHEMA_VERSION;
  positionId: string;
  activeSessionId: string | null;
  sessions: WorkbenchSession[];
}
