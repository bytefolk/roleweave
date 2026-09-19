import crypto from "node:crypto";
import { OrgApiError, errorCodes, validatePendingApproval, type ApprovalRecord, type ApprovalView, type ApprovalDecisionRequest, type TurnRecord, type WorkbenchSession } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import type { OpenWorkspace } from "../workspace-state.js";
import { assertTurnWorkspace, executeTurn } from "../routes/turns.js";
import { resolvePositionAgentEngine } from "../agent-binding.js";
import { ApprovalStore, approvalIdentity } from "./store.js";
import { buildApprovalContext, redactApprovalText } from "./context.js";

const instances = new WeakMap<ControlPlaneContext, ApprovalService>();
export function approvals(ctx: ControlPlaneContext): ApprovalService {
  let service = instances.get(ctx);
  if (!service) { service = new ApprovalService(ctx); instances.set(ctx, service); }
  return service;
}
const conflict = (message: string) => new OrgApiError(errorCodes.approval_conflict, 409, message);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseDecision(value: unknown): ApprovalDecisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid decision");
  const d = value as ApprovalDecisionRequest;
  if (Object.keys(d).some(k => !["requestId", "expectedVersion", "decision", "reason"].includes(k)) ||
      typeof d.requestId !== "string" || !uuid.test(d.requestId) || !Number.isSafeInteger(d.expectedVersion) || d.expectedVersion < 1 ||
      !validatePendingApproval({ approvalId: "validation", decision: d.decision, decidedBy: "operator", ...(d.reason === undefined ? {} : { reason: d.reason }) }).ok) {
    throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid decision or reason (maximum 1024 UTF-8 bytes)");
  }
  return d;
}

function publicView(record: ApprovalRecord): ApprovalRecord {
  return {
    ...record,
    action: {
      ...record.action,
      description: redactApprovalText(record.action.description),
      ...(record.action.target ? { target: redactApprovalText(record.action.target) } : {}),
    },
    ...(record.requestReason ? { requestReason: redactApprovalText(record.requestReason) } : {}),
    ...(record.context ? {
      context: {
        ...record.context,
        ...(record.context.parameterSummary ? { parameterSummary: redactApprovalText(record.context.parameterSummary) } : {}),
      },
    } : {}),
    ...(record.decision?.reason ? { decision: { ...record.decision, reason: redactApprovalText(record.decision.reason) } } : {}),
  };
}

export class ApprovalService {
  readonly store = new ApprovalStore();
  private tail: Promise<unknown> = Promise.resolve();
  private tokens = new WeakMap<OpenWorkspace, string>();
  private jobs = new Set<Promise<unknown>>();
  private active = new Set<string>();
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(private ctx: ControlPlaneContext) {}

  token(ws: OpenWorkspace): string {
    let token = this.tokens.get(ws);
    if (!token) { token = crypto.randomUUID(); this.tokens.set(ws, token); }
    return token;
  }
  assertToken(ws: OpenWorkspace, token: unknown): void {
    assertTurnWorkspace(this.ctx, ws);
    if (token !== this.token(ws)) throw conflict("Workspace changed; refresh approvals before deciding");
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async save(ws: OpenWorkspace, record: ApprovalRecord): Promise<void> {
    await this.store.put(ws.dir, record);
    this.ctx.bus.publish("approvals.changed", { workspacePath: ws.dir, id: record.id, version: record.version });
  }

  private async synchronize(ws: OpenWorkspace): Promise<{ items: ApprovalRecord[]; turns: TurnRecord[] }> {
    const items = await this.store.list(ws.dir);
    const turns = await this.ctx.turnStore.reportRecords(ws.dir);
    const byId = new Map(items.map(a => [a.id, a]));
    const now = new Date().toISOString();
    for (const turn of turns) {
      for (const event of turn.events) {
        if (event.type !== "approval.requested" || turn.status === "running") continue;
        const kind = turn.groupRef ? "group" : turn.conversationRef === turn.conversationId ? "session" : turn.conversationRef ? "group" : "position";
        const source: ApprovalRecord["source"] = { kind, positionId: turn.positionId, conversationId: turn.conversationRef ?? turn.conversationId, turnId: turn.turnId, runId: event.runId, engine: turn.engine };
        const id = approvalIdentity(source, event.approvalId);
        if (byId.has(id)) continue;
        const role = ws.organization.roles.find(entry => entry.id === source.positionId);
        const record: ApprovalRecord = {
          schemaVersion: "workbench-approval.v1", id, version: 1, approvalId: event.approvalId, source,
          action: event.action, ...(event.reason ? { requestReason: event.reason } : {}),
          ...(role ? { context: buildApprovalContext(event.action, role) } : {}),
          requestedAt: event.timestamp, ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
          status: turn.error?.code === "engine.approval_required" ? "pending" : "indeterminate",
          execution: { phase: "not_started" }, createdAt: now, updatedAt: now,
        };
        await this.save(ws, record); byId.set(id, record);
      }
    }
    for (const a of byId.values()) {
      const before = JSON.stringify(a);
      if (!a.context) {
        const role = ws.organization.roles.find(entry => entry.id === a.source.positionId);
        if (role) a.context = buildApprovalContext(a.action, role);
      }
      if (a.execution.turnId && !this.active.has(`${ws.dir}\0${a.id}`)) {
        const result = turns.find(t => t.turnId === a.execution.turnId && t.positionId === a.source.positionId && t.conversationId === a.source.conversationId);
        a.execution = { ...a.execution, ...this.outcome(a, result) };
      }
      if (a.status === "pending") {
        // Legacy settlement is usable only when the same approval id identifies
        // exactly one request in this source conversation. Ambiguity never grants.
        const siblings = [...byId.values()].filter(b => b.approvalId === a.approvalId && b.source.positionId === a.source.positionId && b.source.conversationId === a.source.conversationId);
        const requestedAt = Date.parse(a.requestedAt);
        const settlements = turns.filter(t => t.positionId === a.source.positionId && (t.conversationRef ?? t.conversationId) === a.source.conversationId)
          .flatMap(t => t.events).filter(e => (e.type === "approval.granted" || e.type === "approval.denied") &&
            e.approvalId === a.approvalId && Date.parse(e.timestamp) >= requestedAt);
        if (settlements.length) {
          a.status = siblings.length === 1 && new Set(settlements.map(e => e.type)).size === 1
            ? settlements[0]!.type === "approval.granted" ? "granted" : "denied" : "indeterminate";
        } else if (a.expiresAt && Date.now() >= Date.parse(a.expiresAt)) a.status = "expired";
      }
      if (before !== JSON.stringify(a)) { a.version++; a.updatedAt = now; await this.save(ws, a); }
    }
    return { items: [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id)), turns };
  }

  private outcome(a: ApprovalRecord, turn?: TurnRecord): ApprovalRecord["execution"] {
    if (turn?.error?.code === errorCodes.approval_expired) return { phase: "failed", errorCode: errorCodes.approval_expired };
    if (!turn || turn.status === "running" || turn.status === "indeterminate") return { phase: "indeterminate", errorCode: "approval_execution_unknown" };
    if (a.status === "denied" && turn.error?.code === "engine.approval_denied") return { phase: "denied" };
    if (turn.status === "completed" && a.status === "granted" && turn.events.some(e => e.type === "approval.granted" && e.approvalId === a.approvalId)) return { phase: "completed" };
    return { phase: "failed", errorCode: turn.error?.code ?? "approval_settlement_missing" };
  }

  private async view(ws: OpenWorkspace, a: ApprovalRecord): Promise<ApprovalView> {
    let unavailableReason: string | undefined;
    if (a.status !== "pending") unavailableReason = `approval_${a.status}`;
    else if (a.source.kind === "group") unavailableReason = "approval_source_unsupported";
    else if (!ws.organization.roles.some(r => r.id === a.source.positionId)) unavailableReason = "position_missing";
    else if (a.source.kind === "session") {
      try {
        const session = await this.ctx.sessionStore.get(ws.dir, a.source.conversationId);
        if (session.status !== "active") unavailableReason = "session_rotated";
      } catch (error) {
        if (error instanceof OrgApiError && error.code === errorCodes.session_missing) unavailableReason = "session_missing";
        else throw error;
      }
    }
    return { ...publicView(a), canDecide: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}) };
  }

  async list(ws: OpenWorkspace): Promise<ApprovalView[]> {
    return this.serial(async () => {
      if (this.closed) throw conflict("Approval service is closing");
      const { items } = await this.synchronize(ws);
      const views = await Promise.all(items.map(a => this.view(ws, a)));
      assertTurnWorkspace(this.ctx, ws);
      return views;
    });
  }

  async decide(ws: OpenWorkspace, token: unknown, id: string, request: ApprovalDecisionRequest): Promise<{ status: number; record: ApprovalView }> {
    return this.serial(async () => {
      if (this.closed) throw conflict("Approval service is closing");
      this.assertToken(ws, token);
      const { items, turns } = await this.synchronize(ws);
      this.assertToken(ws, token);
      const a = items.find(x => x.id === id);
      if (!a) throw new OrgApiError(errorCodes.approval_missing, 404, "Approval not found");
      const prior = items.find(x => x.decision?.requestId === request.requestId);
      if (prior) {
        if (prior.id !== id || prior.decision!.decision !== request.decision || prior.decision!.reason !== request.reason || prior.decision!.expectedVersion !== request.expectedVersion) throw conflict("Request id was already used for another decision");
        return { status: 200, record: await this.view(ws, prior) };
      }
      if (a.status === "expired") throw new OrgApiError(errorCodes.approval_expired, 410, "Approval expired");
      const view = await this.view(ws, a);
      if (!view.canDecide || a.version !== request.expectedVersion) throw conflict(view.unavailableReason ?? "Approval changed; refresh before deciding");
      const source = turns.find(t => t.turnId === a.source.turnId && t.positionId === a.source.positionId && (t.conversationRef ?? t.conversationId) === a.source.conversationId);
      if (!source || source.error?.code !== "engine.approval_required" || !source.events.some(e => e.type === "approval.requested" && e.approvalId === a.approvalId && e.runId === a.source.runId && JSON.stringify(e.action) === JSON.stringify(a.action) && e.expiresAt === a.expiresAt)) throw conflict("Approval source no longer matches");
      const turnId = crypto.randomUUID();
      const reservation = this.ctx.runningTurns.reserve(ws.dir, a.source.positionId, turnId);
      let session: WorkbenchSession | undefined;
      try {
        if (a.source.kind === "session") session = await this.ctx.sessionStore.reserveTurn(ws.dir, a.source.conversationId);
        const engine = await resolvePositionAgentEngine(ws, a.source.positionId, a.source.engine, this.ctx.turnStore, this.ctx.sessionStore);
        if (engine !== a.source.engine) throw conflict("Employee engine changed; request a new approval");
        this.assertToken(ws, token);
        if (a.expiresAt && Date.now() >= Date.parse(a.expiresAt)) throw new OrgApiError(errorCodes.approval_expired, 410, "Approval expired");
        a.status = request.decision;
        a.decision = { ...request, scope: "once", decidedBy: "operator", decidedAt: new Date().toISOString() };
        // Starting is persisted BEFORE any dispatch. A crash here is deliberately
        // indeterminate: replaying an external side effect would be unsafe.
        a.execution = { phase: "starting", turnId };
        a.version++; a.updatedAt = new Date().toISOString();
        await this.save(ws, a);
      } catch (e) {
        reservation.release();
        if (session) this.ctx.sessionStore.releaseTurn(ws.dir, session.sessionId);
        throw e;
      }
      const activeKey = `${ws.dir}\0${a.id}`;
      this.active.add(activeKey);
      const accepted = await this.view(ws, structuredClone(a));
      const job = (async () => {
        try {
          const result = await executeTurn(this.ctx, undefined, {
            positionId: a.source.positionId, engine: a.source.engine,
            input: `${request.decision === "granted" ? "[审批裁决] 请继续执行以下原任务中已批准的动作" : "[审批裁决] 已拒绝以下原任务的动作，不得执行"}\n${source.input}`,
            pendingApproval: { approvalId: a.approvalId, decision: request.decision, decidedBy: "operator", scope: "once", ...(request.reason ? { reason: request.reason } : {}), ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}) },
          }, session, undefined, undefined, ws, {
            turnId, reservation,
            beforeRun: async () => {
              if (a.expiresAt && Date.now() >= Date.parse(a.expiresAt)) throw new OrgApiError(errorCodes.approval_expired, 410, "Approval expired before execution");
              a.execution.phase = "running"; a.version++; a.updatedAt = new Date().toISOString();
              await this.serial(() => this.save(ws, a));
            },
          });
          a.execution = { turnId, ...this.outcome(a, result) };
        } catch (e) {
          a.execution = { turnId, phase: "indeterminate", errorCode: e instanceof OrgApiError ? e.code : "approval_execution_unknown" };
        } finally {
          reservation.release();
          if (session) this.ctx.sessionStore.releaseTurn(ws.dir, session.sessionId);
        }
        await this.serial(async () => {
          a.version++; a.updatedAt = new Date().toISOString();
          try { await this.save(ws, a); } finally { this.active.delete(activeKey); }
        });
      })();
      this.jobs.add(job);
      void job.catch(() => { this.active.delete(activeKey); }).finally(() => this.jobs.delete(job));
      return { status: 202, record: accepted };
    });
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closed = true;
      await this.tail;
      await Promise.allSettled([...this.jobs]);
      await this.store.close();
    })();
  }
}
