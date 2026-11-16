import { OrgApiError, errorCodes, type ApprovalRecord } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import type { SupplementalContext } from "../turns/thread-context.js";
import { sanitizeContextText } from "../turns/thread-context.js";
import { compareRfc3339Instants } from "../turns/store.js";
import { goalPlanDigest, projectTaskDeliveries } from "./store.js";

export const MAX_TASK_REPAIRS = 3;

/** A human-started repair uses existing acceptance and execution records only. */
export async function prepareGoalRework(
  ctx: ControlPlaneContext,
  workspace: string,
  request: { goalId?: string; branchId?: string; positionId: string },
  sessionId?: string,
  readApprovals: () => Promise<readonly ApprovalRecord[]> = async () => [],
  continuation?: { turnId: string; sourceTurnId: string },
): Promise<SupplementalContext[]> {
  if (!request.goalId || !request.branchId || sessionId === undefined) return [];
  const goal = await ctx.goalStore.get(workspace, request.goalId);
  const decisions = (goal.taskAcceptances ?? []).filter(record => record.taskId === request.branchId);
  const rejection = decisions.at(-1);
  if (rejection?.decision !== "rejected") return [];
  const conflict = (message: string): never => {
    throw new OrgApiError(errorCodes.goal_conflict, 409, message);
  };
  const item = goal.workItems?.find(task => task.taskId === request.branchId);
  if (!item || item.assigneePositionId !== request.positionId ||
      rejection.source.positionId !== request.positionId || rejection.source.sessionId !== sessionId) {
    conflict("repair must use the rejected delivery's assigned employee and personal session");
  }
  const samePlan = rejection.planDigest !== undefined
    ? goalPlanDigest(goal) === rejection.planDigest : goal.updatedAt === rejection.decidedAt;
  if (!samePlan || goal.status === "completed" || goal.status === "cancelled" ||
      JSON.stringify(goal.acceptanceCriteria) !== JSON.stringify(rejection.criteriaSnapshot)) {
    conflict("repair criteria or goal state changed; review the plan before continuing");
  }
  // Read failures propagate. An unavailable ledger must not reset the attempt count.
  const turns = await ctx.turnStore.reportRecords(workspace);
  const taskTurns = turns.filter(turn => turn.goalId === goal.goalId && turn.branchId === request.branchId);
  // Approval execution is already durable. Reuse its source/execution links to
  // count one repair across tool pauses, without adding another task ledger.
  const links = new Map<string, string>();
  for (const approval of await readApprovals()) {
    const source = taskTurns.find(turn => turn.turnId === approval.source.turnId);
    if (approval.execution.turnId && approval.decision &&
        ["granted", "denied"].includes(approval.status) && approval.source.kind === "session" &&
        approval.source.positionId === request.positionId && approval.source.conversationId === sessionId &&
        source?.positionId === request.positionId && source.conversationRef === sessionId &&
        source.conversationId === sessionId && !source.groupRef && source.error?.code === "engine.approval_required" &&
        source.events.some(event => event.type === "approval.requested" &&
          event.approvalId === approval.approvalId && event.runId === approval.source.runId)) {
      links.set(approval.execution.turnId, source.turnId);
    }
  }
  const paused = new Set<string>();
  if (continuation) {
    if (links.get(continuation.turnId) !== continuation.sourceTurnId) {
      conflict("repair approval continuation does not match its durable source");
    }
    let sourceId = continuation.sourceTurnId;
    while (true) {
      if (paused.has(sourceId)) conflict("repair approval continuation has invalid source history");
      paused.add(sourceId);
      const parent = links.get(sourceId);
      if (!parent) break;
      sourceId = parent;
    }
    const root = taskTurns.find(turn => turn.turnId === sourceId);
    if (!root || compareRfc3339Instants(root.createdAt, rejection.decidedAt) < 0) {
      conflict("repair approval needs a new human review before continuing");
    }
  }
  const firstRejection = decisions.find(record => record.decision === "rejected")!;
  const repairs = taskTurns.filter(turn =>
    turn.positionId === request.positionId && turn.conversationRef === sessionId &&
    turn.conversationId === sessionId && !turn.groupRef &&
    !links.has(turn.turnId) &&
    turn.turnId !== firstRejection.source.turnId &&
    compareRfc3339Instants(turn.createdAt, firstRejection.decidedAt) >= 0);
  if (continuation ? repairs.length > MAX_TASK_REPAIRS : repairs.length >= MAX_TASK_REPAIRS) {
    conflict(`repair limit reached (${MAX_TASK_REPAIRS}); reassess the task and create a follow-up work item`);
  }
  const delivery = projectTaskDeliveries(goal, taskTurns.filter(turn => !paused.has(turn.turnId))).taskDeliveries[request.branchId];
  if (!delivery) return conflict("the latest execution needs a new human review before another repair");
  if ((["positionId", "turnId", "sessionId", "outputDigest"] as const)
    .some(key => delivery.source[key] !== rejection.source[key])) {
    conflict("the latest execution needs a new human review before another repair");
  }
  const feedback = JSON.stringify({
    goalId: goal.goalId, taskId: request.branchId, acceptanceId: rejection.acceptanceId,
    source: rejection.source, criteria: rejection.criteriaSnapshot, verdicts: rejection.verdicts,
    feedback: rejection.note, repairAttempt: repairs.length + (continuation ? 0 : 1), maxRepairs: MAX_TASK_REPAIRS,
  });
  const safeFeedback = sanitizeContextText(feedback);
  // The existing context assembler caps each field at 8 KiB. Never silently lose a verdict.
  if (Buffer.byteLength(safeFeedback, "utf8") > 8 * 1024) {
    conflict("repair feedback exceeds the context limit; split the task into smaller work items");
  }
  try { JSON.parse(safeFeedback); } catch {
    conflict("repair feedback cannot retain its structure after sanitization; revise the review text");
  }
  return [{ label: `Human-reviewed repair ${rejection.acceptanceId}`, input: safeFeedback, redacted: safeFeedback !== feedback,
    output: delivery.output }];
}
