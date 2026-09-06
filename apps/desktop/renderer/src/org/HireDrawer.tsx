/**
 * Conversational hire intake.
 *
 * The selected local Agent proposes semantics (role, duties and a first
 * policy draft). The platform owns the deterministic part: generated id,
 * parent, token caps, permission shape and the final POST /hire gate.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button as AntButton, Checkbox, Drawer, Input, Select, Steps, message } from "antd";
import { CheckCircle2, ChevronDown, LoaderCircle, Plus, RotateCcw, Shield, Sparkles, Trash2, XCircle } from "lucide-react";
import { Input as OwbInput } from "@fullstack-ai-infra/ui";
import { useT, type OwbT } from "@roleweave/ui";
import { hireMcpCatalog, hireSkillCatalog } from "@roleweave/shared/capabilities";
import type { HireMcpGrant, HireSkillGrant } from "@roleweave/shared/capabilities";
import type { HireMemorySource, HirePermissionAction, HirePermissionRule, HirePermissions } from "@roleweave/shared";
import { EngineSelect } from "../turns/TurnPanel";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";
import { createHireDraft, initialHireFlow, parseHireProposal, reduceHireFlow, toHirePositionRequest } from "./hire-flow";
import type { HireDraft } from "./hire-flow";

const MAX_POSITION_ID_LENGTH = 64;
const HIRE_STALL_TIMEOUT_MS = 60_000;
const AGENT_CONVERSATION_TIMEOUT_MS = 75_000;
const PLATFORM_BUDGET_POOL = 10_000_000;

const PHASE_COPY_KEYS: Record<string, string> = { validate: "hire.phaseValidate", stage: "hire.phaseStage", apply: "hire.phaseApply" };
const FAILURE_COPY_KEYS: Record<string, string> = { hire_position_exists: "hire.errExists", hire_timeout: "hire.errTimeout", control_plane_unreachable: "hire.errOffline", engine_unavailable: "hire.errCli", engine_capability_missing: "hire.errCapability" };
const ACTIONS: Array<{ value: HirePermissionAction; labelKey: string }> = [
  { value: "read", labelKey: "hire.actionRead" }, { value: "create", labelKey: "hire.actionCreate" }, { value: "update", labelKey: "hire.actionUpdate" }, { value: "delete", labelKey: "hire.actionDelete" }, { value: "execute", labelKey: "hire.actionExecute" },
];
const MEMORY_OPTIONS: Array<{ kind: HireMemorySource["kind"]; labelKey: string; locator: string }> = [
  { kind: "position_docs", labelKey: "hire.memoryPositionDocs", locator: "./knowledge/**" },
  { kind: "workspace_docs", labelKey: "hire.memoryWorkspaceDocs", locator: "./**" },
  { kind: "mem_drive", labelKey: "hire.memorySharedDrive", locator: "mem://workspace" },
];

interface HireDrawerProps {
  open: boolean;
  positions: Array<{ id: string; name: string }>;
  presetReportTo: string | null;
  engine: TurnEngine;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  conversationHostId: string | null;
  conversationHostName?: string;
  budgetPoolTokens?: number;
  budgetAllocatedTokens?: number;
  onSelectEngine: (engine: TurnEngine) => void;
  onClose: () => void;
  onHired: (positionId: string, name: string) => void;
}

type HireMessage = { role: "user" | "assistant"; text: string };

function slugify(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (normalized) return normalized;
  if (!value.trim()) return "position";

  // Keep IDs deterministic for names without Latin letters while keeping the
  // generated identifier out of the form. The operator only needs the name;
  // the platform owns this stable, path-safe suffix.
  let hash = 2166136261;
  for (const character of value.trim()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `position-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

function nextGeneratedId(name: string, positions: Array<{ id: string }>): string {
  const used = new Set(positions.map((position) => position.id));
  const base = slugify(name).slice(0, MAX_POSITION_ID_LENGTH);
  if (!used.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, MAX_POSITION_ID_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 56)}-${Date.now().toString(36)}`.slice(0, MAX_POSITION_ID_LENGTH);
}

function proposalText(record: unknown): string {
  if (typeof record !== "object" || record === null) return "";
  const output = (record as { output?: unknown }).output;
  if (typeof output === "string") return output;
  if (output !== undefined) return JSON.stringify(output, null, 2);
  const error = (record as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : "";
}

function defaultPrompt(t: OwbT): string {
  return t("hire.agentPromptTemplate");
}

function toggleAction(rule: HirePermissionRule, action: HirePermissionAction): HirePermissionRule {
  const actions = rule.actions.includes(action) ? rule.actions.filter((item) => item !== action) : [...rule.actions, action];
  return { ...rule, actions: actions.length > 0 ? actions : ["read"] };
}

function capabilityRules(skills: HireSkillGrant[], mcpServers: HireMcpGrant[]): HirePermissionRule[] {
  return [
    ...skills.map((skill) => ({ scope: "position" as const, resource: `skill://${skill.id}`, actions: ["execute" as const] })),
    ...mcpServers.map((server) => ({ scope: "workspace" as const, resource: `mcp://${server.id}`, actions: ["execute" as const], approval: true })),
  ];
}

function replaceCapabilityRules(permissions: HirePermissions, skills: HireSkillGrant[], mcpServers: HireMcpGrant[]): HirePermissions {
  return {
    ...permissions,
    skills,
    mcpServers,
    rules: [
      ...permissions.rules.filter((rule) => !rule.resource.startsWith("skill://") && !rule.resource.startsWith("mcp://")),
      ...capabilityRules(skills, mcpServers),
    ],
  };
}

interface CapabilityPickerProps {
  permissions: HirePermissions;
  onToggleSkill: (id: HireSkillGrant["id"]) => void;
  onToggleMcpServer: (id: HireMcpGrant["id"]) => void;
  onToggleMcpTool: (id: HireMcpGrant["id"], tool: string) => void;
}

function CapabilityPicker({ permissions, onToggleSkill, onToggleMcpServer, onToggleMcpTool }: CapabilityPickerProps) {
  const t = useT();
  return (
    <section className="owb-hire-capability-panel" aria-label={t("hire.capabilityTitle")}>
      <div className="owb-hire-capability-panel__head">
        <div>
          <p className="owb-hire-eyebrow">03 · 能力装配</p>
          <h3>{t("hire.capabilityTitle")}</h3>
          <p>{t("hire.capabilityHint")}</p>
        </div>
        <span className="owb-hire-capability-panel__count">{(permissions.skills ?? []).length + (permissions.mcpServers ?? []).length} {t("hire.capabilityCount")}</span>
      </div>
      <div className="owb-hire-capability-grid">
        <section className="owb-hire-capability">
          <div className="owb-hire-capability__head"><strong>{t("hire.skillsTitle")}</strong><span>{t("hire.skillsHint")}</span></div>
          <div className="owb-hire-capability__options">
            {hireSkillCatalog.map((skill) => (
              <button type="button" className={(permissions.skills ?? []).some((item) => item.id === skill.id) ? "is-selected" : ""} key={skill.id} onClick={() => onToggleSkill(skill.id)} title={skill.description}>
                <b>{skill.name}</b>
              </button>
            ))}
          </div>
        </section>
        <section className="owb-hire-capability">
          <div className="owb-hire-capability__head"><strong>{t("hire.mcpTitle")}</strong><span>{t("hire.mcpHint")}</span></div>
          <div className="owb-hire-capability__options">
            {hireMcpCatalog.map((server) => {
              const grant = (permissions.mcpServers ?? []).find((item) => item.id === server.id);
              return (
                <div className={`owb-hire-mcp ${grant ? "is-selected" : ""}`} key={server.id}>
                  <button type="button" className="owb-hire-mcp__select" onClick={() => onToggleMcpServer(server.id)} title={server.description}>
                    <b>{server.name}</b><small>{grant ? t("hire.mcpBound") : t("hire.mcpAvailable")}</small>
                  </button>
                  {grant ? <div className="owb-hire-mcp__tools" aria-label={t("hire.mcpToolsAria")}>
                    {server.tools.map((tool) => <button type="button" className={grant.tools.includes(tool) ? "is-selected" : ""} key={tool} onClick={() => onToggleMcpTool(server.id, tool)}>{tool}</button>)}
                  </div> : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <p className="owb-hire-capability-note">{t("hire.capabilityPermissionHint")}</p>
    </section>
  );
}

export function HireDrawer({ open, positions, presetReportTo, engine, engineAvailability, conversationHostId, conversationHostName, budgetPoolTokens = PLATFORM_BUDGET_POOL, budgetAllocatedTokens = 0, onSelectEngine, onClose, onHired }: HireDrawerProps) {
  const t = useT();
  const [flow, dispatch] = useReducer(reduceHireFlow, undefined, () => initialHireFlow());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reportTo, setReportTo] = useState<string | null>(presetReportTo);
  const [mode, setMode] = useState<HireDraft["mode"]>("approval_required");
  const [taskTokens, setTaskTokens] = useState("20000");
  const [taskIterations, setTaskIterations] = useState("8");
  const [dayTokens, setDayTokens] = useState("200000");
  const [dayIterations, setDayIterations] = useState("64");
  const [prompt, setPrompt] = useState(() => defaultPrompt(t));
  const [messages, setMessages] = useState<HireMessage[]>([]);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [permissions, setPermissions] = useState<HirePermissions>({ tools: ["Read", "Grep", "Glob"], rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }], skills: [], mcpServers: [] });
  const [memorySources, setMemorySources] = useState<HireMemorySource[]>([{ kind: "position_docs", locator: "./knowledge/**" }]);
  const [phaseCopy, setPhaseCopy] = useState(t("hire.phaseSubmit"));
  const [messageApi, contextHolder] = message.useMessage();
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationRequest = useRef(0);
  const unsubscribe = useRef<(() => void) | null>(null);

  const clearTimers = useCallback(() => { if (stallTimer.current !== null) clearTimeout(stallTimer.current); stallTimer.current = null; unsubscribe.current?.(); unsubscribe.current = null; }, []);
  const opened = useRef(false);
  useEffect(() => {
    if (!open) {
      opened.current = false;
      conversationRequest.current += 1;
      if (conversationTimer.current !== null) clearTimeout(conversationTimer.current);
      conversationTimer.current = null;
      setConversationBusy(false);
      clearTimers();
      return;
    }
    if (opened.current) return;
    opened.current = true;
    dispatch({ type: "reset", draft: createHireDraft() });
    setName(""); setDescription(""); setReportTo(presetReportTo);
    setMode("approval_required"); setTaskTokens("20000"); setTaskIterations("8"); setDayTokens("200000"); setDayIterations("64");
    setPrompt(defaultPrompt(t)); setMessages([]); setConversationBusy(false); setConversationError(null); setAdvancedOpen(false);
    setPermissions({ tools: ["Read", "Grep", "Glob"], rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }], skills: [], mcpServers: [] });
    setMemorySources([{ kind: "position_docs", locator: "./knowledge/**" }]); setPhaseCopy(t("hire.phaseSubmit"));
  }, [clearTimers, open, presetReportTo, t]);
  useEffect(() => () => {
    conversationRequest.current += 1;
    if (conversationTimer.current !== null) clearTimeout(conversationTimer.current);
    conversationTimer.current = null;
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  const armStallTimer = useCallback((targetId: string) => {
    if (stallTimer.current !== null) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => dispatch({ type: "fail", code: "hire_timeout", retryable: true }), HIRE_STALL_TIMEOUT_MS);
    unsubscribe.current?.();
    unsubscribe.current = window.owb.onEvent((event) => {
      const envelope = event as { type?: string; payload?: { positionId?: string; phase?: string } };
      if (envelope.type !== "hire.progress" || envelope.payload?.positionId !== targetId) return;
      const phase = envelope.payload.phase ?? "";
      setPhaseCopy((previous) => PHASE_COPY_KEYS[phase] !== undefined ? t(PHASE_COPY_KEYS[phase]) : previous);
      if (stallTimer.current !== null) clearTimeout(stallTimer.current);
      stallTimer.current = setTimeout(() => dispatch({ type: "fail", code: "hire_timeout", retryable: true }), HIRE_STALL_TIMEOUT_MS);
    });
  }, [t]);

  const generatedId = useMemo(() => nextGeneratedId(name, positions), [name, positions]);
  const positionId = generatedId;
  const nameValid = name.trim().length > 0 && name.trim().length <= 24;
  const descriptionValid = description.trim().length > 0;
  const allocated = Math.max(0, budgetAllocatedTokens);
  const remainingPool = Math.max(0, budgetPoolTokens - allocated);
  const parsedTaskTokens = Number(taskTokens);
  const parsedDayTokens = Number(dayTokens);
  const capsValid = (value: string, required: boolean) => value.trim() === "" ? !required : Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 1_000_000_000;
  const budgetValid = capsValid(taskTokens, true) && capsValid(dayTokens, true) && capsValid(taskIterations, false) && capsValid(dayIterations, false) && parsedTaskTokens <= parsedDayTokens && parsedDayTokens <= remainingPool;
  const formValid = nameValid && descriptionValid && budgetValid && permissions.tools.length > 0;

  const buildDraft = useCallback((): HireDraft => createHireDraft({ id: positionId, name: name.trim(), description: description.trim(), reportTo: reportTo || null, mode, budget: { perTask: { tokens: Number(taskTokens), ...(taskIterations.trim() ? { iterations: Number(taskIterations) } : {}) }, perDay: { tokens: Number(dayTokens), ...(dayIterations.trim() ? { iterations: Number(dayIterations) } : {}) } }, permissions, prompt: prompt.trim(), memorySources }), [dayIterations, dayTokens, description, memorySources, mode, name, permissions, positionId, prompt, reportTo, taskIterations, taskTokens]);

  const applyProposal = useCallback((raw: string) => {
    const proposal = parseHireProposal(raw);
    if (proposal.name) setName(proposal.name.slice(0, 24));
    if (proposal.description) setDescription(proposal.description.slice(0, 1_024));
    if (proposal.mode) setMode(proposal.mode);
    if (proposal.tools) setPermissions((current) => ({ ...current, tools: proposal.tools! }));
    if (proposal.skills || proposal.mcpServers) setPermissions((current) => {
      const skills = (proposal.skills ?? []).map((id) => hireSkillCatalog.find((skill) => skill.id === id)).filter((skill): skill is (typeof hireSkillCatalog)[number] => skill !== undefined).map((skill) => ({ id: skill.id }));
      const mcpServers = proposal.mcpServers ?? [];
      return replaceCapabilityRules(current, skills, mcpServers);
    });
    if (proposal.memorySources) setMemorySources(proposal.memorySources.flatMap((kind) => { const option = MEMORY_OPTIONS.find((item) => item.kind === kind); return option ? [{ kind, locator: option.locator }] : []; }));
    setAdvancedOpen(true);
  }, []);

  const askAgent = useCallback(async () => {
    const hostId = conversationHostId ?? positions[0]?.id ?? null;
    if (!hostId || !engineAvailability[engine].ready || prompt.trim().length === 0) return;
    const requestId = ++conversationRequest.current;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setConversationBusy(true); setConversationError(null);
    const input = `${prompt.trim()}${t("hire.agentContext", { name: name.trim() || t("hire.proposalPendingName"), reportTo: reportTo ?? t("hire.ownerRoot") })}`;
    setMessages((current) => [...current, { role: "user", text: input }]);
    try {
      const response = await Promise.race([
        window.owb.createTurn({ positionId: hostId, engine, input }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            void window.owb.cancelTurn(hostId).catch(() => undefined);
            reject(new Error("agent conversation timed out"));
          }, AGENT_CONVERSATION_TIMEOUT_MS);
          conversationTimer.current = timer;
        }),
      ]);
      if (requestId !== conversationRequest.current) return;
      if (response.status !== 200) { setConversationError(t("hire.agentConversationFail")); return; }
      const output = proposalText(response.body);
      if (!output) { setConversationError(t("hire.agentNoProposal")); return; }
      setMessages((current) => [...current, { role: "assistant", text: output }]);
      applyProposal(output);
    } catch {
      if (requestId !== conversationRequest.current) return;
      setConversationError(timedOut ? t("hire.agentConversationTimeout") : t("hire.agentConversationOffline"));
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (conversationTimer.current === timer) conversationTimer.current = null;
      if (requestId === conversationRequest.current) setConversationBusy(false);
    }
  }, [applyProposal, conversationHostId, engine, engineAvailability, name, positions, prompt, reportTo, t]);

  const submitRequest = useCallback(async (draft: HireDraft) => {
    dispatch({ type: "edit", draft }); dispatch({ type: "submit" }); setPhaseCopy(t("hire.phaseSubmit")); armStallTimer(draft.id);
    try {
      const response = await window.owb.hire(toHirePositionRequest(draft)); clearTimers();
      if (response.status === 200 && response.body.status === "hired") { dispatch({ type: "succeed", positionId: draft.id }); messageApi.success(t("hire.joined", { name: draft.name })); onHired(draft.id, draft.name); onClose(); return; }
      const body = response.body as { code?: string; retryable?: boolean }; dispatch({ type: "fail", code: body.code ?? "hire_failed", retryable: body.retryable ?? false });
    } catch { clearTimers(); dispatch({ type: "fail", code: "control_plane_unreachable", retryable: true }); }
  }, [armStallTimer, clearTimers, messageApi, onClose, onHired, t]);
  const submit = useCallback(() => { if (formValid) void submitRequest(buildDraft()); }, [buildDraft, formValid, submitRequest]);
  const retry = useCallback(() => { if (flow.phase === "failed" && flow.retryable) void submitRequest(flow.draft); }, [flow, submitRequest]);
  const stepCurrent = flow.phase === "draft" ? 0 : flow.phase === "succeeded" ? 2 : 1;
  const poolPercent = budgetPoolTokens > 0 ? Math.min(100, (allocated / budgetPoolTokens) * 100) : 100;
  const toggleTool = (tool: string) => setPermissions((current) => ({ ...current, tools: current.tools.includes(tool) ? current.tools.filter((item) => item !== tool) : [...current.tools, tool] }));
  const toggleSkill = (id: HireSkillGrant["id"]) => setPermissions((current) => {
    const skills = current.skills ?? [];
    const nextSkills = skills.some((skill) => skill.id === id) ? skills.filter((skill) => skill.id !== id) : [...skills, { id }];
    return replaceCapabilityRules(current, nextSkills, current.mcpServers ?? []);
  });
  const toggleMcpServer = (id: HireMcpGrant["id"]) => setPermissions((current) => {
    const mcpServers = current.mcpServers ?? [];
    const existing = mcpServers.find((server) => server.id === id);
    const nextServers = existing ? mcpServers.filter((server) => server.id !== id) : [...mcpServers, { id, tools: [...(hireMcpCatalog.find((server) => server.id === id)?.tools ?? [])] }];
    return replaceCapabilityRules(current, current.skills ?? [], nextServers);
  });
  const toggleMcpTool = (id: HireMcpGrant["id"], tool: string) => setPermissions((current) => ({
    ...current,
    mcpServers: (current.mcpServers ?? []).map((server) => server.id !== id ? server : { ...server, tools: server.tools.includes(tool) ? server.tools.filter((item) => item !== tool) : [...server.tools, tool] }),
  }));
  const toggleMemory = (kind: HireMemorySource["kind"]) => setMemorySources((current) => { if (current.some((source) => source.kind === kind)) return current.filter((source) => source.kind !== kind); const option = MEMORY_OPTIONS.find((item) => item.kind === kind)!; return [...current, { kind, locator: option.locator }]; });

  return (
    <Drawer className="owb-hire-drawer-shell" title={t("hire.createTitle")} width="min(760px, calc(100vw - 24px))" open={open} onClose={() => { if (flow.phase !== "draft" && flow.phase !== "failed") return; clearTimers(); onClose(); }} destroyOnHidden>
      {contextHolder}
      {flow.phase === "draft" ? <div className="owb-hire-shell">
        <div className="owb-hire-shell__scroll">
          <div className="owb-hire-drawer owb-hire-drawer--conversation">
            <section className="owb-hire-agent-picker"><div><p className="owb-hire-eyebrow">{t("hire.agentStep")}</p><h3><Sparkles aria-hidden="true" size={17} />{t("hire.agentTitle")}</h3><p>{t("hire.agentDescription")}</p></div><EngineSelect engines={["qoder", "claude-code", "claude-local"]} engineAvailability={engineAvailability} value={engine} onChange={onSelectEngine} /></section>
            <section className="owb-hire-conversation" aria-label={t("hire.agentConversationAria")}><div className="owb-hire-conversation__meta"><span className="owb-hire-conversation__host"><span className="owb-led owb-led--running" />{conversationHostName ?? t("hire.agentWorkspaceContext")}</span><span>{t("hire.agentNoWrite")}</span></div>{messages.length === 0 ? <div className="owb-hire-conversation__empty"><Sparkles aria-hidden="true" size={20} /><span>{t("hire.agentEmpty")}</span></div> : <div className="owb-hire-conversation__messages">{messages.map((entry, index) => <div className={`owb-hire-message is-${entry.role}`} key={`${entry.role}-${index}`}><span>{entry.role === "user" ? t("hire.you") : t("hire.agent")}</span><p>{entry.text}</p></div>)}</div>}<div className="owb-hire-prompt"><div className="owb-hire-prompt__heading"><label htmlFor="owb-hire-prompt-input">{t("hire.promptLabel")}</label><button type="button" onClick={() => setPrompt(defaultPrompt(t))}><RotateCcw aria-hidden="true" size={12} />{t("hire.resetPrompt")}</button></div><Input.TextArea id="owb-hire-prompt-input" value={prompt} autoSize={{ minRows: 3, maxRows: 6 }} onChange={(event) => setPrompt(event.target.value)} placeholder={t("hire.promptPh")} /><div className="owb-hire-prompt__footer"><span>{t("hire.promptEditable")}</span><AntButton type="primary" loading={conversationBusy} disabled={!engineAvailability[engine].ready || (!conversationHostId && positions.length === 0) || prompt.trim().length === 0} onClick={() => void askAgent()} icon={<Sparkles aria-hidden="true" size={14} />}>{conversationBusy ? t("hire.askingAgent") : t("hire.askAgent")}</AntButton></div>{conversationError ? <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{conversationError}</p> : null}</div></section>
            <section className="owb-hire-draft-card">
              <div className="owb-hire-draft-card__heading">
                <div><p className="owb-hire-eyebrow">{t("hire.draftStep")}</p><h3>{t("hire.draftTitle")}</h3></div>
                <span className="owb-hire-draft-card__status">{name ? t("hire.draftReady") : t("hire.waitingProposal")}</span>
              </div>
              <div className="owb-hire-basic-grid">
                <label><span>{t("hire.name")}</span><OwbInput value={name} maxLength={24} onChange={(event) => setName(event.target.value)} placeholder={t("hire.namePh")} /></label>
                <label><span>{t("hire.reportTo")}</span><Select value={reportTo ?? ""} onChange={(value: string) => setReportTo(value === "" ? null : value)} options={[{ value: "", label: t("hire.ownerRoot") }, ...positions.map((position) => ({ value: position.id, label: t("hire.reportOption", { name: position.name }) }))]} /></label>
                <label className="owb-hire-basic-grid__wide"><span>{t("hire.desc")}</span><Input.TextArea value={description} maxLength={1_024} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event) => setDescription(event.target.value)} placeholder={t("hire.descPh")} /></label>
              </div>
              <div className="owb-hire-summary-row">
                <span>{t("hire.idAutoNote")}</span>
                <span><b>{t("hire.budgetRemaining")}</b> {Math.max(0, remainingPool - (Number.isFinite(parsedDayTokens) ? parsedDayTokens : 0)).toLocaleString()} tokens</span>
              </div>
              <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="owb-hire-advanced">
                <summary><ChevronDown aria-hidden="true" size={15} />{t("hire.structuredConfig")}<span>{t("hire.formOnly")}</span></summary>
                <div className="owb-hire-advanced__body">
                  <div className="owb-hire-section-head"><div><h4><Shield aria-hidden="true" size={15} />{t("hire.permissionsTitle")}</h4><p>{t("hire.permissionsHint")}</p></div></div>
                  <div className="owb-hire-tool-chips">{["Read", "Grep", "Glob", "Write", "Edit", "Delete", "Exec"].map((tool) => <button type="button" className={permissions.tools.includes(tool) ? "is-selected" : ""} key={tool} onClick={() => toggleTool(tool)}>{tool}</button>)}</div>
                  <div className="owb-hire-rules">{permissions.rules.map((rule, index) => <div className="owb-hire-rule" key={`${rule.scope}-${rule.resource}-${index}`}><Select value={rule.scope} onChange={(value) => setPermissions((current) => ({ ...current, rules: current.rules.map((item, itemIndex) => itemIndex === index ? { ...item, scope: value } : item) }))} options={[{ value: "position", label: t("hire.scopePosition") }, { value: "workspace", label: t("hire.scopeWorkspace") }, { value: "project", label: t("hire.scopeProject") }]} /><OwbInput value={rule.resource} onChange={(event) => setPermissions((current) => ({ ...current, rules: current.rules.map((item, itemIndex) => itemIndex === index ? { ...item, resource: event.target.value } : item) }))} /><div className="owb-hire-action-chips">{ACTIONS.map((action) => <button type="button" className={rule.actions.includes(action.value) ? "is-selected" : ""} key={action.value} onClick={() => setPermissions((current) => ({ ...current, rules: current.rules.map((item, itemIndex) => itemIndex === index ? toggleAction(item, action.value) : item) }))}>{t(action.labelKey)}</button>)}</div><button type="button" className="owb-hire-icon-button" aria-label={t("hire.removeRule")} onClick={() => setPermissions((current) => ({ ...current, rules: current.rules.filter((_item, itemIndex) => itemIndex !== index) }))}><Trash2 aria-hidden="true" size={14} /></button></div>)}<button type="button" className="owb-hire-add-rule" onClick={() => setPermissions((current) => ({ ...current, rules: [...current.rules, { scope: "workspace", resource: "./", actions: ["read"], approval: true }] }))}><Plus aria-hidden="true" size={14} />{t("hire.addRule")}</button></div>
                  <div className="owb-hire-section-head"><div><h4>{t("hire.memoryTitle")}</h4><p>{t("hire.memoryHint")}</p></div></div>
                  <div className="owb-hire-memory-chips">{MEMORY_OPTIONS.map((option) => <label key={option.kind} className={memorySources.some((source) => source.kind === option.kind) ? "is-selected" : ""}><Checkbox checked={memorySources.some((source) => source.kind === option.kind)} onChange={() => toggleMemory(option.kind)} />{t(option.labelKey)}</label>)}</div>
                  <div className="owb-hire-divider" />
                  <div className="owb-hire-two-col"><label><span>{t("hire.mode")}</span><Select value={mode} onChange={(value: HireDraft["mode"]) => setMode(value)} options={[{ value: "read_only", label: t("hire.modeReadOnly") }, { value: "approval_required", label: t("hire.modeApproval") }]} /></label></div>
                  <fieldset className="owb-hire-budget"><legend>{t("hire.budgetTitle")}</legend><div className="owb-hire-budget__bar"><span style={{ width: `${poolPercent}%` }} /><small>{t("hire.poolAllocated", { allocated: allocated.toLocaleString(), total: budgetPoolTokens.toLocaleString() })}</small></div><div className="owb-hire-two-col"><label><span>{t("hire.taskTokens")}</span><OwbInput value={taskTokens} inputMode="numeric" onChange={(event) => setTaskTokens(event.target.value)} /></label><label><span>{t("hire.dayTokens")}</span><OwbInput value={dayTokens} inputMode="numeric" onChange={(event) => setDayTokens(event.target.value)} /></label><label><span>{t("hire.taskIters")}</span><OwbInput value={taskIterations} inputMode="numeric" onChange={(event) => setTaskIterations(event.target.value)} placeholder={t("hire.optional")} /></label><label><span>{t("hire.dayIters")}</span><OwbInput value={dayIterations} inputMode="numeric" onChange={(event) => setDayIterations(event.target.value)} placeholder={t("hire.optional")} /></label></div>{parsedDayTokens > remainingPool ? <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{t("hire.budgetExceeded", { remaining: remainingPool.toLocaleString() })}</p> : parsedTaskTokens > parsedDayTokens ? <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{t("hire.taskBudgetExceeded")}</p> : null}</fieldset>
                </div>
              </details>
            </section>
            <CapabilityPicker permissions={permissions} onToggleSkill={toggleSkill} onToggleMcpServer={toggleMcpServer} onToggleMcpTool={toggleMcpTool} />
          </div>
        </div>
        <footer className="owb-modal__footer owb-hire-footer"><span>{t("hire.finalGate")}</span><AntButton onClick={onClose}>{t("dlg.cancel")}</AntButton><AntButton type="primary" disabled={!formValid} onClick={submit}>{t("hire.start")}</AntButton></footer>
      </div> : null}
      {(flow.phase === "submitting" || flow.phase === "approval") ? <div className="owb-hire-drawer"><Steps current={stepCurrent} items={[{ title: t("hire.stepSubmit") }, { title: t("hire.stepExec") }, { title: t("hire.stepReady") }]} /><div className="owb-hire-drawer__running"><LoaderCircle aria-hidden="true" className="owb-hire-drawer__spin" size={18} /><span aria-live="polite">{phaseCopy}</span></div><footer className="owb-modal__footer"><AntButton disabled title={t("hire.noCancelTitle")}>{t("hire.noCancel")}</AntButton></footer></div> : null}
      {flow.phase === "failed" ? <div className="owb-hire-drawer"><div className="owb-hire-drawer__failed"><XCircle aria-hidden="true" size={22} /><p>{t(FAILURE_COPY_KEYS[flow.code] ?? "hire.errDenied")}</p></div><footer className="owb-modal__footer"><AntButton onClick={() => dispatch({ type: "retry" })}>{t("hire.editRetry")}</AntButton><AntButton type="primary" disabled={!flow.retryable} onClick={retry}>{t("hire.retry")}</AntButton></footer></div> : null}
      {flow.phase === "succeeded" ? <div className="owb-hire-drawer"><div className="owb-hire-drawer__done"><CheckCircle2 aria-hidden="true" size={22} /><p>{t("hire.joined", { name: flow.draft.name })}</p></div></div> : null}
    </Drawer>
  );
}
