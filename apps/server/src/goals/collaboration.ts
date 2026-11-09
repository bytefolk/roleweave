import type { Goal, GoalTaskDelivery, GoalTaskExecution, GoalWorkItem, TaskCollaborationContext } from "@roleweave/shared";
import { serializeContextPayload, digest } from "../turns/context-snapshot.js";
import { compactThreadContextHandoff, sanitizeContextText } from "../turns/thread-context.js";

export function projectTaskCollaboration(goal: Goal, task: GoalWorkItem, facts: {
  deliveries: Record<string, GoalTaskDelivery>;
  executions: Record<string, GoalTaskExecution>;
  tasksWithTurns: ReadonlySet<string>;
  historyAvailable: boolean;
}, capturedAt = new Date().toISOString()): TaskCollaborationContext {
  let redacted = false;
  const clean = (text: string) => { const safe = sanitizeContextText(text); redacted ||= safe !== text; return safe; };
  const peer = (item: GoalWorkItem) => ({ taskId: item.taskId, title: clean(item.title), ...(item.assigneePositionId ? { assigneePositionId: item.assigneePositionId } : {}) });
  const tasks = new Map((goal.workItems ?? []).map(item => [item.taskId, item]));
  const dependencies: TaskCollaborationContext["dependencies"] = (task.dependsOn ?? []).map(id => {
    // The durable goal validator already rejects dangling edges and cycles.
    const item = tasks.get(id)!;
    const execution = Object.hasOwn(facts.executions, id) ? facts.executions[id] : undefined;
    const delivery = Object.hasOwn(facts.deliveries, id) ? facts.deliveries[id] : undefined;
    const decisions = (goal.taskAcceptances ?? []).filter(record => record.taskId === id);
    const accepted = decisions.at(-1);
    const ready = item.status === "done" && delivery && accepted?.decision === "accepted" &&
      serializeContextPayload(accepted.source) === serializeContextPayload(delivery.source) &&
      serializeContextPayload(accepted.criteriaSnapshot) === serializeContextPayload(goal.acceptanceCriteria);
    const manual = item.status === "done" && !facts.tasksWithTurns.has(id) && decisions.length === 0;
    let source;
    if (delivery) {
      const compact = compactThreadContextHandoff({ label: delivery.source.turnId, input: "", output: delivery.output });
      const whole = String(compact.output);
      const buffer = Buffer.from(whole);
      let end = Math.min(buffer.length, 2048);
      while (end < buffer.length && end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
      const excerpt = buffer.subarray(0, end).toString("utf8");
      redacted ||= compact.redacted ?? false;
      source = { ...delivery.source, completedAt: delivery.completedAt, outputExcerpt: excerpt, excerptDigest: digest(excerpt),
        truncated: (compact.truncated ?? false) || whole !== excerpt, redacted: compact.redacted ?? false };
    }
    return { ...peer(item), status: item.status,
      readiness: !facts.historyAvailable ? "unavailable" as const : ready ? "accepted" as const : manual ? "manual_done" as const : "pending" as const,
      ...(execution ? { executionStatus: execution.status } : {}),
      ...(source ? { delivery: source } : {}),
      ...(facts.historyAvailable && ready ? { acceptanceId: accepted!.acceptanceId, acceptedAt: accepted!.decidedAt } : {}),
    };
  });
  const dependents = (goal.workItems ?? []).filter(item => item.dependsOn?.includes(task.taskId));
  const context: TaskCollaborationContext = {
    schemaVersion: "task-collaboration.v1", goalId: goal.goalId, taskId: task.taskId, capturedAt,
    participants: (task.participants ?? []).map(p => ({ ...p, responsibility: clean(p.responsibility) })),
    dependencies, dependents: dependents.slice(0, 8).map(peer), omittedDependentCount: Math.max(0, dependents.length - 8), redacted,
  };
  return context;
}
