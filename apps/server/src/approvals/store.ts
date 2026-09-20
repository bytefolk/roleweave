import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { OrgApiError, errorCodes, isApprovalChangePreview, isApprovalScopeOffer, turnEngines, validatePendingApproval, type ApprovalAuditEvent, type ApprovalRecord } from "@roleweave/shared";
import { approvalPreviewFingerprintInput } from "@roleweave/shared";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";
import { projectApprovalPreview } from "./context.js";
import { approvalPolicyDigest } from "./policy.js";

const MAX_BYTES = 128 * 1024;
const ID = /^[a-f0-9]{64}$/;
const failure = () => new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval storage is unavailable or invalid");
const locked = () => new OrgApiError(errorCodes.approval_writer_busy, 409, "Another local control plane owns approvals for this workspace");
const auditFailure = () => new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval audit is unavailable or invalid");

export function approvalIdentity(source: ApprovalRecord["source"], approvalId: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([source.kind, source.conversationId, source.positionId, source.turnId, source.runId, approvalId])).digest("hex");
}

async function directory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
}

async function read(file: string): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    // Open the descriptor before inspecting the pathname.  This avoids a
    // check-then-open TOCTOU window; O_NOFOLLOW (where available) also keeps
    // the final component from being redirected through a symlink.  The
    // pathname check is still useful on platforms without O_NOFOLLOW, while
    // the descriptor's identity remains authoritative for the read itself.
    const named = await fs.lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || named.size > MAX_BYTES ||
        opened.ino !== named.ino || opened.dev !== named.dev || opened.size > MAX_BYTES) throw failure();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    const namedAfter = await fs.lstat(file);
    if (size > MAX_BYTES || after.size !== size || after.mtimeMs !== opened.mtimeMs ||
        !namedAfter.isFile() || namedAfter.isSymbolicLink() ||
        namedAfter.ino !== opened.ino || namedAfter.dev !== opened.dev ||
        namedAfter.size !== after.size || namedAfter.mtimeMs !== after.mtimeMs) throw failure();
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
}

function hasBoundPreview(record: ApprovalRecord): boolean {
  const preview = record.action.preview;
  if (preview === undefined || !isApprovalChangePreview(preview)) return preview === undefined;
  const { previewFingerprint, ...payload } = preview;
  const digest = crypto.createHash("sha256")
    .update(approvalPreviewFingerprintInput(record.approvalId, {
      kind: record.action.kind,
      description: record.action.description,
      ...(record.action.target === undefined ? {} : { target: record.action.target }),
    }, payload))
    .digest("hex");
  return previewFingerprint === `sha256:${digest}`;
}

function valid(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const a = value as ApprovalRecord;
  const s = a.source;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 8192;
  const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const previewPayload = (preview: Exclude<NonNullable<ApprovalRecord["context"]>["preview"], { status: "unavailable" }>) => {
    const { status: _status, ...payload } = preview;
    return payload;
  };
  if ((a.schemaVersion !== "workbench-approval.v1" && a.schemaVersion !== "workbench-approval.v2") || !ID.test(a.id) || !Number.isSafeInteger(a.version) || a.version < 1 ||
      !s || !["session", "position", "group"].includes(s.kind) ||
      ![s.positionId, s.conversationId, s.turnId, s.runId, a.approvalId].every(text) || !turnEngines.includes(s.engine) ||
      a.id !== approvalIdentity(s, a.approvalId) || !a.action || !["write", "exec", "network", "tool"].includes(a.action.kind) ||
      !text(a.action.description) || (a.action.target !== undefined && !text(a.action.target)) ||
      (a.action.scope !== undefined && !isApprovalScopeOffer(a.action.scope)) ||
      (a.requestReason !== undefined && !text(a.requestReason)) || !time(a.requestedAt) || !time(a.createdAt) || !time(a.updatedAt) ||
      (a.expiresAt !== undefined && !time(a.expiresAt)) ||
      !["pending", "granted", "denied", "expired", "cancelled", "indeterminate"].includes(a.status) ||
      !a.execution || !["not_started", "starting", "running", "completed", "denied", "failed", "indeterminate"].includes(a.execution.phase) ||
      (a.execution.turnId !== undefined && !/^[a-f0-9-]{36}$/.test(a.execution.turnId)) ||
      !hasBoundPreview(a)) return false;
  if (a.decision) {
    const d = a.decision;
    if (!/^[a-f0-9-]{36}$/.test(d.requestId) || !Number.isSafeInteger(d.expectedVersion) || d.expectedVersion < 1 ||
        !time(d.decidedAt) || (d.scope !== "once" && d.scope !== "run") || d.decision !== a.status ||
        !validatePendingApproval({ approvalId: a.approvalId, decision: d.decision, decidedBy: d.decidedBy, scope: d.scope, ...(d.reason === undefined ? {} : { reason: d.reason }) }).ok) return false;
  }
  if (a.schemaVersion === "workbench-approval.v2") {
    const p = a.policy;
    const actor = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
    if (!p || !actor(p.version) || !/^sha256:[a-f0-9]{64}$/.test(p.digest) || !Array.isArray(p.eligibleApprovers) || !p.eligibleApprovers.every(actor) || !Number.isSafeInteger(p.threshold) || p.threshold < 1 || p.threshold > p.eligibleApprovers.length || !p.delegations || typeof p.delegations !== "object" || Array.isArray(p.delegations) || !Object.entries(p.delegations).every(([from, to]) => actor(from) && Array.isArray(to) && to.every(actor)) || (p.escalation !== undefined && (!time(p.escalation.at) || !Array.isArray(p.escalation.eligibleApprovers) || !p.escalation.eligibleApprovers.every(actor) || !Number.isSafeInteger(p.escalation.threshold) || p.escalation.threshold < 1 || p.escalation.threshold > p.escalation.eligibleApprovers.length)) || !Array.isArray(a.decisions) || a.decisions.length > 64 || !a.decisions.every(d => /^[a-f0-9-]{36}$/.test(d.requestId) && Number.isSafeInteger(d.expectedVersion) && d.expectedVersion >= 1 && ["granted", "denied"].includes(d.decision) && (d.scope === "once" || d.scope === "run") && actor(d.actor) && time(d.decidedAt) && (d.delegatedFrom === undefined || actor(d.delegatedFrom)) && (d.reason === undefined || text(d.reason))) || !a.progress || !Number.isSafeInteger(a.progress.required) || !Number.isSafeInteger(a.progress.granted) || !Number.isSafeInteger(a.progress.pending) || typeof a.progress.escalated !== "boolean") return false;
    const { digest: _digest, ...policyPayload } = p;
    if (p.digest !== approvalPolicyDigest(policyPayload)) return false;
  }
  if (a.context !== undefined) {
    const c = a.context;
    const boundedList = (v: unknown) => Array.isArray(v) && v.length <= 128 && v.every(item => typeof item === "string" && item.length <= 256);
    if (!c || !["medium", "high"].includes(c.risk) ||
        !["exec", "write", "network", "tool"].includes(c.requestedCapability) ||
        (c.parameterSummary !== undefined && (typeof c.parameterSummary !== "string" || c.parameterSummary.length > 2048)) ||
        !["workspace_write", "command_execution", "external_network", "restricted_tool"].includes(c.impact) ||
        !c.permissions || !["read_only", "approval_required"].includes(c.permissions.mode) ||
        !boundedList(c.permissions.allowedTools) || !boundedList(c.permissions.deniedTools) ||
        !c.preview || (c.preview.status === "unavailable"
          ? c.preview.reason !== "engine_preview_not_supplied"
          : c.preview.status !== "available" || !isApprovalChangePreview(previewPayload(c.preview)))) return false;
    const expectedPreview = a.action.preview === undefined
      ? { status: "unavailable", reason: "engine_preview_not_supplied" }
      : projectApprovalPreview(a.action.preview);
    if (!isDeepStrictEqual(c.preview, expectedPreview)) return false;
    if (!Array.isArray(c.scope.allowed) || c.scope.allowed.length < 1 || c.scope.allowed.length > 2 ||
        c.scope.allowed[0] !== "once" || new Set(c.scope.allowed).size !== c.scope.allowed.length ||
        c.scope.allowed.some(scope => scope !== "once" && scope !== "run")) return false;
  }
  return true;
}

/** Local-machine single writer, held for the service lifetime (including execution).
 * Dead-process takeover is serialized separately; ambiguous owners fail closed.
 * A crashed takeover can require manual lock recovery, never speculative replay. */
export class ApprovalStore {
  private owners = new Map<string, { dir: string; nonce: string }>();

  async open(workspace: string): Promise<string> {
    await directory(workspace);
    let dir = workspace;
    for (const part of [".digital-employee", "workbench", "approvals"]) {
      dir = path.join(dir, part);
      await fs.mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
      await directory(dir);
    }
    const existing = this.owners.get(workspace);
    if (existing) {
      const owner = await read(path.join(dir, "writer.json")) as { nonce?: string };
      if (owner.nonce !== existing.nonce) throw locked();
      return dir;
    }
    const file = path.join(dir, "writer.json");
    const nonce = crypto.randomUUID();
    const create = async () => {
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), nonce })); await handle.sync(); }
      finally { await handle.close(); }
    };
    try { await create(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failure();
      const reclaim = path.join(dir, "reclaim.lock");
      try { await fs.mkdir(reclaim, { mode: 0o700 }); } catch { throw locked(); }
      try {
        const owner = await read(file) as { pid?: number; host?: string };
        if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.host !== os.hostname()) throw locked();
        try { process.kill(owner.pid!, 0); throw locked(); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw locked(); }
        await fs.unlink(file);
        await create();
      } finally { await fs.rmdir(reclaim); }
    }
    this.owners.set(workspace, { dir, nonce });
    return dir;
  }

  async list(workspace: string): Promise<ApprovalRecord[]> {
    try {
      const dir = await this.open(workspace);
      const names = await fs.readdir(dir);
      if (names.length > 10002) throw failure();
      const result: ApprovalRecord[] = [];
      for (const name of names) {
        if (name === "writer.json" || name === "reclaim.lock" || name === "audit.jsonl" || /^\.[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw failure();
        const value = await read(path.join(dir, name));
        if (!valid(value) || `${value.id}.json` !== name) throw failure();
        result.push(value);
      }
      return result;
    } catch (e) { if (e instanceof OrgApiError) throw e; throw failure(); }
  }

  async put(workspace: string, record: ApprovalRecord): Promise<void> {
    try {
      if (!valid(record)) throw failure();
      const dir = await this.open(workspace);
      await atomicWriteJson(path.join(dir, `${record.id}.json`), record, MAX_BYTES, nodeAtomicTurnWriteOperations, failure);
    } catch (e) { if (e instanceof OrgApiError) throw e; throw failure(); }
  }

  async appendAudit(workspace: string, event: Omit<ApprovalAuditEvent, "seq" | "previousHash" | "hash">): Promise<ApprovalAuditEvent> {
    try {
      const dir = await this.open(workspace);
      const existing = await this.audit(workspace);
      const repeated = event.requestId === undefined ? undefined : existing.find(item => item.approvalId === event.approvalId && item.requestId === event.requestId);
      if (repeated) {
        const same = repeated.type === event.type && repeated.actor === event.actor && repeated.delegatedFrom === event.delegatedFrom && repeated.decision === event.decision && repeated.scope === event.scope && repeated.policyVersion === event.policyVersion && repeated.policyDigest === event.policyDigest;
        if (!same) throw new OrgApiError(errorCodes.approval_conflict, 409, "Request id was already used for another audit decision");
        return repeated;
      }
      const previous = existing.at(-1);
      const body = { seq: existing.length + 1, ...event, ...(previous ? { previousHash: previous.hash } : {}) };
      const hash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
      const complete = { ...body, hash } as ApprovalAuditEvent;
      await fs.appendFile(path.join(dir, "audit.jsonl"), `${JSON.stringify(complete)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
      return complete;
    } catch (e) { if (e instanceof OrgApiError) throw e; throw auditFailure(); }
  }

  async audit(workspace: string, id?: string): Promise<ApprovalAuditEvent[]> {
    try {
      const dir = await this.open(workspace);
      const file = path.join(dir, "audit.jsonl");
      let content: string;
      try { content = await fs.readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES || (content.length > 0 && !content.endsWith("\n"))) throw auditFailure();
      const events: ApprovalAuditEvent[] = [];
      for (const line of content.split("\n")) {
        if (!line) continue;
        const value = JSON.parse(line) as ApprovalAuditEvent;
        const { hash, ...unsigned } = value;
        const expected = `sha256:${crypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`;
        if (!/^sha256:[a-f0-9]{64}$/.test(hash) || hash !== expected || value.seq !== events.length + 1 || value.previousHash !== events.at(-1)?.hash || !ID.test(value.approvalId) || (value.requestId !== undefined && !/^[a-f0-9-]{36}$/.test(value.requestId))) throw auditFailure();
        events.push(value);
      }
      return id ? events.filter(e => e.approvalId === id) : events;
    } catch (e) { if (e instanceof OrgApiError) throw e; throw auditFailure(); }
  }

  async close(): Promise<void> {
    for (const { dir, nonce } of this.owners.values()) {
      const file = path.join(dir, "writer.json");
      const owner = await read(file) as { nonce?: string };
      if (owner.nonce === nonce) await fs.unlink(file);
    }
    this.owners.clear();
  }
}
