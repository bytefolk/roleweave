import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { TurnRecord, VaultNoteResponse, VaultSourceRef } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { createVaultNote, validateVaultPath } from "./store.js";
import { boundedVaultText, publicVaultText } from "./context.js";

export interface NoteFromTurnRequest { positionId: string; turnId: string; path: string; content?: string }
function visibleOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return "";
  const record = output as Record<string, unknown>;
  for (const key of ["text", "answer", "output", "summary"]) if (typeof record[key] === "string") return record[key] as string;
  return "";
}

export async function noteFromTurn(ctx: ControlPlaneContext, request: NoteFromTurnRequest): Promise<VaultNoteResponse> {
  const workspace = ctx.workspace.requireOpen();
  validateVaultPath(request.path);
  if (!workspace.organization.roles.some(role => role.id === request.positionId)) throw new OrgApiError(errorCodes.position_missing, 404, "The position is unavailable");
  if (typeof request.turnId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.turnId) ||
      (request.content !== undefined && typeof request.content !== "string")) throw new OrgApiError(errorCodes.vault_request_invalid, 400, "Invalid source turn");
  const timestamp = new Date().toISOString();
  let record: TurnRecord | null = await ctx.turnStore.readPositionTurn(workspace.dir, request.positionId, request.turnId, timestamp, { recoverInterrupted: false });
  let sessionId: string | undefined;
  if (record === null) {
    const sessions = await ctx.sessionStore.list(workspace.dir, request.positionId);
    for (const session of sessions.sessions) {
      if (session.positionId !== request.positionId) continue;
      const history = await ctx.turnStore.sessionHistory(workspace.dir, session.sessionId, request.positionId, timestamp);
      const found = history.turns.find(turn => turn.turnId === request.turnId && turn.positionId === request.positionId && turn.conversationId === session.sessionId);
      if (found) { record = found; sessionId = session.sessionId; break; }
    }
  }
  if (record === null || record.status !== "completed" || record.positionId !== request.positionId || record.turnId !== request.turnId) {
    throw new OrgApiError(errorCodes.vault_request_invalid, 409, "Only a completed, persisted source turn can become a note");
  }
  if (ctx.workspace.active !== workspace) throw new OrgApiError(errorCodes.vault_conflict, 409, "The workspace changed before the note was created");
  const user = boundedVaultText(publicVaultText(record.input), 64 * 1024);
  const answer = boundedVaultText(publicVaultText(visibleOutput(record.output)), 64 * 1024);
  const body = request.content === undefined ? `# 会话笔记\n\n## 任务输入（公开摘录）\n\n${user}\n\n## 公开答复（摘录）\n\n${answer}` : publicVaultText(request.content);
  const source: VaultSourceRef = { positionId: request.positionId, turnId: record.turnId, ...(sessionId ? { sessionId } : {}) };
  const provenance = `\n\n---\n来源岗位：${request.positionId}\n来源轮次：${record.turnId}${sessionId ? `\n来源会话：${sessionId}` : ""}\n完成时间：${record.updatedAt}\n`;
  return createVaultNote(workspace, { path: request.path, content: body + provenance, positionIds: [request.positionId], source });
}
