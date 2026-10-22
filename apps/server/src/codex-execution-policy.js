import fs from "node:fs/promises";
import path from "node:path";

const ACTIONS = ["read", "create", "update", "delete", "execute"];
const TOOLS = ["Read", "Write", "Edit", "Delete", "Exec"];
const PRIVATE_ROOTS = new Set(["positions", ".roleweave", ".digital-employee", ".workbench", ".codex", ".git"]);
const PROFILE = "roleweave-employee";
function inside(root, target) {
  const rel = path.relative(root, target);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
function invalid() { throw new Error("unsupported Codex execution policy"); }
async function json(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) invalid();
  return JSON.parse(await fs.readFile(file, "utf8"));
}

/** Re-read operator-owned policy for each turn. Native execution is a separate
 * opt-in: it allows host reads, so a narrow Read rule alone cannot enable it.
 * Only complete, approval-free directory grants can be represented by an OS
 * filesystem sandbox; never approximate deny rules or per-command approvals.
 */
export async function codexExecutionPlan(workspaceDir, positionDir, positionId) {
  const workspace = await fs.realpath(workspaceDir);
  const position = await fs.realpath(positionDir);
  if (!inside(workspace, position)) invalid();
  let permissions;
  try { permissions = await json(path.join(position, "permissions.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (permissions.nativeExecution === undefined || permissions.nativeExecution === false) return null;
  if (permissions.schemaVersion !== "workbench-permissions.v1" || permissions.nativeExecution !== true) invalid();
  const employee = await json(path.join(position, "employee.json"));
  const organization = await json(path.join(workspace, "organization.v1alpha1.json"));
  const role = organization.roles?.find(entry => entry.id === positionId);
  if (employee.policy?.mode === "read_only" || role?.mode === "read_only") return null;
  if (employee.name !== positionId || employee.policy?.mode !== "approval_required" || (role?.mode !== undefined && role.mode !== "approval_required")) invalid();
  if (!Array.isArray(permissions.tools) || !TOOLS.every(tool => permissions.tools.includes(tool))) invalid();
  if (role?.toolAllow !== undefined && (!Array.isArray(role.toolAllow) || !TOOLS.every(tool => role.toolAllow.includes(tool)))) invalid();
  if (role?.toolDeny !== undefined && (!Array.isArray(role.toolDeny) || role.toolDeny.some(tool => TOOLS.includes(tool)))) invalid();
  if (permissions.mcpServers !== undefined && (!Array.isArray(permissions.mcpServers) || permissions.mcpServers.length)) invalid();
  if (!Array.isArray(permissions.rules) || permissions.rules.length > 64) invalid();
  const roots = [];
  for (const rule of permissions.rules) {
    if (!rule || !Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.some(action => !ACTIONS.includes(action)) || ![undefined, "allow"].includes(rule.effect) || ![undefined, false, true].includes(rule.approval)) invalid();
    // A host-read consent cannot enforce read denials or read approvals either.
    if (rule.approval === true) invalid();
    if (rule.actions.every(action => action === "read")) continue;
    if (rule.scope !== "workspace" || rule.approval !== false || !ACTIONS.every(action => rule.actions.includes(action))) invalid();
    if (typeof rule.resource !== "string" || rule.resource.length > 512 || !rule.resource.startsWith("./") || !rule.resource.endsWith("/**")) invalid();
    if (!employee.policy?.filesystem?.read?.includes(rule.resource) || !employee.policy?.filesystem?.write?.includes(rule.resource)) invalid();
    const relative = rule.resource.slice(2, -3);
    const parts = relative.split("/");
    if (!relative || /[\\:*?\[\]{}\u0000-\u001f]/.test(relative) || parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)) || PRIVATE_ROOTS.has(parts[0].toLowerCase())) invalid();
    let current = workspace;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    }
    const root = await fs.realpath(current);
    if (!inside(workspace, root) || root === workspace || inside(root, position)) invalid();
    if (!roots.includes(root)) roots.push(root);
  }
  if (!roots.length || roots.length > 16) invalid();
  if (permissions.network !== undefined && !["deny", "host_policy"].includes(permissions.network)) invalid();
  // Both projections must agree. A package alone or a stale UI grant is not
  // enough to enable tool egress. Model/provider connectivity is independent.
  const network = permissions.network === "host_policy" && employee.policy?.network === "host_policy";
  const gitRoots = [];
  for (const root of roots) {
    const children = await fs.readdir(root, { withFileTypes: true });
    for (const dir of [root, ...children.filter(entry => entry.isDirectory()).slice(0, 128).map(entry => path.join(root, entry.name))]) {
      const git = path.join(dir, ".git");
      try {
        const stat = await fs.lstat(git);
        // Linked worktrees/submodules need separate authorization of their
        // external metadata, which this bounded directory contract cannot give.
        if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await fs.realpath(git))) invalid();
        gitRoots.push(git);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return { roots, gitRoots, network };
}

/** Keep default turns byte-for-byte read-only. Explicit execution uses a named
 * permissions profile; mixing it with --sandbox would override the profile.
 */
/** @param {string[]} baseArgs
 * @param {{roots: string[], gitRoots: string[], network: boolean} | null} plan
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function applyCodexExecutionPlan(baseArgs, plan, platform = process.platform) {
  if (!plan) return baseArgs;
  const args = [];
  for (let i = 0; i < baseArgs.length; i++) {
    if (baseArgs[i] === "--sandbox") { i++; continue; }
    if (baseArgs[i] === "--disable" && ["shell_tool", "unified_exec"].includes(baseArgs[i + 1])) { i++; continue; }
    args.push(baseArgs[i]);
  }
  const filesystem = { ":root": "read" };
  for (const root of [...plan.roots, ...plan.gitRoots]) filesystem[root] = "write";
  const table = "{" + Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",") + "}";
  args.push("--ignore-rules", "--cd", plan.roots[0], "--enable", "shell_tool", "--enable", "unified_exec",
    "-c", 'approval_policy="never"',
    "-c", `default_permissions="${PROFILE}"`,
    "-c", `permissions.${PROFILE}.filesystem=${table}`,
    "-c", `permissions.${PROFILE}.network.enabled=${plan.network}`,
    "-c", "features.network_proxy=false",
    "-c", "allow_login_shell=false",
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", `developer_instructions=${JSON.stringify("RoleWeave native execution is authorized for this turn. Read access follows the host filesystem; writes are restricted to: " + plan.roots.join(", ") + ". Tool networking is " + (plan.network ? "allowed under the host network policy" : "denied") + ". Use actual tools and report verified results. Earlier chat claims about unavailable tools may be stale. Do not discard local changes or use reset, clean or force-push without explicit task authorization.")}`);
  // The unelevated backend only injects dead proxies for network=deny; raw
  // sockets can bypass those. Offline execution must use the elevated backend
  // (and fail closed if unavailable), never silently fall back to unelevated.
  if (platform === "win32") args.push("-c", `windows.sandbox="${plan.network ? "unelevated" : "elevated"}"`,
    // Git for Windows' Schannel credential lookup can fail in the restricted
    // token. OpenSSL keeps certificate verification enabled in this child only.
    "-c", 'shell_environment_policy.set={GIT_CONFIG_COUNT="1",GIT_CONFIG_KEY_0="http.sslBackend",GIT_CONFIG_VALUE_0="openssl",GIT_TERMINAL_PROMPT="0"}');
  return args;
}
