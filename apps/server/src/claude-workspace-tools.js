import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { redactApprovalSecrets } from "@roleweave/shared/approval-redaction";

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const PRIVATE_DIRS = new Set([".git", ".roleweave", ".digital-employee", ".workbench", ".claude", ".codex", "node_modules"]);
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_RESULTS = 200;
function denied(message = "该文件不在员工已授权的读取范围内。") { throw new Error(message); }
function inside(root, target) { const rel = path.relative(root, target); return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`); }
function slash(value) { return value.split(path.sep).join("/"); }
function glob(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 4096 || /[\u0000-\u001f\\]/.test(pattern)) denied("文件匹配模式无效。");
  if (process.platform === "win32") pattern = pattern.toLowerCase();
  const tokens = [];
  for (let index = 0; index < pattern.length; index++) {
    const ch = pattern[index];
    if (ch === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") { index++; tokens.push({ kind: "directories" }); }
      else tokens.push({ kind: "all" });
    } else tokens.push({ kind: ch === "*" ? "star" : ch === "?" ? "one" : "literal", ch });
  }
  const first = tokens.findIndex(token => token.kind !== "literal");
  const last = tokens.findLastIndex(token => token.kind !== "literal");
  const prefix = tokens.slice(0, first < 0 ? tokens.length : first).map(token => token.ch).join("");
  const suffix = last < 0 ? "" : tokens.slice(last + 1).map(token => token.ch).join("");
  return { test(value) {
    if (process.platform === "win32") value = value.toLowerCase();
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
    if (first < 0) return value === pattern;
    // Bounded dynamic matching, rather than a backtracking regular expression
    // built from model-controlled wildcard patterns.
    let previous = new Uint8Array(value.length + 1); previous[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(value.length + 1);
      if (["star", "all", "directories"].includes(token.kind)) {
        next[0] = previous[0]; let reachable = previous[0];
        for (let j = 1; j <= value.length; j++) {
          if (token.kind === "directories") { next[j] = previous[j] || (value[j - 1] === "/" && reachable) ? 1 : 0; reachable ||= previous[j]; }
          else next[j] = previous[j] || (next[j - 1] && (token.kind === "all" || value[j - 1] !== "/")) ? 1 : 0;
        }
      } else for (let j = 1; j <= value.length; j++) next[j] = previous[j - 1] && (token.kind === "one" ? value[j - 1] !== "/" : value[j - 1] === token.ch) ? 1 : 0;
      previous = next;
    }
    return previous[value.length] === 1;
  } };
}
function resource(value) {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\\:]/.test(value) || value.startsWith("/") || value.split("/").includes("..")) denied("员工读取规则无效。");
  return value.replace(/^\.\//, "");
}

/** Only explicit Workbench read grants become tools; native shell/write tools
 * and the operator's global MCP configuration never become available. */
export async function claudeReadPlan(workspaceDir, positionDir) {
  const workspace = await fs.realpath(workspaceDir);
  const position = await fs.realpath(positionDir);
  if (!inside(workspace, position)) denied();
  let permissions;
  try {
    const file = await fs.open(path.join(position, "permissions.json"), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { if ((await file.stat()).size > MAX_BYTES) denied(); permissions = JSON.parse(await file.readFile("utf8")); }
    finally { await file.close(); }
  } catch (error) { if (error.code !== "ENOENT") throw error; return { workspace, tools: [], rules: [] }; }
  if (permissions.schemaVersion !== "workbench-permissions.v1") denied("员工权限文件格式无效。");
  if (!Array.isArray(permissions.tools) || permissions.tools.length > 32 || permissions.tools.some(tool => !READ_TOOLS.has(tool))) denied("Claude 当前只支持员工声明的 Read、Glob、Grep 工具；未开放其他工具。");
  if (permissions.mcpServers !== undefined && (!Array.isArray(permissions.mcpServers) || permissions.mcpServers.length)) denied("Claude 当前不支持这些员工 MCP 绑定；未加载全局 MCP 配置。");
  if (!Array.isArray(permissions.rules) || permissions.rules.length > 64) denied("员工读取规则无效。");
  if (permissions.rules.some(rule => !rule || typeof rule !== "object" || !Array.isArray(rule.actions) || rule.actions.length > 5 || rule.actions.some(action => !["read", "create", "update", "delete", "execute"].includes(action)) || typeof rule.resource !== "string")) denied("员工读取规则无效。");
  const rules = permissions.rules.filter(rule => rule.actions?.includes("read") && !/^(skill|mcp):\/\//.test(rule.resource)).map(rule => {
    if (!["position", "workspace"].includes(rule.scope) || (rule.effect !== undefined && !["allow", "deny"].includes(rule.effect)) || (rule.approval !== undefined && typeof rule.approval !== "boolean")) denied("员工读取规则无效。");
    const prefix = rule.scope === "position" ? slash(path.relative(workspace, position)) + "/" : "";
    return { pattern: prefix + resource(rule.resource), effect: rule.effect ?? "allow", approval: rule.approval === true };
  });
  return { workspace, tools: [...new Set(permissions.tools)], rules };
}

export function createClaudeReadTools(plan) {
  const root = path.resolve(plan.workspace);
  const rules = plan.rules.map(rule => ({ ...rule, match: glob(rule.pattern) }));
  const allowed = relative => {
    const matches = rules.filter(rule => rule.match.test(relative));
    return matches.some(rule => rule.effect === "allow" && !rule.approval) && !matches.some(rule => rule.effect === "deny" || rule.approval);
  };
  function target(value = ".") {
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f]/.test(value) || /^\\\\/.test(value)) denied();
    const absolute = path.resolve(root, value);
    if (!inside(root, absolute)) denied();
    const relative = slash(path.relative(root, absolute));
    if (relative.split("/").some(part => PRIVATE_DIRS.has(part) || /^\.env(?:\.|$)/i.test(part) || /^(auth|credentials)\.json$/i.test(part))) denied();
    return { absolute, relative };
  }
  async function stablePath(absolute) {
    const relative = path.relative(root, absolute);
    let current = root;
    const identities = [];
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) denied("不读取符号链接或目录链接。");
      identities.push([current, stat.dev, stat.ino]);
    }
    if (!inside(root, await fs.realpath(absolute))) denied();
    return identities;
  }
  async function read(value) {
    const { absolute, relative } = target(value);
    if (!allowed(relative)) denied();
    const identities = await stablePath(absolute);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_BYTES) denied("仅支持读取不超过 1 MiB 的文本文件。");
      const last = identities.at(-1);
      if (!last || last[1] !== before.dev || last[2] !== before.ino) denied();
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await handle.stat();
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) denied("文件读取期间发生变化，请重试。");
      for (const [file, dev, ino] of identities) { const stat = await fs.lstat(file); if (stat.isSymbolicLink() || stat.dev !== dev || stat.ino !== ino) denied(); }
      if (!inside(root, await fs.realpath(absolute))) denied();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (text.includes("\0")) denied("仅支持文本文件。");
      return { relative, text: redactApprovalSecrets(text).replace(/\b((?:[A-Z0-9_]*_)?(?:token|secret|password|credential|api[_-]?key))(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[redacted]") };
    } finally { await handle.close(); }
  }
  async function files(base = ".") {
    const { absolute } = target(base);
    await stablePath(absolute);
    const result = [];
    let visited = 0, truncated = false;
    async function visit(directory) {
      if (visited >= MAX_ENTRIES) { truncated = true; return; }
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++visited > MAX_ENTRIES) { truncated = true; break; }
        if (entry.isSymbolicLink() || PRIVATE_DIRS.has(entry.name) || /^\.env(?:\.|$)/i.test(entry.name)) continue;
        let item;
        try { item = target(path.join(directory, entry.name)); await stablePath(item.absolute); } catch { continue; }
        if (entry.isDirectory()) await visit(item.absolute);
        else if (entry.isFile() && allowed(item.relative)) result.push(item.relative);
      }
    }
    const stat = await fs.lstat(absolute);
    if (stat.isFile()) { const item = target(absolute); if (allowed(item.relative)) result.push(item.relative); }
    else if (stat.isDirectory()) {
      // Start at the granted roots so a large, unrelated repository cannot
      // consume the enumeration budget before the employee's own knowledge.
      const roots = [];
      for (const rule of rules.filter(rule => rule.effect === "allow" && !rule.approval)) {
        const wildcard = rule.pattern.search(/[?*]/);
        const fixed = wildcard < 0 ? rule.pattern : rule.pattern.slice(0, wildcard);
        const scope = wildcard < 0 ? fixed : fixed.slice(0, fixed.lastIndexOf("/") + 1);
        let candidate; try { candidate = target(scope || ".").absolute; } catch { continue; }
        if (inside(candidate, absolute)) candidate = absolute;
        else if (!inside(absolute, candidate)) continue;
        if (roots.some(existing => inside(existing, candidate))) continue;
        for (let index = roots.length - 1; index >= 0; index--) if (inside(candidate, roots[index])) roots.splice(index, 1);
        roots.push(candidate);
      }
      for (const candidate of roots) {
        let status; try { await stablePath(candidate); status = await fs.lstat(candidate); } catch { continue; }
        if (status.isDirectory()) await visit(candidate);
        else if (status.isFile() && allowed(target(candidate).relative)) result.push(target(candidate).relative);
      }
    }
    return { files: result, truncated };
  }
  const definitions = {
    Read: { name: "Read", description: "读取员工已授权范围内的文本文件。file_path 使用工作区相对路径；不提供写入或命令执行能力。", inputSchema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["file_path"], additionalProperties: false } },
    Glob: { name: "Glob", description: "在员工已授权的文件中按 glob 模式查找路径，支持 **、*、?。", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false } },
    Grep: { name: "Grep", description: "在已授权文本文件中按字面文本搜索 pattern（不执行正则或 shell），可用 glob 筛选路径。", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"], additionalProperties: false } },
  };
  return {
    definitions: plan.tools.map(name => ({ ...definitions[name], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })),
    async call(name, args) {
      if (!plan.tools.includes(name) || !args || typeof args !== "object" || Array.isArray(args)) denied("未授权的工具或参数。");
      const schema = definitions[name].inputSchema;
      if (Object.keys(args).some(key => !(key in schema.properties)) || schema.required.some(key => typeof args[key] !== "string" || !args[key]) || (args.path !== undefined && typeof args.path !== "string") || (args.glob !== undefined && typeof args.glob !== "string")) denied("工具参数无效。");
      if (name === "Read") {
        const offset = args.offset ?? 1, limit = args.limit ?? 300;
        if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) denied("读取行数无效。");
        const file = await read(args.file_path), lines = file.text.split(/\r?\n/), text = lines.slice(offset - 1, offset - 1 + limit).join("\n");
        return { path: file.relative, offset, totalLines: lines.length, text: text.slice(0, 64000), truncated: offset - 1 + limit < lines.length || text.length > 64000 };
      }
      if (args.pattern.length > 512) denied("搜索或匹配模式过长。");
      const scan = await files(args.path ?? ".");
      if (name === "Glob") { const match = glob(args.pattern); const found = scan.files.filter(file => match.test(file)); return { files: found.slice(0, MAX_RESULTS), truncated: scan.truncated || found.length > MAX_RESULTS }; }
      if (args.pattern.length > 512) denied("搜索文本过长。");
      const match = args.glob ? glob(args.glob) : null, matches = [];
      for (const file of scan.files) {
        if (match && !match.test(file)) continue;
        let content; try { content = await read(file); } catch { continue; }
        for (const [index, line] of content.text.split(/\r?\n/).entries()) if (line.includes(args.pattern)) {
          matches.push({ path: file, line: index + 1, text: line.slice(0, 300) });
          if (matches.length >= MAX_RESULTS) return { matches, truncated: true };
        }
      }
      return { matches, truncated: scan.truncated };
    },
  };
}
