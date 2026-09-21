import crypto from "node:crypto";
import { OrgApiError, approvalRunScopeBindingInput, errorCodes, validatePendingApproval, type ApprovalRecord, type ApprovalView, type ApprovalDecisionRequest, type ApprovalBatchDecisionRequest, type ApprovalBatchDecisionResponse, type TurnRecord, type WorkbenchSession } from "@roleweave/shared";
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

const batchUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseBatchDecision(value: unknown): ApprovalBatchDecisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid batch decision");
  const request = value as ApprovalBatchDecisionRequest;
  if (Object.keys(request).some(key => !["requestId", "decision", "reason", "items"].includes(key)) ||
      typeof request.requestId !== "string" || !batchUuid.test(request.requestId) || request.decision !== "granted" ||
      !validatePendingApproval({ approvalId: "validation", decision: request.decision, decidedBy: "operator", ...(request.reason === undefined ? {} : { reason: request.reason }) }).ok ||
      !Array.isArray(request.items) || request.items.length < 2 || request.items.length > 32 ||
      request.items.some(item => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["id", "expectedVersion"].includes(key)) || typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1) ||
      new Set(request.items.map(item => item.id)).size !== request.items.length) {
    throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid batch decision");
  }
  return request;
}

/** UUID-shaped deterministic member key: a retry of one batch operation
 * reaches the same per-record idempotency slot without reusing that key for
 * a different member. */
function batchMemberRequestId(batchId: string, approvalId: string): string {
  const digest = crypto.createHash("sha256").update(`${batchId}\0${approvalId}`).digest("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** An append-only audit ledger cannot delete an intent that failed to commit.
 * Give its compensating event a distinct deterministic id so retrying the
 * same failed batch records the same reversal rather than another verdict. */
function batchMemberRollbackRequestId(batchId: string, approvalId: string): string {
  return batchMemberRequestId(`rollback:${batchId}`, approvalId);
}

function sourceSignature(record: ApprovalRecord): string {
  const source = record.source;
  return JSON.stringify([source.kind, source.positionId, source.conversationId, source.turnId, source.runId, source.engine]);
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
    const batch = a.status === "pending" && a.action.kind === "tool" && a.context?.risk === "medium" && a.policy?.batch
      ? { maxItems: a.policy.batch.maxItems }
      : undefined;
    return { ...publicView(a), canDecide: !unavailableReason, ...(batch ? { batch } : {}), ...(unavailableReason ? { unavailableReason } : {}) };
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

  /**
   * Settle a policy-classified group through one recovery turn.  This is not
   * a convenience loop around `decide`: all members are checked before any
   * record changes, share one source/run reservation, and reach the engine as
   * `pendingApprovals` so an expired member cannot leave a partially resumed
   * batch behind.
   */
  async decideBatch(ws: OpenWorkspace, token: unknown, request: ApprovalBatchDecisionRequest, actor: string): Promise<{ status: number; response: ApprovalBatchDecisionResponse }> {
    return this.serial(async () => {
      if (this.closed) throw conflict("Approval service is closing");
      this.assertToken(ws, token);
      const { items, turns } = await this.synchronize(ws);
      this.assertToken(ws, token);
      const requestedById = new Map(request.items.map(item => [item.id, item]));
      const prior = items.filter(item => item.decisions?.some(decision => decision.batchId === request.requestId));
      if (prior.length) {
        const same = prior.length === request.items.length && prior.every(item => {
          const input = requestedById.get(item.id);
          const decision = item.decisions?.find(entry => entry.batchId === request.requestId);
          return input !== undefined && decision?.decision === "granted" && decision.scope === "once" &&
            decision.expectedVersion === input.expectedVersion && decision.reason === request.reason;
        });
        if (!same) throw conflict("Batch request id was already used for another decision");
        return { status: 200, response: { requestId: request.requestId, items: await Promise.all(request.items.map(async item => ({ id: item.id, status: "accepted" as const, record: await this.view(ws, items.find(entry => entry.id === item.id)!) }))) } };
      }

      const candidates = request.items.map(item => ({ input: item, record: items.find(entry => entry.id === item.id) }));
      const errors = new Map<string, string>();
      const firstSource = candidates[0]?.record;
      for (const candidate of candidates) {
        const a = candidate.record;
        if (!a) { errors.set(candidate.input.id, "Approval not found"); continue; }
        if (a.version !== candidate.input.expectedVersion) { errors.set(a.id, "Approval changed; refresh before deciding"); continue; }
        const view = await this.view(ws, a);
        if (!view.canDecide) { errors.set(a.id, view.unavailableReason ?? "Approval is unavailable"); continue; }
        // Classification is explicit and frozen on each request. No default
        // policy permits batching, and only medium-risk restricted tools may
        // opt in; write/exec/network are structurally excluded.
        if (a.action.kind !== "tool" || a.context?.risk !== "medium" || a.action.scope?.allowed.includes("run") || !a.policy?.batch || !a.policy.batch.actionKinds.includes("tool") || a.policy.batch.maxItems < request.items.length) {
          errors.set(a.id, "Approval is not eligible for a restricted-tool batch"); continue;
        }
        if (!a.decisions || !a.progress || a.progress.pending !== 1 || !canActForPolicy(a.policy, actor, undefined)) {
          errors.set(a.id, "Approval policy does not permit this batch decision"); continue;
        }
        if (!firstSource || sourceSignature(a) !== sourceSignature(firstSource)) {
          errors.set(a.id, "Batch approvals must have the same source run"); continue;
        }
        const source = turns.find(turn => turn.turnId === a.source.turnId && turn.positionId === a.source.positionId && (turn.conversationRef ?? turn.conversationId) === a.source.conversationId);
        if (!source || source.error?.code !== "engine.approval_required" || !source.events.some(event => event.type === "approval.requested" && event.approvalId === a.approvalId && event.runId === a.source.runId && JSON.stringify(event.action) === JSON.stringify(a.action) && event.expiresAt === a.expiresAt)) {
          errors.set(a.id, "Approval source no longer matches");
        }
      }
      if (errors.size) {
        return {
          status: 200,
          response: {
            requestId: request.requestId,
            items: request.items.map(item => ({ id: item.id, status: "rejected" as const, code: errorCodes.approval_conflict, message: errors.get(item.id) ?? "Batch contains an ineligible approval; nothing was decided" })),
          },
        };
      }

      const members = candidates.map(candidate => ({ record: candidate.record!, input: candidate.input, requestId: batchMemberRequestId(request.requestId, candidate.input.id) }));
      // Keep an exact before-image until every member has reached durable
      // storage. The preflight above is intentionally all-or-nothing; a
      // storage failure must not turn it into a partially granted batch.
      const originals = new Map(members.map(member => [member.record.id, structuredClone(member.record)]));
      const appendAuditReversals = async (audited: typeof members): Promise<void> => {
        for (const member of audited) {
          const original = originals.get(member.record.id)!;
          await this.store.appendAudit(ws.dir, {
            approvalId: original.id,
            requestId: batchMemberRollbackRequestId(request.requestId, original.id),
            revertedRequestId: member.requestId,
            batchId: request.requestId,
            timestamp: new Date().toISOString(),
            type: "decision_reverted",
            actor,
            policyVersion: original.policy!.version,
            policyDigest: original.policy!.digest,
          });
        }
      };
      const sourceRecord = members[0]!.record;
      const source = turns.find(turn => turn.turnId === sourceRecord.source.turnId && turn.positionId === sourceRecord.source.positionId && (turn.conversationRef ?? turn.conversationId) === sourceRecord.source.conversationId)!;
      const turnId = crypto.randomUUID();
      const reservation = this.ctx.runningTurns.reserve(ws.dir, sourceRecord.source.positionId, turnId);
      let session: WorkbenchSession | undefined;
      const decidedAt = new Date().toISOString();
      try {
        if (sourceRecord.source.kind === "session") session = await this.ctx.sessionStore.reserveTurn(ws.dir, sourceRecord.source.conversationId);
        const engine = await resolvePositionAgentEngine(ws, sourceRecord.source.positionId, sourceRecord.source.engine, this.ctx.turnStore, this.ctx.sessionStore);
        if (engine !== sourceRecord.source.engine) throw conflict("Employee engine changed; request new approvals");
        this.assertToken(ws, token);
        if (members.some(member => member.record.expiresAt && Date.now() >= Date.parse(member.record.expiresAt))) throw new OrgApiError(errorCodes.approval_expired, 410, "One or more approvals expired");
        for (const member of members) {
          const a = member.record;
          a.decisions!.push({ requestId: member.requestId, expectedVersion: member.input.expectedVersion, decision: "granted", scope: "once", actor, ...(request.reason ? { reason: request.reason } : {}), decidedAt, batchId: request.requestId });
          a.progress = policyProgress(a.policy!, a.decisions!);
          // A batch is valid only when this vote completes every member.
          if (a.progress.pending !== 0) throw conflict("Approval policy did not settle the batch member");
          a.status = "granted";
          a.decision = { requestId: member.requestId, expectedVersion: member.input.expectedVersion, decision: "granted", scope: "once", ...(request.reason ? { reason: request.reason } : {}), decidedBy: "operator", decidedAt };
          a.execution = { phase: "starting", turnId };
          a.version++; a.updatedAt = decidedAt;
        }
        // Audit is append-only, so make every durable audit append succeed
        // before publishing any approval record. If an append partway through
        // fails, reverse every decision that did reach the ledger; otherwise
        // an audit export would claim an approval that stayed pending.
        const audited: typeof members = [];
        try {
          for (const member of members) {
            const a = member.record;
            await this.store.appendAudit(ws.dir, { approvalId: a.id, requestId: member.requestId, batchId: request.requestId, timestamp: decidedAt, type: "decision", actor, decision: "granted", scope: "once", policyVersion: a.policy!.version, policyDigest: a.policy!.digest });
            audited.push(member);
          }
        } catch (error) {
          for (const member of members) member.record = structuredClone(originals.get(member.record.id)!);
          try { await appendAuditReversals(audited); }
          catch (compensationError) {
            for (const member of members) this.ctx.bus.publish("approvals.changed", { workspacePath: ws.dir, id: member.record.id, version: member.record.version });
            throw new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval batch audit failed and compensation could not be confirmed", true, { cause: compensationError });
          }
          throw new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval batch audit failed; every written decision was reverted", true, { cause: error });
        }
        try {
          for (const member of members) {
            await this.save(ws, member.record);
          }
        } catch (error) {
          // `atomicWriteJson` prevents a torn individual record. Restore all
          // members nevertheless, including the write that reported failure,
          // so neither a failed loop nor a subsequent retry exposes a subset.
          // The ledger is append-only: a completed restore therefore receives
          // a per-member reversal, which makes the earlier granted intent
          // non-final to every audit consumer.
          for (const member of members) member.record = structuredClone(originals.get(member.record.id)!);
          const restoreFailures: unknown[] = [];
          for (const member of members) {
            try { await this.save(ws, member.record); }
            catch (restoreError) { restoreFailures.push(restoreError); }
          }
          if (restoreFailures.length) {
            // A failed rollback must be visible to clients: they must refresh
            // from disk rather than trusting the failed operation's response.
            for (const member of members) this.ctx.bus.publish("approvals.changed", { workspacePath: ws.dir, id: member.record.id, version: member.record.version });
            throw new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval batch persistence failed and rollback could not be confirmed", true, { cause: restoreFailures[0] });
          }
          await appendAuditReversals(members);
          throw new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval batch persistence failed; every member was restored", true, { cause: error });
        }
      } catch (error) {
        reservation.release();
        if (session) this.ctx.sessionStore.releaseTurn(ws.dir, session.sessionId);
        throw error;
      }
      const activeKeys = members.map(member => `${ws.dir}\0${member.record.id}`);
      activeKeys.forEach(key => this.active.add(key));
      const accepted = await Promise.all(members.map(async member => ({ id: member.record.id, status: "accepted" as const, record: await this.view(ws, structuredClone(member.record)) })));
      const job = (async () => {
        try {
          const result = await executeTurn(this.ctx, undefined, {
            positionId: sourceRecord.source.positionId, engine: sourceRecord.source.engine,
            input: `[审批批量裁决] 请继续执行原任务中这一组已批准的受限工具动作\n${source.input}`,
            pendingApprovals: members.map(member => ({ approvalId: member.record.approvalId, decision: "granted" as const, decidedBy: "operator" as const, scope: "once" as const, ...(request.reason ? { reason: request.reason } : {}), ...(member.record.expiresAt ? { expiresAt: member.record.expiresAt } : {}) })),
          }, session, undefined, undefined, ws, {
            turnId, reservation,
            beforeRun: async () => {
              if (members.some(member => member.record.expiresAt && Date.now() >= Date.parse(member.record.expiresAt))) throw new OrgApiError(errorCodes.approval_expired, 410, "Approval expired before execution");
              for (const member of members) { member.record.execution.phase = "running"; member.record.version++; member.record.updatedAt = new Date().toISOString(); await this.serial(() => this.save(ws, member.record)); }
            },
          });
          for (const member of members) member.record.execution = { turnId, ...this.outcome(member.record, result) };
        } catch (error) {
          for (const member of members) member.record.execution = { turnId, phase: "indeterminate", errorCode: error instanceof OrgApiError ? error.code : "approval_execution_unknown" };
        } finally {
          reservation.release();
          if (session) this.ctx.sessionStore.releaseTurn(ws.dir, session.sessionId);
        }
        await this.serial(async () => {
          try {
            for (const member of members) { member.record.version++; member.record.updatedAt = new Date().toISOString(); await this.save(ws, member.record); }
          } finally { activeKeys.forEach(key => this.active.delete(key)); }
        });
      })();
      this.jobs.add(job);
      void job.catch(() => { activeKeys.forEach(key => this.active.delete(key)); }).finally(() => this.jobs.delete(job));
      return { status: 202, response: { requestId: request.requestId, items: accepted } };
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
