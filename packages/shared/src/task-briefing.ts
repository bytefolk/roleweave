import { createRequire } from "node:module";

export interface TaskBriefingRequest { expectedWorkspacePath: string; expectedUpdatedAt: string }
export interface TaskBriefingPayload {
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
