import crypto from "node:crypto";
import { OrgApiError, approvalRunScopeBindingInput, errorCodes, validatePendingApproval, type ApprovalRecord, type ApprovalView, type ApprovalDecisionRequest, type TurnRecord, type WorkbenchSession } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import type { OpenWorkspace } from "../workspace-state.js";
import { assertTurnWorkspace, executeTurn } from "../routes/turns.js";
import { resolvePositionAgentEngine } from "../agent-binding.js";
import { ApprovalStore, approvalIdentity } from "./store.js";
import { buildApprovalContext, redactApprovalText } from "./context.js";
import { canActForPolicy, policyProgress, resolveApprovalPolicy } from "./policy.js";

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
  if (Object.keys(d).some(k => !["requestId", "expectedVersion", "decision", "reason", "scope", "delegatedFrom"].includes(k)) ||
      typeof d.requestId !== "string" || !uuid.test(d.requestId) || !Number.isSafeInteger(d.expectedVersion) || d.expectedVersion < 1 ||
      (d.scope !== undefined && d.scope !== "once" && d.scope !== "run") ||
      (d.delegatedFrom !== undefined && (typeof d.delegatedFrom !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(d.delegatedFrom))) ||
      !validatePendingApproval({ approvalId: "validation", decision: d.decision, decidedBy: "operator", ...(d.reason === undefined ? {} : { reason: d.reason }) }).ok) {
    throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid decision or reason (maximum 1024 UTF-8 bytes)");
  }
  return { ...d, scope: d.scope ?? "once" };
}

function validRunScopeBinding(record: ApprovalRecord): boolean {
  const offer = record.action.scope;
  if (!offer?.allowed.includes("run") || !offer.runBinding) return false;
  const input = approvalRunScopeBindingInput(record.approvalId, record.source.runId, record.action, record.expiresAt);
  const expected = `sha256:${crypto.createHash("sha256").update(input).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(offer.runBinding), Buffer.from(expected));
}

function approvalContext(record: ApprovalRecord, role: Parameters<typeof buildApprovalContext>[1]) {
  const context = buildApprovalContext(record.action, role);
  // The engine may declare a syntactically valid offer, but it becomes visible
  // as a selectable boundary only after the control plane verifies that it is
  // bound to this exact approval, source run, action and expiry.
  return { ...context, scope: { allowed: validRunScopeBinding(record) ? ["once", "run"] as Array<"once" | "run"> : ["once"] as Array<"once" | "run"> } };
}

function publicView(record: ApprovalRecord): Omit<ApprovalView, "canDecide" | "unavailableReason"> {
  const { policy: _policy, decisions: _decisions, ...publicRecord } = record;
  return {
    ...publicRecord,
    // Approval queues show aggregate progress, never the roster or delegation graph.
    schemaVersion: "workbench-approval.v1" as const,
    action: {
      ...record.action,
      description: redactApprovalText(record.action.description),
      ...(record.action.target ? { target: redactApprovalText(record.action.target) } : {}),
      ...(record.action.preview ? {
        preview: {
          ...record.action.preview,
          files: record.action.preview.files.map(file => ({
            ...file,
            path: redactApprovalText(file.path),
            ...(file.before === undefined ? {} : { before: redactApprovalText(file.before) }),
            ...(file.after === undefined ? {} : { after: redactApprovalText(file.after) }),
          })),
        },
      } : {}),
    },
    ...(record.requestReason ? { requestReason: redactApprovalText(record.requestReason) } : {}),
    ...(record.context ? {
      context: {
        ...record.context,
        ...(record.context.parameterSummary ? { parameterSummary: redactApprovalText(record.context.parameterSummary) } : {}),
        ...(record.context.preview.status === "available" ? {
          preview: {
            ...record.context.preview,
            files: record.context.preview.files.map(file => ({
              ...file,
              path: redactApprovalText(file.path),
              ...(file.before === undefined ? {} : { before: redactApprovalText(file.before) }),
              ...(file.after === undefined ? {} : { after: redactApprovalText(file.after) }),
            })),
          },
        } : {}),
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
          schemaVersion: "workbench-approval.v2", id, version: 1, approvalId: event.approvalId, source,
          action: event.action, ...(event.reason ? { requestReason: event.reason } : {}),
          requestedAt: event.timestamp, ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
          status: turn.error?.code === "engine.approval_required" ? "pending" : "indeterminate",
          execution: { phase: "not_started" }, createdAt: now, updatedAt: now,
        };
        if (role) record.context = approvalContext(record, role);
        record.policy = await resolveApprovalPolicy(ws.dir, record);
        record.decisions = [];
        record.progress = policyProgress(record.policy, record.decisions);
        await this.save(ws, record);
        await this.store.appendAudit(ws.dir, { approvalId: id, timestamp: now, type: "requested", policyVersion: record.policy.version, policyDigest: record.policy.digest });
        byId.set(id, record);
      }
    }
    for (const a of byId.values()) {
      const before = JSON.stringify(a);
      if (a.status === "pending" && !a.policy) {
        a.schemaVersion = "workbench-approval.v2";
        a.policy = await resolveApprovalPolicy(ws.dir, a);
        a.decisions = [];
        a.progress = policyProgress(a.policy, a.decisions);
        await this.store.appendAudit(ws.dir, { approvalId: a.id, timestamp: now, type: "requested", policyVersion: a.policy.version, policyDigest: a.policy.digest });
      }
      if (a.status === "pending" && a.policy && a.decisions && a.progress) {
        const next = policyProgress(a.policy, a.decisions);
        if (next.escalated && !a.progress.escalated) await this.store.appendAudit(ws.dir, { approvalId: a.id, timestamp: now, type: "escalated", policyVersion: a.policy.version, policyDigest: a.policy.digest });
        a.progress = next;
      }
      if (!a.context) {
        const role = ws.organization.roles.find(entry => entry.id === a.source.positionId);
        if (role) a.context = approvalContext(a, role);
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

  async audit(ws: OpenWorkspace, id: string) {
    return this.serial(async () => {
      const items = await this.store.list(ws.dir);
      if (!items.some(item => item.id === id)) throw new OrgApiError(errorCodes.approval_missing, 404, "Approval not found");
      return this.store.audit(ws.dir, id);
    });
  }

  async decide(ws: OpenWorkspace, token: unknown, id: string, request: ApprovalDecisionRequest, actor: string): Promise<{ status: number; record: ApprovalView }> {
    return this.serial(async () => {
      if (this.closed) throw conflict("Approval service is closing");
      this.assertToken(ws, token);
      const { items, turns } = await this.synchronize(ws);
      this.assertToken(ws, token);
      const a = items.find(x => x.id === id);
      if (!a) throw new OrgApiError(errorCodes.approval_missing, 404, "Approval not found");
      const prior = items.find(x => x.decision?.requestId === request.requestId || x.decisions?.some(d => d.requestId === request.requestId));
      if (prior) {
        const existing = prior.decisions?.find(d => d.requestId === request.requestId) ?? prior.decision;
        if (prior.id !== id || !existing || existing.decision !== request.decision || existing.scope !== request.scope || existing.reason !== request.reason || existing.expectedVersion !== request.expectedVersion || ("delegatedFrom" in existing && existing.delegatedFrom !== request.delegatedFrom)) throw conflict("Request id was already used for another decision");
        return { status: 200, record: await this.view(ws, prior) };
      }
      if (a.status === "expired") throw new OrgApiError(errorCodes.approval_expired, 410, "Approval expired");
      if (request.scope === "run" && (request.decision !== "granted" || !validRunScopeBinding(a))) throw conflict("This approval is not eligible for run scope");
      const view = await this.view(ws, a);
      if (!view.canDecide || a.version !== request.expectedVersion) throw conflict(view.unavailableReason ?? "Approval changed; refresh before deciding");
      const source = turns.find(t => t.turnId === a.source.turnId && t.positionId === a.source.positionId && (t.conversationRef ?? t.conversationId) === a.source.conversationId);
      if (!source || source.error?.code !== "engine.approval_required" || !source.events.some(e => e.type === "approval.requested" && e.approvalId === a.approvalId && e.runId === a.source.runId && JSON.stringify(e.action) === JSON.stringify(a.action) && e.expiresAt === a.expiresAt)) throw conflict("Approval source no longer matches");
      if (a.policy && (!a.decisions || !a.progress)) throw conflict("Approval policy state is incomplete");
      if (a.policy && !canActForPolicy(a.policy, actor, request.delegatedFrom)) throw new OrgApiError(errorCodes.approval_unauthorized_actor, 403, "Actor is not eligible for this approval policy");
      const principal = request.delegatedFrom ?? actor;
      if (a.decisions?.some(d => (d.delegatedFrom ?? d.actor) === principal)) throw conflict("This approval principal has already decided");
      const decidedAt = new Date().toISOString();
      if (a.policy && a.decisions && a.progress) {
        a.decisions.push({ requestId: request.requestId, expectedVersion: request.expectedVersion, decision: request.decision, scope: request.scope, actor, ...(request.delegatedFrom ? { delegatedFrom: request.delegatedFrom } : {}), ...(request.reason ? { reason: request.reason } : {}), decidedAt });
        a.progress = policyProgress(a.policy, a.decisions);
        await this.store.appendAudit(ws.dir, { approvalId: a.id, requestId: request.requestId, timestamp: decidedAt, type: "decision", actor, ...(request.delegatedFrom ? { delegatedFrom: request.delegatedFrom } : {}), decision: request.decision, scope: request.scope, policyVersion: a.policy.version, policyDigest: a.policy.digest });
        if (request.decision === "denied") a.status = "denied";
        else if (a.progress.pending > 0) {
          a.version++; a.updatedAt = decidedAt;
          await this.save(ws, a);
          return { status: 200, record: await this.view(ws, a) };
        }
      }
      const effectiveScope = a.decisions?.some(d => d.decision === "granted" && d.scope === "once") ? "once" : request.scope;
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
        // `operator` remains the engine protocol marker; audit retains the verified actor.
        a.decision = { ...request, scope: effectiveScope, decidedBy: "operator", decidedAt };
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
            pendingApproval: { approvalId: a.approvalId, decision: request.decision, decidedBy: "operator", scope: effectiveScope, ...(request.reason ? { reason: request.reason } : {}), ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}) },
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
