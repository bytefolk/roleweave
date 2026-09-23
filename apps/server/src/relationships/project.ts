import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RELATIONSHIP_GRAPH_SCHEMA, OrgApiError, isPositionId, isPositionAgentBinding, validateGoal,
  type AgentTask, type HirePermissions, type OrgRole, type RelationshipBasis,
  type RelationshipCoverage, type RelationshipEdge, type RelationshipEvidence,
  type RelationshipGraphResponse, type RelationshipKind, type RelationshipNode, type RelationshipNodeKind,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import type { OpenWorkspace } from "../workspace-state.js";
import { resolvePositionPackageDir } from "../context-sources.js";
import { decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";
import { resolveServiceConnection } from "../services/connections.js";
import { validatePermissions } from "../org/permissions.js";
import { validateTaskRecord } from "../tasks/store.js";

const MAX_NODES = 400;
const MAX_EDGES = 800;
const MAX_POSITIONS = 100;
const MAX_DOCUMENTS = 20;
const MAX_DIRECTORY_ENTRIES = 512;
const RECORD_BYTES = 32 * 1024;
const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Public labels are metadata only; path/credential-shaped text is never a graph label. */
function label(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const safe = value.replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, (raw) => {
      try { const url = new URL(raw); return url.username || url.password || url.search || url.hash ? "[redacted URL]" : raw; }
      catch { return "[redacted URL]"; }
    })
    .replace(/\b(?:bearer\s+\S+|(?:api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/gi, "[redacted]")
    .replace(/(^|[\s([{"'=,;])(?:~?\/|[A-Za-z]:[\\/])[^\s)\]}>,;]*/g, "$1[local path]")
    .trim().slice(0, 120);
  return safe || fallback;
}
function timestamp(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "unknown";
}
function locator(positionId: string, asset: string): string { return `position:${positionId}/${asset}`; }
function evidence(source: string, where: string, basis: RelationshipBasis, at: string): RelationshipEvidence {
  return { source, locator: where, basis, observedAt: at };
}

class Projection {
  readonly nodes = new Map<string, RelationshipNode>();
  readonly edges = new Map<string, RelationshipEdge>();
  readonly coverage: RelationshipCoverage[] = [];
  truncated = false;
  constructor(readonly workspaceId: string, readonly at: string) {}
  id(kind: RelationshipNodeKind, key: string): string { return `${kind}:${hash(`${this.workspaceId}\0${kind}\0${key}`).slice(0, 32)}`; }
  node(kind: RelationshipNodeKind, key: string, value: Omit<RelationshipNode, "id" | "kind">): string {
    const id = this.id(kind, key);
    if (!this.nodes.has(id)) {
      if (this.nodes.size >= MAX_NODES) this.truncated = true;
      else this.nodes.set(id, { id, kind, ...value });
    }
    return id;
  }
  edge(source: string, target: string, kind: RelationshipKind, proof: RelationshipEvidence, permission: RelationshipEdge["permission"] = "not_applicable"): void {
    if (!this.nodes.has(source) || !this.nodes.has(target)) { this.truncated = true; return; }
    const id = `edge:${hash(`${source}\0${kind}\0${target}\0${proof.locator}`).slice(0, 32)}`;
    if (this.edges.has(id)) return;
    if (this.edges.size >= MAX_EDGES) { this.truncated = true; return; }
    this.edges.set(id, { id, source, target, kind, evidence: proof, permission });
  }
  finish(): RelationshipGraphResponse {
    if (this.truncated) this.coverage.push({ source: "projection", state: "partial", reason: "graph_limit" });
    const nodes = [...this.nodes.values()].sort((a, b) => ordinal(a.id, b.id));
    const edges = [...this.edges.values()].sort((a, b) => ordinal(a.id, b.id));
    const coverage = this.coverage.sort((a, b) => ordinal(a.source, b.source));
    const stableEvidence = ({ observedAt: _, ...rest }: RelationshipEvidence) => rest;
    const revision = hash(JSON.stringify({ workspaceId: this.workspaceId,
      nodes: nodes.map((node) => ({ ...node, evidence: stableEvidence(node.evidence) })),
      edges: edges.map((edge) => ({ ...edge, evidence: stableEvidence(edge.evidence) })), coverage, truncated: this.truncated }));
    return { schemaVersion: RELATIONSHIP_GRAPH_SCHEMA, workspaceId: this.workspaceId, generatedAt: this.at,
      revision, nodes, edges, coverage, truncated: this.truncated, limits: { nodes: MAX_NODES, edges: MAX_EDGES } };
  }
}

interface DirectoryIdentity {
  directory: string; realPath: string; dev: bigint; ino: bigint; ctimeNs: bigint; mtimeNs: bigint;
}
type DirectorySnapshot = DirectoryIdentity[];

/** Bracket reads with ancestor identity checks, including entry changes from swap-and-restore. */
async function directorySnapshot(root: string, directory: string): Promise<DirectorySnapshot> {
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("unsafe graph directory");
  const result: DirectorySnapshot = [];
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe graph directory");
    const realPath = await fs.realpath(current);
    if (result.length && realPath !== path.join(result[0]!.realPath, path.relative(root, current))) throw new Error("unsafe graph directory");
    result.push({ directory: current, realPath, dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs });
  }
  await verifyDirectories(result);
  return result;
}
async function verifyDirectories(snapshot: DirectorySnapshot): Promise<void> {
  // Check ancestors last so child entry changes during the verification are also detected.
  for (const previous of [...snapshot].reverse()) {
    const stat = await fs.lstat(previous.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== previous.dev || stat.ino !== previous.ino ||
        stat.ctimeNs !== previous.ctimeNs || stat.mtimeNs !== previous.mtimeNs ||
        await fs.realpath(previous.directory) !== previous.realPath) throw new Error("graph directory changed");
  }
}
async function json(root: string, filename: string, maxBytes = RECORD_BYTES): Promise<unknown> {
  const directories = await directorySnapshot(root, path.dirname(filename));
  const stable = await readStableBoundedFile(filename, maxBytes);
  await verifyDirectories(directories);
  return JSON.parse(decodeStableUtf8(stable.buffer));
}
async function directoryEntries(root: string, directory: string): Promise<{ entries: import("node:fs").Dirent[]; truncated: boolean; directories: DirectorySnapshot }> {
  const directories = await directorySnapshot(root, directory);
  const entries: import("node:fs").Dirent[] = [];
  const handle = await fs.opendir(directory);
  let truncated = false;
  for await (const entry of handle) {
    if (entries.length >= MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
    entries.push(entry);
  }
  await verifyDirectories(directories);
  entries.sort((a, b) => ordinal(a.name, b.name));
  return { entries, truncated, directories };
}

async function workspaceIdentity(root: string): Promise<{ id: string; state: "complete" | "partial" | "error"; reason?: string }> {
  try {
    const raw = await json(root, path.join(root, ".roleweave", "sessions", "workspace-instance.json"), 16 * 1024);
    if (!object(raw) || raw.schemaVersion !== "workspace-instance.v1" || typeof raw.workspaceInstanceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.workspaceInstanceId)) throw new Error("invalid identity");
    return { id: `workspace:${raw.workspaceInstanceId}`, state: "complete" };
  } catch (error) {
    const identityPath = await fs.realpath(root).catch(() => path.resolve(root));
    return { id: `workspace:local-${hash(identityPath).slice(0, 32)}`, state: missing(error) ? "partial" : "error",
      reason: missing(error) ? "local_identity_fallback" : "identity_unreadable" };
  }
}

interface Documents { files: Array<{ path: string; size: number; modifiedAt: string }>; truncated: boolean; }
async function documents(root: string, packageDir: string): Promise<Documents> {
  const directories = await directorySnapshot(root, packageDir);
  const result: Documents = { files: [], truncated: false };
  let inspected = 0;
  const visit = async (dir: string, relativeDir: string, depth: number): Promise<void> => {
    if (depth > 8 || inspected >= 256) { result.truncated = true; return; }
    const found = await directoryEntries(root, dir);
    if (found.truncated) result.truncated = true;
    for (const entry of found.entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (++inspected > 256) { result.truncated = true; break; }
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (relativeDir === "" && !["SKILL.md", "knowledge", "schemas"].includes(entry.name)) continue;
      if (!/^[\p{L}\p{N}._ /-]+$/u.test(relative)) continue;
      if (/\bbearer\s+\S+/i.test(relative)) { result.truncated = true; continue; }
      if (entry.isDirectory()) {
        if (result.files.length >= MAX_DOCUMENTS) { result.truncated = true; break; }
        await visit(path.join(dir, entry.name), relative, depth + 1);
      } else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (result.files.length >= MAX_DOCUMENTS) { result.truncated = true; break; }
        const stat = await fs.lstat(path.join(dir, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        result.files.push({ path: relative, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    }
    await verifyDirectories(found.directories);
  };
  await visit(packageDir, "", 0);
  await verifyDirectories(directories);
  result.files.sort((a, b) => ordinal(a.path, b.path));
  return result;
}

function addCapability(graph: Projection, agent: string, role: OrgRole, kind: "tool" | "skill" | "mcp", nativeId: string, effect: "allow" | "deny", source: string, version?: string): void {
  const proof = evidence(source, locator(role.id, `${kind}/${label(nativeId, kind)}`), "declared", graph.at);
  const id = graph.node("capability", `${kind}\0${nativeId}\0${version ?? ""}`, {
    label: label(nativeId, kind), state: kind === "mcp" ? "unknown" : "configured", evidence: proof,
    facts: [{ key: "kind", value: kind }, ...(version ? [{ key: "version", value: label(version, "unknown") }] : []),
      ...(kind === "mcp" ? [{ key: "runtimeSupported", value: "false" }] : [])],
  });
  graph.edge(agent, id, effect === "allow" ? "declares_allow" : "declares_deny", proof, "declaration_only");
}
function selectorLabel(resource: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[~/\\])/.test(resource)) return "本地资源（路径已隐藏）";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resource)) {
    try {
      const url = new URL(resource);
      if (url.username || url.password || url.search || url.hash) return "外部资源（定位符已隐藏）";
    } catch { return "资源定位符"; }
  }
  return label(resource, "资源定位符");
}
async function positionDetails(graph: Projection, root: string, role: OrgRole, contextConfigured: boolean): Promise<{ source: string; docs: Documents } | null> {
  const agent = graph.id("agent", role.id);
  const packageDir = resolvePositionPackageDir(root, role);
  const proof = evidence("organization", `position:${role.id}`, "declared", graph.at);
  const policy = graph.node("policy", role.id, { label: `${label(role.name, role.id)} · 权限声明`, state: "configured", positionId: role.id, evidence: proof,
    facts: [{ key: "mode", value: role.mode }, { key: "evaluation", value: "declaration_only" }] });
  graph.edge(agent, policy, "has_policy", proof, "declaration_only");
  for (const tool of role.toolAllow.slice(0, 32)) addCapability(graph, agent, role, "tool", tool, "allow", "organization");
  for (const tool of role.toolDeny.slice(0, 32)) addCapability(graph, agent, role, "tool", tool, "deny", "organization");
  try {
    const raw = await json(root, path.join(packageDir, "permissions.json"));
    if (!object(raw) || raw.schemaVersion !== "workbench-permissions.v1") throw new Error("invalid permissions");
    const permissions: HirePermissions = validatePermissions(raw, () => new OrgApiError("graph_source_invalid", 400, "invalid permissions"));
    permissions.rules.forEach((rule, index) => {
      const ruleProof = evidence("permissions", locator(role.id, `permissions.json/rules/${index}`), "declared", graph.at);
      const target = graph.node("resource", `selector\0${role.id}\0${index}\0${rule.resource}`, {
        label: selectorLabel(rule.resource), state: "unknown", positionId: role.id, evidence: ruleProof,
        facts: [{ key: "kind", value: "selector" }, { key: "scope", value: rule.scope }, { key: "actions", value: rule.actions.join(", ") },
          { key: "approval", value: rule.approval === undefined ? "unspecified" : String(rule.approval) }, { key: "effect", value: rule.effect ?? "allow" }],
      });
      graph.edge(policy, target, rule.effect === "deny" ? "declares_deny" : "declares_allow", ruleProof, "declaration_only");
    });
    for (const tool of permissions.tools) addCapability(graph, agent, role, "tool", tool, "allow", "permissions");
    for (const skill of permissions.skills ?? []) addCapability(graph, agent, role, "skill", skill.id, "allow", "permissions", skill.version);
    for (const mcp of permissions.mcpServers ?? []) addCapability(graph, agent, role, "mcp", mcp.id, "allow", "permissions");
    graph.coverage.push({ source: `permissions:${role.id}`, state: "complete", count: permissions.rules.length });
  } catch (error) {
    graph.coverage.push({ source: `permissions:${role.id}`, state: missing(error) ? "partial" : "error", reason: missing(error) ? "permission_manifest_missing" : "source_unreadable" });
  }
  try {
    const raw = await json(root, path.join(packageDir, ".workbench", "agent-binding.v1.json"), 1024);
    if (!isPositionAgentBinding(raw)) throw new Error("invalid binding");
    const bound = evidence("agent_binding", locator(role.id, "agent-binding.v1.json"), "declared", graph.at);
    const host = graph.node("host", raw.engine, { label: raw.engine, state: "configured", evidence: bound,
      facts: [{ key: "kind", value: "runtime_kind" }, { key: "health", value: "not_probed" }] });
    graph.edge(agent, host, "bound_to", bound);
    graph.coverage.push({ source: `agent_binding:${role.id}`, state: "complete", count: 1 });
  } catch (error) {
    graph.coverage.push({ source: `agent_binding:${role.id}`, state: missing(error) ? "not_connected" : "error", reason: missing(error) ? "agent_not_bound" : "source_unreadable" });
  }
  const contextProof = evidence("context_configuration", `context:position:${role.id}`, "declared", graph.at);
  const context = graph.node("source", `context\0${role.id}`, { label: "岗位运行上下文", state: contextConfigured ? "configured" : "not_configured", positionId: role.id, evidence: contextProof,
    facts: [{ key: "kind", value: "context_provider" }, { key: "binding", value: "bound" }, { key: "readOnly", value: "true" }] });
  graph.edge(agent, context, "declares_source", contextProof, "unknown");
  let docs: Documents;
  try {
    docs = await documents(root, packageDir);
    graph.coverage.push({ source: `documents:${role.id}`, state: docs.truncated ? "partial" : "complete", count: docs.files.length, ...(docs.truncated ? { reason: "document_limit" } : {}) });
    if (docs.truncated) graph.truncated = true;
  } catch (error) {
    graph.coverage.push({ source: `documents:${role.id}`, state: missing(error) ? "not_connected" : "error", reason: missing(error) ? "package_missing" : "source_unreadable" });
    return null;
  }
  const docsProof = evidence("workspace_documents", locator(role.id, "documents"), "observed", graph.at);
  const source = graph.node("source", `documents\0${role.id}`, { label: "岗位知识库", state: docs.files.length ? "ready" : "available", positionId: role.id, evidence: docsProof,
    facts: [{ key: "kind", value: "workspace_docs" }, { key: "binding", value: "bound" }, { key: "itemCount", value: String(docs.files.length) }] });
  graph.edge(agent, source, "declares_source", { ...docsProof, basis: "declared" }, "declaration_only");
  return { source, docs };
}

async function addTasks(graph: Projection, root: string, workspace: string, knownRoles: ReadonlySet<string>): Promise<void> {
  let count = 0; let invalid = false; let limited = false;
  try {
    const found = await directoryEntries(root, path.join(root, ".roleweave", "tasks"));
    limited = found.truncated;
    const entries = found.entries.filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name));
    if (entries.length > 64) limited = true;
    for (const entry of entries.slice(0, 64)) {
      try {
        const task: AgentTask = validateTaskRecord(await json(root, path.join(root, ".roleweave", "tasks", entry.name)), entry.name.slice(0, -5));
        const proof = evidence("tasks", `task:${task.taskId}`, "observed", graph.at);
        const id = graph.node("task", task.taskId, { label: label(task.title, "任务"), state: "ready", evidence: proof,
          facts: [{ key: "status", value: task.status }, { key: "kind", value: task.kind }, { key: "priority", value: task.priority }, { key: "updatedAt", value: timestamp(task.updatedAt) }] });
        graph.edge(workspace, id, "contains", proof);
        for (const [kind, positionId] of [["assigned_to", task.assigneePositionId], ["requested_by", task.requestedByPositionId], ["budget_owner", task.budgetOwnerPositionId]] as const) {
          if (knownRoles.has(positionId)) graph.edge(id, graph.id("agent", positionId), kind, { ...proof, basis: "declared" });
          else invalid = true;
        }
        count += 1;
      } catch { invalid = true; }
    }
    graph.coverage.push({ source: "tasks", state: invalid || limited ? "partial" : "complete", count,
      ...(invalid ? { reason: "invalid_or_unresolved_record" } : limited ? { reason: "record_limit" } : {}) });
  } catch (error) {
    graph.coverage.push({ source: "tasks", state: missing(error) ? "complete" : "error", count: 0, ...(missing(error) ? {} : { reason: "source_unreadable" }) });
  }
  if (limited) graph.truncated = true;
}
async function addGoals(graph: Projection, root: string, workspace: string, knownRoles: ReadonlySet<string>): Promise<void> {
  let count = 0; let invalid = false; let limited = false;
  try {
    const found = await directoryEntries(root, path.join(root, ".roleweave", "goals"));
    limited = found.truncated;
    const entries = found.entries.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name));
    if (entries.length > 64) limited = true;
    for (const entry of entries.slice(0, 64)) {
      try {
        const parsed = validateGoal(await json(root, path.join(root, ".roleweave", "goals", entry.name, "goal.json")));
        if (!parsed.ok || parsed.value.goalId !== entry.name) throw new Error("invalid goal");
        const goal = parsed.value;
        const proof = evidence("goals", `goal:${goal.goalId}`, "observed", graph.at);
        const id = graph.node("goal", goal.goalId, { label: label(goal.title, "目标"), state: "ready", evidence: proof,
          facts: [{ key: "status", value: goal.status }, { key: "health", value: goal.health }, { key: "branches", value: String(goal.branches.length) }, { key: "updatedAt", value: timestamp(goal.updatedAt) }] });
        graph.edge(workspace, id, "contains", proof);
        for (const branch of goal.branches) {
          if (!branch.positionId) continue;
          if (knownRoles.has(branch.positionId)) graph.edge(id, graph.id("agent", branch.positionId), "assigned_to", { ...proof, basis: "declared", locator: `goal:${goal.goalId}/branch:${label(branch.branchId, "branch")}` });
          else invalid = true;
        }
        count += 1;
      } catch { invalid = true; }
    }
    graph.coverage.push({ source: "goals", state: invalid || limited ? "partial" : "complete", count,
      ...(invalid ? { reason: "invalid_or_unresolved_record" } : limited ? { reason: "record_limit" } : {}) });
  } catch (error) {
    graph.coverage.push({ source: "goals", state: missing(error) ? "complete" : "error", count: 0, ...(missing(error) ? {} : { reason: "source_unreadable" }) });
  }
  if (limited) graph.truncated = true;
}

export async function projectRelationships(ctx: ControlPlaneContext, expectedWorkspacePath?: string): Promise<RelationshipGraphResponse> {
  const opened = ctx.workspace.requireOpen();
  if (expectedWorkspacePath !== undefined && expectedWorkspacePath !== opened.dir) {
    throw new OrgApiError("graph_snapshot_stale", 409, "workspace changed before reading the relationship graph", true);
  }
  const version = opened.version.seq;
  const snapshot: OpenWorkspace = { ...opened, organization: structuredClone(opened.organization) };
  const root = path.resolve(snapshot.dir);
  const memConfigured = resolveServiceConnection(ctx, "mem") !== null;
  const docConfigured = resolveServiceConnection(ctx, "doc") !== null;
  const contextConfigured = Boolean(process.env.CONTEXT_VAULT?.trim() && process.env.CONTEXT_RUNTIME_TOKEN?.trim());
  const identity = await workspaceIdentity(root);
  const graph = new Projection(identity.id, new Date().toISOString());
  graph.coverage.push({ source: "workspace_identity", state: identity.state, ...(identity.reason ? { reason: identity.reason } : {}) });
  const orgProof = evidence("organization", "workspace:organization", "declared", graph.at);
  const workspace = graph.node("workspace", "current", { label: label(snapshot.organization.business, "Workspace"), state: "ready", evidence: orgProof,
    facts: [{ key: "updatedAt", value: timestamp(snapshot.organization.updatedAt) }] });
  const allRoles = snapshot.organization.roles.filter((role) => isPositionId(role.id)).sort((a, b) => ordinal(a.id, b.id));
  const roles = allRoles.slice(0, MAX_POSITIONS);
  const knownRoles = new Set(roles.map((role) => role.id));
  const orgLimited = allRoles.length > roles.length || snapshot.organization.roles.length !== allRoles.length;
  if (orgLimited) graph.truncated = true;
  graph.coverage.push({ source: "organization", state: orgLimited ? "partial" : "complete", count: roles.length, ...(orgLimited ? { reason: "position_limit" } : {}) });
  for (const role of roles) {
    const proof = { ...orgProof, locator: `position:${role.id}` };
    const agent = graph.node("agent", role.id, { label: label(role.name, role.id), state: "ready", positionId: role.id, evidence: proof,
      facts: [{ key: "mode", value: role.mode }, { key: "packageVersion", value: label(role.package.version, "unknown") }] });
    graph.edge(workspace, agent, "contains", proof);
  }
  for (const role of roles) {
    if (role.reportTo && knownRoles.has(role.reportTo)) graph.edge(graph.id("agent", role.id), graph.id("agent", role.reportTo), "reports_to", { ...orgProof, locator: `position:${role.id}/reportTo` });
  }
  for (const [kind, configured] of [["mem", memConfigured], ["doc", docConfigured]] as const) {
    const proof = evidence("service_configuration", `service:${kind}`, "declared", graph.at);
    const source = graph.node("source", `service\0${kind}`, { label: kind === "mem" ? "统一网盘" : "外部文档", state: configured ? "available" : "not_configured", evidence: proof,
      facts: [{ key: "kind", value: kind === "mem" ? "mem_drive" : "doc_plane" }, { key: "binding", value: "available" }, { key: "inventory", value: "not_loaded" }] });
    graph.edge(source, workspace, "available_in", proof, "unknown");
    graph.coverage.push({ source: kind, state: configured ? "partial" : "not_connected", reason: configured ? "external_inventory_not_loaded" : "service_not_configured" });
  }
  graph.coverage.push({ source: "context", state: contextConfigured ? "partial" : "not_connected", reason: contextConfigured ? "recall_lineage_not_loaded" : "service_not_configured" });
  graph.coverage.push({ source: "mcp_runtime", state: "unsupported", reason: "employee_mcp_unsupported" });
  graph.coverage.push({ source: "execution_lineage", state: "unsupported", reason: "task_run_link_unavailable" });
  await addTasks(graph, root, workspace, knownRoles);
  await addGoals(graph, root, workspace, knownRoles);
  // Sequential bounded projection keeps IDs/truncation deterministic regardless of I/O timing.
  const documentSets: Array<{ role: OrgRole; source: string; docs: Documents }> = [];
  for (const role of roles) {
    const result = await positionDetails(graph, root, role, contextConfigured);
    if (result) documentSets.push({ role, ...result });
  }
  for (const { role, source, docs } of documentSets) {
    for (const doc of docs.files) {
      const proof = evidence("workspace_documents", locator(role.id, doc.path), "observed", graph.at);
      const resource = graph.node("resource", `document\0${role.id}\0${doc.path}`, { label: doc.path, state: "ready", positionId: role.id, resourcePath: doc.path, evidence: proof,
        facts: [{ key: "kind", value: "document" }, { key: "sizeBytes", value: String(doc.size) }, { key: "modifiedAt", value: doc.modifiedAt }] });
      graph.edge(source, resource, "contains_resource", proof, "unknown");
    }
  }
  if (ctx.workspace.active !== opened || opened.version.seq !== version) {
    throw new OrgApiError("graph_snapshot_stale", 409, "workspace changed while reading the relationship graph", true);
  }
  return graph.finish();
}
