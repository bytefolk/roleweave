import { createRequire } from "node:module";
import type { TaskCollaborationContext } from "./task-collaboration.js";

export interface TaskBriefingRequest { expectedWorkspacePath: string; expectedUpdatedAt: string }
export interface TaskBriefingPayload {
  collaboration?: TaskCollaborationContext;
  schemaVersion: "task-briefing.v1";
  generatedAt: string;
  planUpdatedAt: string;
  goalId: string;
  taskId: string;
  turnId: string;
  sessionId: string;
  positionId: string;
  goalTitle: string;
  goalDescription: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  redacted: boolean;
}
export interface TaskBriefingSnapshot { payload: TaskBriefingPayload; payloadBytes: number; payloadDigest: string }
export const { isTaskBriefingRequest } = createRequire(import.meta.url)("../task-briefing.cjs") as {
  isTaskBriefingRequest(value: unknown): value is TaskBriefingRequest;
};
