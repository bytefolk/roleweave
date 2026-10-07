/**
 * Conversational hire intake.
 *
 * The selected existing employee can propose semantics (role, duties and a
 * first policy draft). Separately, the operator binds one canonical Agent to
 * the new employee at creation time. The platform owns the deterministic
 * part: generated id, parent, token caps, permission shape and the final
 * POST /hire gate.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button as AntButton, Checkbox, Drawer, Input, Steps, message } from "antd";
import { CheckCircle2, ChevronDown, Code2, ListChecks, LoaderCircle, Palette, RotateCcw, Search, Sparkles, XCircle } from "lucide-react";
import { Input as OwbInput } from "@fullstack-ai-infra/ui";
import { useT, type OwbT } from "@roleweave/ui";
import { hireSkillCatalog } from "@roleweave/shared/capabilities";
import type { HireMemorySource, HirePermissions } from "@roleweave/shared";
import { AGENT_HOST_LABEL, AGENT_HOSTS, agentHostForEngine, resolveAgentEngine, type AgentHost } from "../turns/agent-host";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";
import { CapabilityPicker, PermissionPolicyEditor, replaceCapabilityRules } from "./PermissionsEditor";
import { createHireDraft, initialHireFlow, parseHireProposal, reduceHireFlow, toHirePositionRequest } from "./hire-flow";
import type { HireDraft } from "./hire-flow";
import { AVATAR_PRESETS, avatarSrcFor } from "../PositionAvatar";
import { HIRE_ROLE_PRESETS, type HireRolePreset, type HireRolePresetId } from "./hire-presets";
import "./hire-presets.css";

const MAX_POSITION_ID_LENGTH = 64;
const HIRE_STALL_TIMEOUT_MS = 60_000;
const AGENT_CONVERSATION_TIMEOUT_MS = 75_000;
const PLATFORM_BUDGET_POOL = 10_000_000;

const PHASE_COPY_KEYS: Record<string, string> = { validate: "hire.phaseValidate", stage: "hire.phaseStage", apply: "hire.phaseApply" };
const FAILURE_COPY_KEYS: Record<string, string> = { hire_position_exists: "hire.errExists", hire_timeout: "hire.errTimeout", control_plane_unreachable: "hire.errOffline", engine_unavailable: "hire.errCli", engine_capability_missing: "hire.errCapability", hire_mcp_unsupported: "hire.errMcpCapability" };
const MEMORY_OPTIONS: Array<{ kind: HireMemorySource["kind"]; labelKey: string; locator: string }> = [
  { kind: "position_docs", labelKey: "hire.memoryPositionDocs", locator: "./knowledge/**" },
  { kind: "workspace_docs", labelKey: "hire.memoryWorkspaceDocs", locator: "./**" },
  { kind: "mem_drive", labelKey: "hire.memorySharedDrive", locator: "mem://workspace" },
];

interface HireDrawerProps {
  open: boolean;
  workspacePath?: string;
  positions: Array<{ id: string; name: string }>;
  presetReportTo: string | null;
  /** Fallback while old callers finish moving to the selected person's host. */
  engine: TurnEngine;
  /** The selected manager's already-bound Agent, when it is known. */
  conversationEngine?: TurnEngine;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  conversationHostId: string | null;
  conversationHostName?: string;
  budgetPoolTokens?: number;
  budgetAllocatedTokens?: number;
  onClose: () => void;
  /** Explicit portrait selection travels with the successful local hire; an
   * omitted value deliberately means use the deterministic AI default. */
  onHired: (positionId: string, name: string, avatar?: string) => void;
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

function defaultBrief(t: OwbT): string {
  return t("hire.roleBriefDefault");
}

function HireChoiceSelect({ ariaLabel, value, options, onChange, t }: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  t: OwbT;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? value;
  return (
    <div className="owb-hire-choice-select">
      <button
        type="button"
        className="owb-hire-choice-select__trigger"
        aria-label={t("hire.choiceCurrent", { label: ariaLabel, value: selectedLabel })}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
      >
        <span>{selectedLabel}</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open ? <div className="owb-hire-choice-select__menu" role="listbox" aria-label={ariaLabel}>
        {options.map((option) => <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          className={option.value === value ? "is-selected" : undefined}
          onClick={() => { onChange(option.value); setOpen(false); }}
        >
          {option.label}
        </button>)}
      </div> : null}
    </div>
  );
}

export function HireDrawer({ open, workspacePath, positions, presetReportTo, engine, conversationEngine, engineAvailability, conversationHostId, conversationHostName, budgetPoolTokens = PLATFORM_BUDGET_POOL, budgetAllocatedTokens = 0, onClose, onHired }: HireDrawerProps) {
  const t = useT();
  const [flow, dispatch] = useReducer(reduceHireFlow, undefined, () => initialHireFlow());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState<string | undefined>();
  const [avatarGenerating, setAvatarGenerating] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [reportTo, setReportTo] = useState<string | null>(presetReportTo);
  const [mode, setMode] = useState<HireDraft["mode"]>("approval_required");
  const [agentHost, setAgentHost] = useState<AgentHost>(() => agentHostForEngine(conversationEngine ?? engine));
  const [taskTokens, setTaskTokens] = useState("20000");
  const [taskIterations, setTaskIterations] = useState("8");
  const [dayTokens, setDayTokens] = useState("200000");
  const [dayIterations, setDayIterations] = useState("64");
  const [prompt, setPrompt] = useState(() => defaultBrief(t));
  const [messages, setMessages] = useState<HireMessage[]>([]);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [designAssistOpen, setDesignAssistOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<HireRolePresetId | null>(null);
  const [appliedPreset, setAppliedPreset] = useState<{ id: HireRolePresetId; name: string; description: string } | null>(null);
  const [candidateProposal, setCandidateProposal] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<HirePermissions>({ tools: ["Read", "Grep", "Glob"], rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }], skills: [], mcpServers: [] });
  const [memorySources, setMemorySources] = useState<HireMemorySource[]>([{ kind: "position_docs", locator: "./knowledge/**" }]);
  const [phaseCopy, setPhaseCopy] = useState(t("hire.phaseSubmit"));
  const [messageApi, contextHolder] = message.useMessage();
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const conversationRequest = useRef(0);
  const conversationPending = useRef(false);
  const hireRequest = useRef(0);
  const hirePending = useRef(false);
  const avatarRequest = useRef(0);
  const workspaceScope = useMemo(() => Symbol("hire-workspace"), [workspacePath]);
  const currentWorkspaceScope = useRef(workspaceScope);
  currentWorkspaceScope.current = workspaceScope;
  const unsubscribe = useRef<(() => void) | null>(null);

  const clearTimers = useCallback(() => { if (stallTimer.current !== null) clearTimeout(stallTimer.current); stallTimer.current = null; unsubscribe.current?.(); unsubscribe.current = null; }, []);
  const opened = useRef<symbol | null>(null);
  useEffect(() => {
    if (!open) {
      opened.current = null;
      conversationRequest.current += 1;
      hireRequest.current += 1;
      hirePending.current = false;
      avatarRequest.current += 1;
      for (const timer of conversationTimers.current) clearTimeout(timer);
      conversationTimers.current.clear();
      setConversationBusy(false);
      conversationPending.current = false;
      clearTimers();
      return;
    }
    if (opened.current === workspaceScope) return;
    opened.current = workspaceScope;
    clearTimers();
    conversationRequest.current += 1;
    hireRequest.current += 1;
    hirePending.current = false;
    avatarRequest.current += 1;
    conversationPending.current = false;
    // Issued turns retain their originating workspace timeout even after
    // the form moves elsewhere; only their UI responses are invalidated.
    dispatch({ type: "reset", draft: createHireDraft() });
    setName(""); setDescription(""); setAvatar(undefined); setAvatarGenerating(false); setAvatarError(null); setReportTo(presetReportTo);
    setMode("approval_required"); setTaskTokens("20000"); setTaskIterations("8"); setDayTokens("200000"); setDayIterations("64");
    setAgentHost(agentHostForEngine(conversationEngine ?? engine));
    setPrompt(defaultBrief(t)); setMessages([]); setConversationBusy(false); setConversationError(null); setDesignAssistOpen(false); setAdvancedOpen(false);
    setSelectedPreset(null); setAppliedPreset(null); setCandidateProposal(null);
    setPermissions({ tools: ["Read", "Grep", "Glob"], rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }], skills: [], mcpServers: [] });
    setMemorySources([{ kind: "position_docs", locator: "./knowledge/**" }]); setPhaseCopy(t("hire.phaseSubmit"));
  }, [clearTimers, conversationEngine, engine, open, presetReportTo, t, workspaceScope]);
  useEffect(() => () => {
    conversationRequest.current += 1;
    hireRequest.current += 1;
    avatarRequest.current += 1;
    for (const timer of conversationTimers.current) clearTimeout(timer);
    conversationTimers.current.clear();
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  const armStallTimer = useCallback((targetId: string, isCurrentRequest: () => boolean) => {
    const timeout = () => {
      if (!isCurrentRequest()) return;
      // A stalled request is superseded by an explicit retry; its eventual
      // response must not settle the replacement operation.
      hireRequest.current += 1; hirePending.current = false; clearTimers();
      dispatch({ type: "fail", code: "hire_timeout", retryable: true });
    };
    if (stallTimer.current !== null) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(timeout, HIRE_STALL_TIMEOUT_MS);
    unsubscribe.current?.();
    unsubscribe.current = window.owb.onEvent((event) => {
      const envelope = event as { type?: string; payload?: { positionId?: string; phase?: string } };
      if (!isCurrentRequest()) return;
      if (envelope.type !== "hire.progress" || envelope.payload?.positionId !== targetId) return;
      const phase = envelope.payload.phase ?? "";
      setPhaseCopy((previous) => PHASE_COPY_KEYS[phase] !== undefined ? t(PHASE_COPY_KEYS[phase]) : previous);
      if (stallTimer.current !== null) clearTimeout(stallTimer.current);
      stallTimer.current = setTimeout(timeout, HIRE_STALL_TIMEOUT_MS);
    });
  }, [clearTimers, t]);

  const generatedId = useMemo(() => nextGeneratedId(name, positions), [name, positions]);
  const positionId = generatedId;
  const agentEngine = useMemo(() => resolveAgentEngine(agentHost, engineAvailability), [agentHost, engineAvailability]);
  const designEngine = conversationEngine ?? engine;
  const nameValid = name.trim().length > 0 && name.trim().length <= 24;
  const descriptionValid = description.trim().length > 0;
  const allocated = Math.max(0, budgetAllocatedTokens);
  const remainingPool = Math.max(0, budgetPoolTokens - allocated);
  const parsedTaskTokens = Number(taskTokens);
  const parsedDayTokens = Number(dayTokens);
  const capsValid = (value: string, required: boolean) => value.trim() === "" ? !required : Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 1_000_000_000;
  const budgetValid = capsValid(taskTokens, true) && capsValid(dayTokens, true) && capsValid(taskIterations, false) && capsValid(dayIterations, false) && parsedTaskTokens <= parsedDayTokens && parsedDayTokens <= remainingPool;
  const formValid = nameValid && descriptionValid && budgetValid && permissions.tools.length > 0;

  const buildDraft = useCallback((): HireDraft => createHireDraft({ id: positionId, name: name.trim(), description: description.trim(), reportTo: reportTo || null, mode, budget: { perTask: { tokens: Number(taskTokens), ...(taskIterations.trim() ? { iterations: Number(taskIterations) } : {}) }, perDay: { tokens: Number(dayTokens), ...(dayIterations.trim() ? { iterations: Number(dayIterations) } : {}) } }, permissions, prompt: prompt.trim(), memorySources, agentEngine }), [agentEngine, dayIterations, dayTokens, description, memorySources, mode, name, permissions, positionId, prompt, reportTo, taskIterations, taskTokens]);

  const applyPreset = (preset: HireRolePreset) => {
    const values = { id: preset.id, name: t(preset.nameKey).slice(0, 24), description: t(preset.descriptionKey).slice(0, 1_024) };
    setName(values.name); setDescription(values.description); setAppliedPreset(values);
  };
  const choosePreset = (preset: HireRolePreset) => {
    const untouched = (!name.trim() && !description.trim()) ||
      (appliedPreset !== null && name === appliedPreset.name && description === appliedPreset.description);
    setSelectedPreset(preset.id);
    if (untouched) applyPreset(preset);
  };
  const previewPreset = HIRE_ROLE_PRESETS.find((preset) => preset.id === selectedPreset);
  const presetMatchesDraft = !!appliedPreset && appliedPreset.id === selectedPreset && name === appliedPreset.name && description === appliedPreset.description;
  const parsedCandidate = useMemo(() => candidateProposal === null ? null : parseHireProposal(candidateProposal), [candidateProposal]);
  const candidateHasPolicy = !!parsedCandidate && !!(parsedCandidate.mode || parsedCandidate.tools || parsedCandidate.skills || parsedCandidate.mcpServers || parsedCandidate.memorySources);

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
    setSelectedPreset(null); setAppliedPreset(null);
    // A basic role proposal should keep the policy tables out of the main path.
    if (proposal.mode || proposal.tools || proposal.skills || proposal.mcpServers || proposal.memorySources) setAdvancedOpen(true);
  }, []);

  const askAgent = useCallback(async () => {
    const hostId = conversationHostId ?? positions[0]?.id ?? null;
    if (conversationPending.current || !hostId || !engineAvailability[designEngine]?.ready || prompt.trim().length === 0) return;
    conversationPending.current = true;
    const requestId = ++conversationRequest.current;
    const isCurrentRequest = () => requestId === conversationRequest.current && currentWorkspaceScope.current === workspaceScope;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setConversationBusy(true); setConversationError(null); setCandidateProposal(null);
    const input = `${t("hire.agentPromptTemplate")}\n${prompt.trim()}${t("hire.agentContext", { name: name.trim() || t("hire.proposalPendingName"), reportTo: reportTo ?? t("hire.ownerRoot") })}`;
    setMessages((current) => [...current, { role: "user", text: prompt.trim() }]);
    try {
      const response = await Promise.race([
        window.owb.createTurn({ positionId: hostId, engine: designEngine, input }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            void window.owb.cancelTurn(workspacePath ? { positionId: hostId, workspacePath } : hostId).catch(() => undefined);
            reject(new Error("agent conversation timed out"));
          }, AGENT_CONVERSATION_TIMEOUT_MS);
          conversationTimers.current.add(timer);
        }),
      ]);
      if (!isCurrentRequest()) return;
      if (response.status !== 200) { setConversationError(t("hire.agentConversationFail")); return; }
      const output = proposalText(response.body);
      if (!output) { setConversationError(t("hire.agentNoProposal")); return; }
      const proposal = parseHireProposal(output);
      if (Object.keys(proposal).length === 0) { setConversationError(t("hire.agentNoProposal")); return; }
      const summary = [proposal.name, proposal.description].filter(Boolean).join("\n\n") || t("hire.generatedPolicyHint");
      setMessages((current) => [...current, { role: "assistant", text: summary }]);
      setCandidateProposal(output);
    } catch {
      if (!isCurrentRequest()) return;
      setConversationError(timedOut ? t("hire.agentConversationTimeout") : t("hire.agentConversationOffline"));
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (timer !== null) conversationTimers.current.delete(timer);
      if (isCurrentRequest()) { conversationPending.current = false; setConversationBusy(false); }
    }
  }, [conversationHostId, designEngine, engineAvailability, name, positions, prompt, reportTo, t, workspacePath, workspaceScope]);

  const submitRequest = useCallback(async (draft: HireDraft) => {
    if (hirePending.current) return;
    hirePending.current = true;
    const requestId = ++hireRequest.current;
    const isCurrentRequest = () => requestId === hireRequest.current && currentWorkspaceScope.current === workspaceScope;
    dispatch({ type: "edit", draft }); dispatch({ type: "submit" }); setPhaseCopy(t("hire.phaseSubmit")); armStallTimer(draft.id, isCurrentRequest);
    try {
      const response = await window.owb.hire(toHirePositionRequest(draft));
      if (!isCurrentRequest()) return;
      clearTimers();
      if (response.status === 200 && response.body.status === "hired") { dispatch({ type: "succeed", positionId: draft.id }); messageApi.success(t("hire.joined", { name: draft.name })); onHired(draft.id, draft.name, avatar); onClose(); return; }
      const body = response.body as { code?: string; retryable?: boolean }; dispatch({ type: "fail", code: body.code ?? "hire_failed", retryable: body.retryable ?? false });
    } catch { if (isCurrentRequest()) { clearTimers(); dispatch({ type: "fail", code: "control_plane_unreachable", retryable: true }); } }
    finally { if (isCurrentRequest()) hirePending.current = false; }
  }, [armStallTimer, avatar, clearTimers, messageApi, onClose, onHired, t, workspaceScope]);
  const submit = useCallback(() => { if (formValid) void submitRequest(buildDraft()); }, [buildDraft, formValid, submitRequest]);
  const retry = useCallback(() => { if (flow.phase === "failed" && flow.retryable) { dispatch({ type: "retry" }); void submitRequest(flow.draft); } }, [flow, submitRequest]);
  const stepCurrent = flow.phase === "draft" ? 0 : flow.phase === "succeeded" ? 2 : 1;
  const poolPercent = budgetPoolTokens > 0 ? Math.min(100, (allocated / budgetPoolTokens) * 100) : 100;
  const toggleMemory = (kind: HireMemorySource["kind"]) => setMemorySources((current) => { if (current.some((source) => source.kind === kind)) return current.filter((source) => source.kind !== kind); const option = MEMORY_OPTIONS.find((item) => item.kind === kind)!; return [...current, { kind, locator: option.locator }]; });
  const chooseAvatarFile = (file: File | undefined) => {
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 512 * 1024) {
      if (file) void messageApi.warning(t("avatar.fileWarning"));
      return;
    }
    const requestId = ++avatarRequest.current;
    setAvatarGenerating(false); setAvatarError(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (requestId === avatarRequest.current && currentWorkspaceScope.current === workspaceScope && typeof reader.result === "string") setAvatar(reader.result);
    };
    reader.readAsDataURL(file);
  };
  const generateAvatar = useCallback(async () => {
    const brief = [name.trim(), description.trim()].filter(Boolean).join(" · ");
    if (brief.length < 2) {
      void messageApi.warning(t("avatar.missingBrief"));
      return;
    }
    const requestId = ++avatarRequest.current;
    const isCurrentRequest = () => requestId === avatarRequest.current && currentWorkspaceScope.current === workspaceScope;
    setAvatarGenerating(true);
    setAvatarError(null);
    try {
      const response = await window.owb.generateAvatar({ brief });
      if (!isCurrentRequest()) return;
      const imageDataUrl = (response.body as { imageDataUrl?: unknown })?.imageDataUrl;
      if (response.status !== 200 || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/png;base64,")) {
        throw new Error("avatar generation failed");
      }
      setAvatar(imageDataUrl);
      void messageApi.success(t("avatar.generated"));
    } catch {
      if (isCurrentRequest()) setAvatarError(t("avatar.generationFailed"));
    } finally {
      if (isCurrentRequest()) setAvatarGenerating(false);
    }
  }, [description, messageApi, name, t, workspaceScope]);

  const chooseAvatar = (value: string | undefined) => {
    avatarRequest.current += 1;
    setAvatar(value); setAvatarGenerating(false); setAvatarError(null);
  };

  return (
    <Drawer className="owb-hire-drawer-shell owb-hire-drawer-shell--create" title={t("hire.createTitle")} width="min(720px, calc(100vw - 24px))" open={open} closable={false} onClose={() => { if (flow.phase !== "draft" && flow.phase !== "failed") return; clearTimers(); onClose(); }} destroyOnHidden>
      {contextHolder}
      {flow.phase === "draft" ? <div className="owb-hire-shell">
        <div className="owb-hire-shell__scroll">
          <div className="owb-hire-drawer owb-hire-drawer--conversation">
            <div className="owb-hire-design-section">
            <section className="owb-hire-selection" aria-label={t("hire.presetsLabel")}>
              <div className="owb-hire-selection__intro"><h3>{t("hire.selectionTitle")}</h3><p>{t("hire.selectionDescription")}</p></div>
              <div className="owb-hire-preset-grid" role="group" aria-label={t("hire.presetsLabel")}>
                {HIRE_ROLE_PRESETS.map((preset) => {
                  const Icon = { engineer: Code2, designer: Palette, qa: ListChecks, research: Search }[preset.id];
                  return <button type="button" className="owb-hire-preset" key={preset.id} aria-pressed={selectedPreset === preset.id}
                    aria-label={`${t(preset.nameKey)} · ${t("hire.presetBadge")}`} onClick={() => choosePreset(preset)}>
                    <span className="owb-hire-preset__icon" aria-hidden="true"><Icon size={17} /></span>
                    <span className="owb-hire-preset__copy"><span className="owb-hire-preset__name"><strong>{t(preset.nameKey)}</strong><span className="owb-hire-preset__badge">{t("hire.presetBadge")}</span></span><small>{t(preset.summaryKey)}</small></span>
                  </button>;
                })}
              </div>
              {previewPreset && !presetMatchesDraft ? <div className="owb-hire-preset-preview" aria-label={t("hire.presetPreview")}>
                <strong>{t(previewPreset.nameKey)}</strong><p>{t(previewPreset.descriptionKey)}</p><small>{t("hire.presetReplaceHint")}</small>
                <AntButton onClick={() => applyPreset(previewPreset)}>{t("hire.presetApply")}</AntButton>
              </div> : presetMatchesDraft ? <p className="owb-hire-preset-feedback" role="status">{t("hire.presetApplied")}</p> : null}
              <div className="owb-hire-generator-entry"><div><strong>{t("hire.generateEntry")}</strong><p>{t("hire.generateEntryHint")}</p></div>
                <AntButton icon={<Sparkles size={14} aria-hidden="true" />} onClick={() => setDesignAssistOpen(true)}>{t("hire.generateOpen")}</AntButton>
              </div>
            </section>
            <section className="owb-hire-agent-picker">
              <div>
                <p className="owb-hire-eyebrow">{t("hire.agentStep")}</p>
                <h3>{t("hire.agentTitle")}</h3>
                <p>{t("hire.agentDescription")}</p>
              </div>
              <div className="owb-hire-agent-binding">
                <span>{t("hire.agentBinding")}</span>
                <HireChoiceSelect
                  ariaLabel={t("hire.agentBinding")}
                  value={agentHost}
                  options={AGENT_HOSTS.map((host) => ({ value: host, label: AGENT_HOST_LABEL[host] }))}
                  onChange={(value) => setAgentHost(value as AgentHost)}
                  t={t}
                />
                <small>{t("hire.agentBindingHint")}</small>
              </div>
            </section>
            <details className="owb-hire-assist" open={designAssistOpen} onToggle={(event) => setDesignAssistOpen(event.currentTarget.open)}>
              <summary><Sparkles aria-hidden="true" size={15} />{t("hire.assistTitle")}<span>{t("hire.assistHint")}</span></summary>
              <section className="owb-hire-conversation" aria-label={t("hire.agentConversationAria")}><div className="owb-hire-conversation__meta"><span className="owb-hire-conversation__host"><span className="owb-led owb-led--running" />{conversationHostName ?? t("hire.agentWorkspaceContext")}</span><span>{t("hire.agentNoWrite")}</span></div>{messages.length === 0 ? <div className="owb-hire-conversation__empty"><Sparkles aria-hidden="true" size={20} /><span>{t("hire.agentEmpty")}</span></div> : <div className="owb-hire-conversation__messages">{messages.map((entry, index) => <div className={`owb-hire-message is-${entry.role}`} key={`${entry.role}-${index}`}><span>{entry.role === "user" ? t("hire.you") : t("hire.agent")}</span><p>{entry.text}</p></div>)}</div>}<div className="owb-hire-prompt"><div className="owb-hire-prompt__heading"><label htmlFor="owb-hire-prompt-input">{t("hire.promptLabel")}</label><button type="button" onClick={() => setPrompt(defaultBrief(t))}><RotateCcw aria-hidden="true" size={12} /><span>{t("hire.resetPrompt")}</span></button></div><Input.TextArea id="owb-hire-prompt-input" value={prompt} rows={4} onChange={(event) => setPrompt(event.target.value)} placeholder={t("hire.promptPh")} /><div className="owb-hire-prompt__footer"><span>{t("hire.promptEditable")}</span><AntButton type="primary" loading={conversationBusy} disabled={!engineAvailability[designEngine]?.ready || (!conversationHostId && positions.length === 0) || prompt.trim().length === 0} onClick={() => void askAgent()} icon={<Sparkles aria-hidden="true" size={14} />}>{conversationBusy ? t("hire.askingAgent") : t("hire.askAgent")}</AntButton></div>{conversationError ? <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{conversationError}</p> : null}</div></section>
            </details>
            {candidateProposal && parsedCandidate ? <section className="owb-hire-generated-preview" aria-label={t("hire.generatedProposalTitle")}>
              <strong>{t("hire.generatedProposalTitle")}</strong><p>{parsedCandidate.name ?? t("hire.proposalPendingName")}</p>
              {parsedCandidate.description ? <p>{parsedCandidate.description}</p> : null}<small>{t("hire.generatedProposalHint")}</small>
              {candidateHasPolicy ? <small>{t("hire.generatedPolicyHint")}</small> : null}
              <AntButton onClick={() => { applyProposal(candidateProposal); setCandidateProposal(null); }}>{t("hire.generatedProposalApply")}</AntButton>
            </section> : null}
            </div>
            <section className="owb-hire-draft-card">
              <div className="owb-hire-draft-card__heading">
                <div><p className="owb-hire-eyebrow">{t("hire.basicStep")}</p><h3>{t("hire.basicTitle")}</h3><p className="owb-hire-basic-description">{t("hire.basicDescription")}</p></div>
                <span className="owb-hire-draft-card__status">{name ? t("hire.basicReady") : t("hire.basicWaiting")}</span>
              </div>
              <div className="owb-hire-basic-grid">
                <label><span>{t("hire.name")}</span><OwbInput value={name} maxLength={24} onChange={(event) => setName(event.target.value)} placeholder={t("hire.namePh")} /></label>
                <label><span>{t("hire.reportTo")}</span><HireChoiceSelect t={t} ariaLabel={t("hire.reportTo")} value={reportTo ?? ""} onChange={(value) => setReportTo(value === "" ? null : value)} options={[{ value: "", label: t("hire.ownerRoot") }, ...positions.map((position) => ({ value: position.id, label: t("hire.reportOption", { name: position.name }) }))]} /></label>
                <label className="owb-hire-basic-grid__wide"><span>{t("hire.desc")}</span><Input.TextArea value={description} maxLength={1_024} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event) => setDescription(event.target.value)} placeholder={t("hire.descPh")} /></label>
              </div>
              <div className="owb-hire-summary-row">
                <span>{t("hire.idAutoNote")}</span>
                <span><b>{t("hire.budgetRemaining")}</b> {Math.max(0, remainingPool - (Number.isFinite(parsedDayTokens) ? parsedDayTokens : 0)).toLocaleString()} tokens</span>
              </div>
              <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="owb-hire-advanced">
                <summary><ChevronDown aria-hidden="true" size={15} />{t("hire.advancedTitle")}<span>{t("hire.advancedHint")}</span></summary>
                <div className="owb-hire-advanced__body">
                  <section className="owb-hire-avatar-picker" aria-label={t("avatar.title")}>
                    <div><strong>{t("avatar.title")}</strong><p>{t("avatar.description")}</p>{avatarError ? <p className="owb-hire-avatar-picker__error">{avatarError}</p> : null}</div>
                    <div className="owb-hire-avatar-picker__choices">
                      <button type="button" className={avatar === undefined ? "is-selected" : ""} onClick={() => chooseAvatar(undefined)} aria-label={t("avatar.autoAria")}><img src={avatarSrcFor(positionId)} alt="" /><span>{t("avatar.auto")}</span></button>
                      <button type="button" className="owb-hire-avatar-picker__generate" onClick={() => void generateAvatar()} disabled={avatarGenerating} aria-label={t("avatar.generateAria")}><Sparkles aria-hidden="true" size={15} /><span>{avatarGenerating ? t("avatar.generating") : "AI"}</span></button>
                      {AVATAR_PRESETS.map((preset) => <button type="button" className={avatar === preset.id ? "is-selected" : ""} key={preset.id} onClick={() => chooseAvatar(preset.id)} aria-label={t("avatar.selectPreset", { name: t(preset.labelKey) })}><img src={preset.src} alt="" /></button>)}
                      <label className="owb-hire-avatar-picker__upload"><span>{t("avatar.upload")}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseAvatarFile(event.target.files?.[0])} /></label>
                    </div>
                  </section>
                  <PermissionPolicyEditor permissions={permissions} onChange={setPermissions} />
                  <div className="owb-hire-section-head"><div><h4>{t("hire.memoryTitle")}</h4><p>{t("hire.memoryHint")}</p></div></div>
                  <div className="owb-hire-memory-chips">{MEMORY_OPTIONS.map((option) => <label key={option.kind} className={memorySources.some((source) => source.kind === option.kind) ? "is-selected" : ""}><Checkbox checked={memorySources.some((source) => source.kind === option.kind)} onChange={() => toggleMemory(option.kind)} />{t(option.labelKey)}</label>)}</div>
                  <div className="owb-hire-divider" />
                  <div className="owb-hire-two-col"><label><span>{t("hire.mode")}</span><HireChoiceSelect t={t} ariaLabel={t("hire.mode")} value={mode} onChange={(value) => setMode(value as HireDraft["mode"])} options={[{ value: "read_only", label: t("hire.modeReadOnly") }, { value: "approval_required", label: t("hire.modeApproval") }]} /></label></div>
                  <fieldset className="owb-hire-budget"><legend>{t("hire.budgetTitle")}</legend><div className="owb-hire-budget__bar"><span style={{ width: `${poolPercent}%` }} /><small>{t("hire.poolAllocated", { allocated: allocated.toLocaleString(), total: budgetPoolTokens.toLocaleString() })}</small></div><div className="owb-hire-two-col"><label><span>{t("hire.taskTokens")}</span><OwbInput value={taskTokens} inputMode="numeric" onChange={(event) => setTaskTokens(event.target.value)} /></label><label><span>{t("hire.dayTokens")}</span><OwbInput value={dayTokens} inputMode="numeric" onChange={(event) => setDayTokens(event.target.value)} /></label><label><span>{t("hire.taskIters")}</span><OwbInput value={taskIterations} inputMode="numeric" onChange={(event) => setTaskIterations(event.target.value)} placeholder={t("hire.optional")} /></label><label><span>{t("hire.dayIters")}</span><OwbInput value={dayIterations} inputMode="numeric" onChange={(event) => setDayIterations(event.target.value)} placeholder={t("hire.optional")} /></label></div>{parsedDayTokens > remainingPool ? <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{t("hire.budgetExceeded", { remaining: remainingPool.toLocaleString() })}</p> : parsedTaskTokens > parsedDayTokens ? <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{t("hire.taskBudgetExceeded")}</p> : null}</fieldset>
                  <CapabilityPicker permissions={permissions} onChange={setPermissions} />
                </div>
              </details>
            </section>
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
