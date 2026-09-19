import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { OrgApiError, errorCodes, turnEngines, validatePendingApproval, type ApprovalRecord } from "@roleweave/shared";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";

const MAX_BYTES = 128 * 1024;
const ID = /^[a-f0-9]{64}$/;
const failure = () => new OrgApiError(errorCodes.approval_storage_failed, 500, "Approval storage is unavailable or invalid");
const locked = () => new OrgApiError(errorCodes.approval_writer_busy, 409, "Another local control plane owns approvals for this workspace");

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

function valid(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const a = value as ApprovalRecord;
  const s = a.source;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 8192;
  const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (a.schemaVersion !== "workbench-approval.v1" || !ID.test(a.id) || !Number.isSafeInteger(a.version) || a.version < 1 ||
      !s || !["session", "position", "group"].includes(s.kind) ||
      ![s.positionId, s.conversationId, s.turnId, s.runId, a.approvalId].every(text) || !turnEngines.includes(s.engine) ||
      a.id !== approvalIdentity(s, a.approvalId) || !a.action || !["write", "exec", "network", "tool"].includes(a.action.kind) ||
      !text(a.action.description) || (a.action.target !== undefined && !text(a.action.target)) ||
      (a.requestReason !== undefined && !text(a.requestReason)) || !time(a.requestedAt) || !time(a.createdAt) || !time(a.updatedAt) ||
      (a.expiresAt !== undefined && !time(a.expiresAt)) ||
      !["pending", "granted", "denied", "expired", "cancelled", "indeterminate"].includes(a.status) ||
      !a.execution || !["not_started", "starting", "running", "completed", "denied", "failed", "indeterminate"].includes(a.execution.phase) ||
      (a.execution.turnId !== undefined && !/^[a-f0-9-]{36}$/.test(a.execution.turnId))) return false;
  if (a.decision) {
    const d = a.decision;
    if (!/^[a-f0-9-]{36}$/.test(d.requestId) || !Number.isSafeInteger(d.expectedVersion) || d.expectedVersion < 1 ||
        !time(d.decidedAt) || d.scope !== "once" || d.decision !== a.status ||
        !validatePendingApproval({ approvalId: a.approvalId, decision: d.decision, decidedBy: d.decidedBy, scope: d.scope, ...(d.reason === undefined ? {} : { reason: d.reason }) }).ok) return false;
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
        if (name === "writer.json" || name === "reclaim.lock" || /^\.[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
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

  async close(): Promise<void> {
    for (const { dir, nonce } of this.owners.values()) {
      const file = path.join(dir, "writer.json");
      const owner = await read(file) as { nonce?: string };
      if (owner.nonce === nonce) await fs.unlink(file);
    }
    this.owners.clear();
  }
}
