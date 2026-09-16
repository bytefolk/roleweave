// @ts-check
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createLauncherSpawnSpec } from "./windows-launcher.js";
import { validatedWorkbuddyModel } from "./workbuddy-binary.js";

const RUNTIME_KEYS = [
  "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC",
  "HOME", "USER", "LOGNAME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

// Exact profiles from the audited product manifests and ToolNames enums.
// Empty --tools alone does NOT disable WorkBuddy's default tools. Every
// additional version must be audited and obtain its own complete deny list.
const VERSION_TOOLS = {
  "2.106.4": ["Agent","AskUserQuestion","Bash","BashOutput","ComputerUse","CronCreate","CronDelete","CronList","DeferExecuteTool","DelegateTool","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","Glob","Grep","ImageEdit","ImageGen","KillShell","LS","LSP","LeaveWorktree","ListMcpResources","MultiEdit","NotebookEdit","NotebookRead","PowerShell","Read","ReadMcpResource","SaveMemory","SendMessage","Skill","SkillManage","SlashCommand","StructuredOutput","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","TeamCreate","TeamDelete","TodoWrite","ToolSearch","VideoGen","WaitForMcpServers","WeChatReply","WeComReply","WebFetch","WebSearch","Workflow","Write"],
  "2.137.1": ["Agent","Artifact","ArtifactControl","AskUserQuestion","Bash","BashOutput","ComputerUse","CronCreate","CronDelete","CronList","DeferExecuteTool","DelegateTool","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","Glob","Grep","ImageEdit","ImageGen","KillShell","LS","LSP","LeaveWorktree","ListMcpResources","Monitor","MultiEdit","NotebookEdit","NotebookRead","PowerShell","PushNotification","REPL","Read","ReadMcpResource","ReportFindings","SaveMemory","SendMessage","SendUserMessage","Skill","SkillManage","SlashCommand","StructuredOutput","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","TeamCreate","TeamDelete","TodoWrite","ToolSearch","VideoGen","WaitForMcpServers","WeChatReply","WeComReply","WebFetch","WebSearch","Workflow","Write"],
};

/** @param {string} version */
export function workbuddyVersionProfile(version) {
  if (!Object.hasOwn(VERSION_TOOLS, version)) return null;
  const tools = VERSION_TOOLS[/** @type {keyof typeof VERSION_TOOLS} */ (version)];
  return tools ? { version, disallowedTools: [...tools] } : null;
}

/** @param {NodeJS.ProcessEnv} source @param {{probe?:boolean}} [options] */
export function workbuddyEnvironment(source, { probe = false } = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of RUNTIME_KEYS) if (source[key] !== undefined) env[key] = source[key];
  if (!probe) {
    for (const key of ["CODEBUDDY_API_KEY", "CODEBUDDY_MODEL", "CODEBUDDY_BASE_URL", "CODEBUDDY_INTERNET_ENVIRONMENT"]) {
      if (source[key] !== undefined) env[key] = source[key];
    }
  }
  Object.assign(env, {
      CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED: "1",
      CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
      CODEBUDDY_CODE_DISABLE_TERMINAL_TITLE: "1",
      CODEBUDDY_CODE_DONT_INHERIT_ENV: "1",
      CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
      CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
      CODEBUDDY_DISABLE_HOT_RELOAD: "1",
      CODEBUDDY_DISABLE_IDE: "1",
      CODEBUDDY_DISABLE_INPROCESS_TEAMMATES: "1",
      CODEBUDDY_DISABLE_MEMORY_CLEANUP: "1",
      CODEBUDDY_DISABLE_SHELL_SNAPSHOT: "1",
      CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1",
      CODEBUDDY_DISABLE_WEB_FETCH_REMOTE_API: "1",
      CODEBUDDY_GIT_REPO_SCAN_DISABLED: "1",
      CODEBUDDY_IMAGE_GEN_ENABLED: "0",
      CODEBUDDY_MEMORY_ENABLED: "0",
      CODEBUDDY_MEMORY_EXTRACTION_DISABLED: "1",
      CODEBUDDY_MEMORY_RELEVANCE_DISABLED: "1",
      CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
      CODEBUDDY_REMOTE_CONFIG_DISABLED: "1",
      CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1",
      CODEBUDDY_TEAM_IDLE_DETECTION_DISABLED: "1",
      CODEBUDDY_TEAM_MEMORY_ENABLED: "0",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_GALILEO: "1",
      DISABLE_MEMORY_MANAGEMENT: "1",
      DISABLE_TELEMETRY: "1",
  });
  if (env.CODEBUDDY_INTERNET_ENVIRONMENT?.toLowerCase() === "ioa") env.CODEBUDDY_INTERNET_ENVIRONMENT = "iOA";
  return env;
}

/** @param {NodeJS.ProcessEnv} env @returns {{ready:boolean,code:string,model?:string,baseUrl?:string}} */
export function workbuddyConfiguration(env) {
  const key = env.CODEBUDDY_API_KEY;
  if (!key?.trim()) return { ready: false, code: "workbuddy.credential_missing" };
  if (key.length > 8192 || key !== key.trim() || /[\u0000-\u001f\u007f]/.test(key)) return { ready: false, code: "workbuddy.credential_invalid" };
  const model = validatedWorkbuddyModel(env.ROLEWEAVE_TURN_MODEL ?? env.CODEBUDDY_MODEL);
  if (model === null) return { ready: false, code: "workbuddy.model_invalid" };
  if (model === undefined) return { ready: false, code: "workbuddy.model_missing" };
  if (env.CODEBUDDY_BASE_URL && /[\u0000-\u001f\u007f]/.test(env.CODEBUDDY_BASE_URL)) return { ready: false, code: "workbuddy.base_url_invalid" };
  const baseUrl = env.CODEBUDDY_BASE_URL?.trim();
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (baseUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(baseUrl) || url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw Error();
    } catch { return { ready: false, code: "workbuddy.base_url_invalid" }; }
  }
  const internet = env.CODEBUDDY_INTERNET_ENVIRONMENT;
  if (internet && !["external", "internal", "ioa", "selfhosted", "cloudhosted"].includes(internet.toLowerCase())) return { ready: false, code: "workbuddy.internet_environment_invalid" };
  return { ready: true, code: "workbuddy.configured", model, ...(baseUrl ? { baseUrl } : {}) };
}

/** @param {string} executable @param {NodeJS.ProcessEnv} env @param {{timeoutMs?:number,platform?:NodeJS.Platform}} [options] */
export function probeWorkbuddyExecutable(executable, env, { timeoutMs = 3000, platform = process.platform } = {}) {
  // Windows desktop distributions use an extensionless Node shebang and need
  // process-tree ownership that the current POSIX adapter cannot guarantee.
  // Do not probe or launch them until that lifecycle is independently verified.
  if (platform === "win32") return { ready: false, code: "workbuddy.platform_not_verified" };
  let temporaryRoot;
  let probePid;
  try {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleweave-workbuddy-probe-"));
    fs.chmodSync(temporaryRoot, 0o700);
    const probeEnvironment = workbuddyEnvironment(env, { probe: true });
    // Even --version can initialize CLI state. Give probes an empty home and
    // working directory so they cannot consult the operator's login/config.
    for (const key of ["HOME", "USERPROFILE", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]) probeEnvironment[key] = temporaryRoot;
    const spec = createLauncherSpawnSpec(executable, ["--version"], probeEnvironment, platform);
    const probe = spawnSync(spec.command, spec.args, {
      ...spec.options, cwd: temporaryRoot, ...{ detached: true }, encoding: "utf8", timeout: Math.min(Math.max(timeoutMs, 1), 5000),
      maxBuffer: 64 * 1024, killSignal: "SIGKILL", windowsHide: true,
    });
    probePid = probe.pid;
    if (probe.error || probe.status !== 0) return { ready: false, code: "workbuddy.version_probe_failed" };
    const text = (probe.stdout || probe.stderr || "").trim();
    // No prefix search: ambiguous output and pre-release suffixes cannot be
    // mistaken for a verified release's tool profile.
    const match = /^(?:(?:CodeBuddy(?: Code)?|codebuddy(?:-code)?)\s+)?(\d+\.\d+\.\d+)(?:\s+\(CodeBuddy Code\))?$/.exec(text);
    const version = match?.[1];
    if (!version || !workbuddyVersionProfile(version)) return { ready: false, code: "workbuddy.version_not_supported", ...(version ? { version } : {}) };
    return { ready: true, code: "workbuddy.ready", version };
  } catch { return { ready: false, code: "workbuddy.version_probe_failed" }; }
  finally {
    if (probePid) { try { process.kill(-probePid, "SIGKILL"); } catch { /* owned process group already gone */ } }
    if (temporaryRoot) { try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* owned temporary directory */ } }
  }
}

/** @param {string} model @param {string} version @param {string} settingsFile */
export function workbuddyTurnArgs(model, version, settingsFile) {
  const profile = workbuddyVersionProfile(version);
  if (!profile) throw new Error("workbuddy.version_not_supported");
  return ["-p", "--input-format", "text", "--output-format", "stream-json", "--include-partial-messages",
    "--tools", "", "--disallowedTools", profile.disallowedTools.join(","), "--permission-mode", "default",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "none", "--settings", settingsFile,
    "--model", model];
}

/** @param {string} code */
function protocolError(code = "workbuddy.protocol_invalid") { return new Error(code); }

/**
 * Validate the host's observed tool/configuration boundary before accepting
 * model text. Unknown protocol shapes remain closed until explicitly audited.
 * @param {{sessionId:string,cwd:string,model:string,onDelta:(text:string)=>void}} expected
 */
export function createWorkbuddyParser(expected) {
  let initialized = false, resultSeen = false, output = "", currentText = "";
  /** @param {unknown} value @returns {value is Record<string, any>} */
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  /** @param {string} text */
  const delta = (text) => { if (text) { output += text; currentText += text; expected.onDelta(text); } };
  /** @param {any[]} content */
  const textContent = (content) => content.map((block) => {
    if (!record(block)) throw protocolError();
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if ((block.type === "thinking" && typeof block.thinking === "string") || block.type === "redacted_thinking") return "";
    throw protocolError("workbuddy.tool_surface_violation");
  }).join("");
  /** @param {unknown} value */
  const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  /** @param {Record<string, any>} value @param {string[]} keys */
  const known = (value, keys) => Object.keys(value).every((key) => [...keys, "__timestamp", "_requestId"].includes(key)) && (value.__timestamp === undefined || (typeof value.__timestamp === "string" && value.__timestamp.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.__timestamp))) && (value._requestId === undefined || identifier(value._requestId));
  return {
    /** @param {unknown} value */
    accept(value) {
      if (resultSeen) throw protocolError("workbuddy.event_after_result");
      if (!record(value) || typeof value.type !== "string") throw protocolError();
      if (value.session_id !== undefined && value.session_id !== expected.sessionId) throw protocolError("workbuddy.session_mismatch");
      if (value.type === "system" && value.subtype === "init") {
        if (initialized || value.session_id !== expected.sessionId || typeof value.cwd !== "string" || path.resolve(value.cwd) !== path.resolve(expected.cwd) || value.permissionMode !== "default" || value.model !== expected.model || !Array.isArray(value.tools) || value.tools.length !== 0 || !Array.isArray(value.mcp_servers) || value.mcp_servers.length !== 0) throw protocolError("workbuddy.init_invalid");
        initialized = true;
        return null;
      }
      if (value.type === "result" && (value.subtype !== "success" || value.is_error !== false)) throw protocolError("workbuddy.result_error");
      if (!initialized) throw protocolError("workbuddy.init_missing");
      if (value.type === "file-history-snapshot") {
        const snapshot = value.snapshot;
        if (!identifier(value.id) || !Number.isFinite(value.timestamp) || value.timestamp < 0 || value.isSnapshotUpdate !== false || !record(snapshot) || !identifier(snapshot.messageId) || !record(snapshot.trackedFileBackups) || Object.keys(snapshot.trackedFileBackups).length !== 0 || Object.keys(snapshot).some((key) => !["messageId", "trackedFileBackups"].includes(key)) || !known(value, ["type", "id", "timestamp", "isSnapshotUpdate", "snapshot"])) throw protocolError("workbuddy.snapshot_invalid");
        return null;
      }
      if (value.session_id !== expected.sessionId) throw protocolError("workbuddy.session_mismatch");
      if (value.type === "system" && value.subtype === "status") {
        if (value.status !== null || !identifier(value.uuid) || !known(value, ["type", "subtype", "status", "uuid", "session_id"])) throw protocolError("workbuddy.status_invalid");
        return null;
      }
      if (value.type === "rate_limit_event") return null;
      if (value.type === "stream_event") {
        if (value.parent_tool_use_id !== null) throw protocolError("workbuddy.subagent_denied");
        const event = value.event;
        if (!record(event)) throw protocolError();
        if (event.type === "content_block_delta") {
          if (!record(event.delta)) throw protocolError();
          if (event.delta.type === "text_delta" && typeof event.delta.text === "string") delta(event.delta.text);
          else if (!(event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") && !(event.delta.type === "signature_delta" && typeof event.delta.signature === "string")) throw protocolError("workbuddy.tool_surface_violation");
        } else if (event.type === "message_start") {
          if (!record(event.message) || event.message.role !== "assistant" || !Array.isArray(event.message.content)) throw protocolError();
          textContent(event.message.content);
          currentText = "";
        } else if (event.type === "content_block_start") {
          if (!record(event.content_block)) throw protocolError();
          textContent([event.content_block]);
        } else if (event.type === "message_delta") {
          if (!record(event.delta) || "content" in event.delta || "tool_use" in event.delta || (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null && !["end_turn", "max_tokens", "stop_sequence"].includes(event.delta.stop_reason))) throw protocolError("workbuddy.tool_surface_violation");
        } else if (!["content_block_stop", "message_stop", "ping"].includes(event.type)) throw protocolError();
        return null;
      }
      if (value.type === "assistant") {
        if (value.parent_tool_use_id !== null) throw protocolError("workbuddy.subagent_denied");
        if (!record(value.message) || !Array.isArray(value.message.content)) throw protocolError();
        const snapshot = textContent(value.message.content);
        if (!snapshot.startsWith(currentText)) throw protocolError();
        delta(snapshot.slice(currentText.length));
        return null;
      }
      if (value.type === "result") {
        if (typeof value.result !== "string" || (value.permission_denials !== undefined && (!Array.isArray(value.permission_denials) || value.permission_denials.length > 0))) throw protocolError();
        const usage = record(value.usage) ? value.usage : {};
        /** @type {{inputTokens?:number,outputTokens?:number}} */
        const mappedUsage = {};
        for (const [source, target] of /** @type {const} */ ([["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"]])) {
          if (usage[source] !== undefined) {
            if (!Number.isSafeInteger(usage[source]) || usage[source] < 0) throw protocolError();
            mappedUsage[target] = usage[source];
          }
        }
        resultSeen = true;
        return { output: value.result || output, usage: mappedUsage };
      }
      throw protocolError();
    },
  };
}
