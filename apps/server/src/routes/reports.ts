import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type {
  AuditEntry,
  BudgetReport,
  EvidenceEntry,
  EscalationEntry,
  OrgRole,
  ReportUsage,
  ReportsResponse,
  TurnRecord,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { sendJson } from "../http.js";
import { RUNTIME_DIR } from "../org/apply.js";
import type { ServerResponse } from "node:http";

const MAX_AUDIT_BYTES = 16 * 1024 * 1024;

export async function handleReports(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const ws = ctx.workspace.requireOpen();
  const audits = await readOrgAudit(ws.dir, path.join(ws.dir, RUNTIME_DIR, "org-audit.jsonl"));
  let records: TurnRecord[];
  try {
    records = await ctx.turnStore.reportRecords(ws.dir);
  } catch {
    throw invalidReports();
  }
  const evidence = records.map(toEvidence);
  const escalations = records.flatMap((record) => toEscalation(record, ws.organization.roles));
  const body: ReportsResponse = {
    schemaVersion: "reports.v1",
    streams: {
      escalations,
      audits,
      evidence,
    },
    budgets: buildBudgets(ws.organization.roles, records),
    page: { cursor: null, hasMore: false },
  };
  sendJson(res, 200, body);
}

async function readOrgAudit(workspaceDir: string, file: string): Promise<AuditEntry[]> {
  let handle: fs.FileHandle | null = null;
  let text = "";
  try {
    await assertRealDirectory(workspaceDir);
    await assertRealDirectory(path.dirname(file));
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_AUDIT_BYTES) throw invalidReports();
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || opened.size > MAX_AUDIT_BYTES) throw invalidReports();
    text = await boundedRead(handle);
    const after = await handle.stat();
    if (!sameFile(opened, after) || opened.size !== after.size || after.size !== Buffer.byteLength(text, "utf8")) {
      throw invalidReports();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof OrgApiError) throw error;
    throw invalidReports();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      entries.push(projectAuditEntry(parsed));
    } catch {
      throw invalidReports();
    }
  }
  return entries.slice(-200).reverse();
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalidReports();
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function boundedRead(handle: fs.FileHandle): Promise<string> {
  const buffer = Buffer.alloc(MAX_AUDIT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_AUDIT_BYTES) throw invalidReports();
  return buffer.subarray(0, offset).toString("utf8");
}

function invalidReports(): OrgApiError {
  return new OrgApiError(errorCodes.reports_data_invalid, 500, "local reports data is invalid");
}

function projectAuditEntry(value: unknown): AuditEntry {
  const entry = record(value);
  const changes = record(entry.changes);
  if (
    entry.schemaVersion !== "org-audit.v1" ||
    typeof entry.at !== "string" ||
    typeof entry.actor !== "string" ||
    typeof entry.workspace !== "string" ||
    typeof entry.bootstrapped !== "boolean" ||
    !Number.isSafeInteger(entry.positionCount) ||
    !Array.isArray(changes.hired) ||
    !Array.isArray(changes.moved) ||
    !Array.isArray(changes.dismissed) ||
    !Array.isArray(changes.budgetUpdated) ||
    !changes.budgetUpdated.every((id) => typeof id === "string")
  ) throw invalidReports();
  return {
    schemaVersion: "org-audit.v1",
    at: entry.at,
    actor: entry.actor,
    workspace: entry.workspace,
    bootstrapped: entry.bootstrapped,
    changes: {
      hired: changes.hired.map(projectRole),
      moved: changes.moved.map(projectMove),
      dismissed: changes.dismissed.map(projectRole),
      budgetUpdated: [...changes.budgetUpdated] as string[],
    },
    positionCount: entry.positionCount as number,
  };
}

function projectRole(value: unknown): OrgRole {
  const role = record(value);
  const packageRef = record(role.package);
  const budget = record(role.budget);
  const perTask = projectBudgetScope(budget.perTask);
  const perDay = projectBudgetScope(budget.perDay);
  const metadata = record(role.metadata);
  if (
    typeof role.id !== "string" ||
    typeof role.name !== "string" ||
    typeof role.description !== "string" ||
    !(role.reportTo === null || typeof role.reportTo === "string") ||
    !(role.mode === "read_only" || role.mode === "approval_required") ||
    typeof role.memoryScope !== "string" ||
    !stringArray(role.toolAllow) ||
    !stringArray(role.toolDeny) ||
    typeof packageRef.name !== "string" ||
    typeof packageRef.version !== "string" ||
    typeof packageRef.digest !== "string" ||
    typeof packageRef.localReference !== "string" ||
    !Object.values(metadata).every((item) => typeof item === "string")
  ) throw invalidReports();
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    reportTo: role.reportTo,
    package: {
      name: packageRef.name,
      version: packageRef.version,
      digest: packageRef.digest,
      localReference: packageRef.localReference,
    },
    mode: role.mode,
    memoryScope: role.memoryScope,
    toolAllow: [...role.toolAllow],
    toolDeny: [...role.toolDeny],
    budget: { perTask, perDay },
    metadata: { ...metadata } as Record<string, string>,
  };
}

function projectMove(value: unknown): { id: string; from: string | null; to: string | null } {
  const move = record(value);
  if (
    typeof move.id !== "string" ||
    !(move.from === null || typeof move.from === "string") ||
    !(move.to === null || typeof move.to === "string")
  ) throw invalidReports();
  return { id: move.id, from: move.from, to: move.to };
}

function projectBudgetScope(value: unknown): { tokens?: number; iterations?: number } {
  const scope = record(value);
  if (!budgetAmount(scope.tokens) || !budgetAmount(scope.iterations)) throw invalidReports();
  return {
    ...(scope.tokens !== undefined ? { tokens: scope.tokens as number } : {}),
    ...(scope.iterations !== undefined ? { iterations: scope.iterations as number } : {}),
  };
}

function budgetAmount(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 1_000_000_000);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidReports();
  return value as Record<string, unknown>;
}

function usageOf(record: TurnRecord): ReportUsage {
  const usage: ReportUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const event of record.events) {
    if (event.type !== "usage") continue;
    usage.inputTokens += event.inputTokens ?? 0;
    usage.outputTokens += event.outputTokens ?? 0;
    usage.totalTokens += event.totalTokens ?? ((event.inputTokens ?? 0) + (event.outputTokens ?? 0));
  }
  return usage;
}

function toEvidence(record: TurnRecord): EvidenceEntry {
  return {
    schemaVersion: "turn-evidence.v1",
    positionId: record.positionId,
    turnId: record.turnId,
    conversationId: record.conversationId,
    engine: record.engine,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    envelopeDigest: record.envelopeDigest,
    ...(record.runId ? { runId: record.runId } : {}),
    usage: usageOf(record),
    ...(record.error?.code ? { errorCode: record.error.code } : {}),
  };
}

function toEscalation(record: TurnRecord, roles: OrgRole[]): EscalationEntry[] {
  if (record.status !== "failed" && record.status !== "indeterminate") return [];
  const code = record.error?.code ?? (record.status === "indeterminate" ? "turn_indeterminate" : "turn_failed");
  return [{
    schemaVersion: "turn-escalation.v1",
    positionId: record.positionId,
    turnId: record.turnId,
    at: record.updatedAt,
    status: record.status,
    code,
    reportingChain: reportingChain(record.positionId, roles),
    budgetRelated: code === "turn_budget_exceeded" || code === "position_budget_exceeded",
  }];
}

function reportingChain(positionId: string, roles: OrgRole[]): string[] {
  const parents = new Map(roles.map((role) => [role.id, role.reportTo]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = positionId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return chain;
}

function buildBudgets(roles: OrgRole[], records: TurnRecord[]): BudgetReport[] {
  return roles.map((role) => {
    const own = records.filter((record) => record.positionId === role.id);
    const recorded = own.reduce<ReportUsage>((total, record) => {
      const usage = usageOf(record);
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.totalTokens += usage.totalTokens;
      return total;
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const latestTurn = own[0] ? usageOf(own[0]) : null;
    const overByUsage = latestTurn !== null &&
      role.budget.perTask.tokens !== undefined &&
      latestTurn.totalTokens > role.budget.perTask.tokens;
    const overByTerminal = own.some((record) =>
      record.error?.code === "turn_budget_exceeded" || record.error?.code === "position_budget_exceeded");
    return {
      positionId: role.id,
      declared: role.budget,
      recorded,
      latestTurn,
      state: own.length === 0 ? "unobserved" : overByUsage || overByTerminal ? "exceeded" : "within",
    };
  });
}
