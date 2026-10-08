import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, ChevronRight, CircleCheck, CircleX, FileCode2, LoaderCircle, MessagesSquare, RotateCcw, ShieldAlert, ShieldQuestion, Terminal, Wrench } from "lucide-react";
import { Markdown, markdownToPlainText } from "../markdown/Markdown";
import { useConversationCopy } from "../locales/conversation";
import { activityAction, useActivityCopy } from "../locales/activity";
import { visibleTrail } from "./trail";
import "./activity-trace.css";
import type { ConversationViewport } from "./conversation-memory";
import { MessageActions, OperatorMessage } from "./message-actions";
import { TurnNoteAction } from "./TurnNoteAction";
import { EmptyState, useT } from "@roleweave/ui";
import { Select } from "@fullstack-ai-infra/ui";
import { useEngineLabel } from "./engine-select";
import { EngineIcon } from "./engine-icon";
import type { TurnRecord } from "./types";
import { DiffViewer } from "../approvals/DiffViewer";
import { Tooltip } from "antd";

export interface TurnThreadProps {
  turns: TurnRecord[];
  loading?: boolean;
  onEdit?: (text: string) => void;
  viewportMemory?: Map<string, ConversationViewport>;
  retrying?: boolean;
  /** #128 AC-002: when no turns exist, the empty-state heading is driven by
   * the caller so it can name the concrete prerequisite (e.g. "先从组织树
   * 或 @ 选择器选择岗位") rather than a generic "start from a clear task"
   * that contradicts the disabled composer hint below. */
  emptyPrompt?: string;
  emptyDescription?: string;
  canRetry?: (turn: TurnRecord) => boolean;
  onRetry?: (turn: TurnRecord) => void;
  /** Operator verdict for a turn settled as engine.approval_required. */
  onVerdict?: (turn: TurnRecord, decision: "granted" | "denied", reason?: string, scope?: "once" | "run") => void;
  /** Approval ids whose verdict was already dispatched; their cards settle
   * into a decided state so the operator cannot submit duplicate or
   * contradictory verdicts after a history reload. */
  decidedApprovalIds?: ReadonlySet<string>;
  /** #234: stable key (positionId:sessionId) so the thread can save and
   * restore the scroll viewport when the operator switches employees. */
  scrollKey?: string;
  /** Deep linking anchor to focus and scroll to a specific turn. */
  focusTurnId?: string | null;
  /** Opens an indexed workspace file from a turn output or execution trace. */
  onOpenResource?: (positionId: string, path: string) => void;
}

function elapsedSeconds(start: string, end: string | number | undefined): number | null {
  const from = Date.parse(start);
  const to = typeof end === "number" ? end : end ? Date.parse(end) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.floor((to - from) / 1000)
    : null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function ActivityStatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "running") return <LoaderCircle size={12} className="owb-turn-progress__spinner" aria-hidden="true" />;
  if (status === "failed") return <CircleX size={12} aria-hidden="true" />;
  return <CircleCheck size={12} aria-hidden="true" />;
}

type ActivityParameterKey = "pattern" | "files" | "offset" | "limit" | "path";

function activityParameters(detail: string): { key?: ActivityParameterKey; value: string }[] {
  return detail.split(/\s+·\s+|\r?\n/).map(segment => {
    const text = segment.trim();
    const labeled = /^(pattern|files|offset|limit|path|file_path):\s*(.*)$/i.exec(text);
    if (labeled) return { key: (labeled[1]!.toLowerCase() === "file_path" ? "path" : labeled[1]!.toLowerCase()) as ActivityParameterKey, value: labeled[2]! };
    // Legacy events carry bare paths. Keep every character, including a POSIX
    // leading slash or Windows drive, rather than Markdown-autolinking part of it.
    if (/[*?]/.test(text)) return { key: "pattern" as const, value: text };
    if (/[\\/]/.test(text) || /\.[a-z0-9]{1,10}$/i.test(text)) return { key: "path" as const, value: text };
    return { value: text };
  }).filter(segment => segment.value !== "");
}

function ActivityParameters({ detail, positionId, onOpenResource }: { detail: string; positionId: string; onOpenResource?: TurnThreadProps["onOpenResource"] }) {
  const copy = useActivityCopy();
  return <div className="owb-activity-trace__parameters">
    {activityParameters(detail).map(({ key, value }, index) => {
      const file = key === "path" && !/[*?]/.test(value) && /\.[a-z0-9]{1,10}$/i.test(value);
      return <div key={index} className="owb-activity-trace__parameter">
        {key ? <span className="owb-activity-trace__parameter-key">{copy[key]}: </span> : null}
        {file && onOpenResource ? <a className="owb-activity-trace__resource" href="#"
          aria-label={`${copy.resourceLink}${value}`} title={value}
          onClick={event => { event.preventDefault(); onOpenResource(positionId, value); }}>
          <span className="owb-activity-trace__resource-icon" data-link-icon="code"><FileCode2 size={12} aria-hidden="true" /></span>
          <code>{value}</code>
        </a> : <code className="owb-activity-trace__parameter-value">{value}</code>}
      </div>;
    })}
  </div>;
}

function ActivityDetails({ detail, positionId, onOpenResource }: { detail: string; positionId: string; onOpenResource?: TurnThreadProps["onOpenResource"] }) {
  const copy = useActivityCopy();
  const [expanded, setExpanded] = useState(false);
  if (detail.length <= 140 && !detail.includes("\n")) {
    return <div title={detail}><ActivityParameters detail={detail} positionId={positionId} onOpenResource={onOpenResource} /></div>;
  }
  const fullPreview = activityParameters(detail).map(({ key, value }) => `${key ? `${copy[key]}: ` : ""}${value}`).join(" · ");
  const preview = fullPreview.length > 100 ? `${fullPreview.slice(0, 100)}…` : fullPreview;
  return <details className="owb-activity-trace__details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary title={detail}><span className="owb-activity-trace__detail-preview">{preview}</span> <span className="owb-activity-trace__detail-hint">{expanded ? copy.collapseDetails : copy.details}</span></summary>
    <div className="owb-activity-trace__detail-body"><ActivityParameters detail={detail} positionId={positionId} onOpenResource={onOpenResource} /></div>
  </details>;
}

/** Live clock while executing; a settled turn freezes its duration. A missing
 * terminal timestamp stays absent instead of borrowing today's clock. */
function ElapsedTime({ turn, now }: { turn: TurnRecord; now: number }) {
  const t = useT();
  const running = turn.status === "running";
  const seconds = elapsedSeconds(turn.createdAt, running ? now : turn.completedAt);
  if (seconds === null) return null;
  const text = running ? `· ${formatElapsed(seconds)}` : t("turn.duration", { seconds });
  return <time className="owb-turn-progress__elapsed" dateTime={`PT${seconds}S`}
    role="timer" aria-live="off" aria-label={text}>{text}</time>;
}

/** One collapsible activity line per turn, mirroring the Qoder client: while
 * running it names the live tool (or the generic running copy) and stays
 * expanded; once settled it folds into its tool-count summary and collapses,
 * keeping any explicit disclosure choice made for that phase. */
export function ProgressTrail({ turn, approvalDecided = false, onOpenResource }: { turn: TurnRecord; approvalDecided?: boolean; onOpenResource?: TurnThreadProps["onOpenResource"] }) {
  const t = useT();
  const copy = useConversationCopy();
  const activityCopy = useActivityCopy();
  const bodyId = useId();
  // The trail is chronological: thought items (the model's narration between
  // two tool calls) interleave with tool/agent activities.
  const trail = turn.trace ?? [];
  const displayedTrail = visibleTrail(trail, turn.output);
  const tools = trail.filter((item) => item.kind === "tool");
  const runningActivity = trail.find((item) => item.status === "running" && item.kind !== "thought");
  // A running thought is always the trail tail — an arriving step closes the
  // open narration before it lands — so when a tool and a thought are both
  // live, the thought is the newest element and names the fold title below;
  // the still-running tool stays visible in the body.
  const runningThought = trail.find((item) => item.status === "running" && item.kind === "thought");
  const awaitingApproval = turn.approvalRequest !== undefined;
  const running = turn.status === "running" && !awaitingApproval;
  const failedTools = tools.filter((item) => item.status === "failed").length;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running, turn.createdAt]);
  const phase = `${turn.id}:${turn.status}:${approvalDecided}`;
  const [choice, setChoice] = useState<{ phase: string; open: boolean } | null>(null);
  const open = choice?.phase === phase ? choice.open : running;
  const state = awaitingApproval ? (approvalDecided ? "decided" : "awaiting_approval") : turn.status;
  const label = awaitingApproval
    ? t(approvalDecided ? "apr.decided" : "turn.progressAwaitingApproval")
    : turn.errorCode === "turn_cancelled"
      ? copy.cancelled
      : running
        ? open
          ? t("turn.activityRunningExpanded")
          : runningThought
            ? t("turn.thoughtRunning")
            : runningActivity
              ? t("turn.activityRunningTool", { tool: activityAction(runningActivity.title, activityCopy) })
              : t("turn.activityRunning")
        : turn.status === "failed"
          ? t("turn.failed")
          : turn.status === "indeterminate"
            ? t("turn.statusUnknown")
            : tools.length === 0
              ? t("turn.activityProcessed")
              : failedTools > 0
                ? t("turn.toolsExecutedWithFailures", { count: tools.length, failedCount: failedTools })
                : t("turn.toolsExecuted", { count: tools.length });
  const thinking = running && !runningActivity && !runningThought;
  const hasBody = displayedTrail.length > 0 || thinking;
  return (
    <div className={`owb-turn-progress is-${state}`} role="group" aria-label={t("turn.progressAria")}
      data-motion={running ? "live" : undefined}>
      <div className="owb-turn-progress__summary">
        {hasBody ? (
          <button type="button" className="owb-turn-progress__header"
            aria-label={`${t("turn.progressDetails")} · ${label}`} aria-expanded={open} aria-controls={bodyId}
            onClick={() => setChoice({ phase, open: !open })}>
            <span className="owb-turn-progress__toggle"><ChevronRight className="owb-turn-progress__chevron" aria-hidden="true" size={11} /></span>
            {running ? (
              <span className="owb-turn-progress__activity" aria-hidden="true">
                <span className="owb-turn-progress__activity-orbit" />
                <LoaderCircle className="owb-turn-progress__spinner" size={12} />
              </span>
            ) : null}
            <span className="owb-turn-progress__title">{label}</span>
          </button>
        ) : (
          <span className="owb-turn-progress__title">{label}</span>
        )}
        <ElapsedTime turn={turn} now={now} />
      </div>
      {hasBody ? (
        <div id={bodyId} className="owb-activity-trace__group">
          <ol className="owb-activity-trace__list" hidden={!open}>
            {displayedTrail.map((item) => {
              if (item.kind === "thought") {
                return (
                  <li key={item.activityId} className={`owb-activity-trace__item is-thought is-${item.status}`}>
                    <span className="owb-activity-trace__icon"><ActivityStatusIcon status={item.status} /></span>
                    <span className="owb-activity-trace__label">
                      {item.status === "running" ? t("turn.thoughtRunning") : activityCopy.narration}
                      {item.text ? <span className="owb-activity-trace__thought" title={item.text}> · {item.text}</span> : null}
                    </span>
                  </li>
                );
              }
              if (item.kind === "agent") {
                return (
                  <li key={item.activityId} className={`owb-activity-trace__agent is-${item.status}`}>
                    <Bot size={14} aria-hidden="true" /><span>{item.title}{item.detail ? ` · ${item.detail}` : ""}</span>
                  </li>
                );
              }
              return (
                <li key={item.activityId} className={`owb-activity-trace__item is-tool is-${item.status}`}>
                  <span className="owb-activity-trace__icon">
                    {/terminal|bash/i.test(item.title ?? "") ? <Terminal size={13} aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />}
                  </span>
                  <div className="owb-activity-trace__label">
                    <div className="owb-activity-trace__action">
                      <strong>{activityAction(item.title, activityCopy)}</strong>
                      {item.title ? <span className="owb-activity-trace__tool-name">{item.title}</span> : null}
                      <span className="owb-activity-trace__state">{item.status === "running" ? activityCopy.running : item.status === "failed" ? activityCopy.failed : activityCopy.completed}</span>
                    </div>
                    {item.detail ? <ActivityDetails detail={item.detail} positionId={turn.positionId} onOpenResource={onOpenResource} /> :
                      <span className="owb-activity-trace__parameters">{activityCopy.missingDetails}</span>}
                  </div>
                  <span className={`owb-activity-trace__status is-${item.status}`}><ActivityStatusIcon status={item.status} /></span>
                </li>
              );
            })}
            {thinking ? (
              <li className="owb-activity-trace__continuing" aria-current="step">
                <LoaderCircle size={13} aria-hidden="true" />{t("turn.continueReasoning")}
              </li>
            ) : null}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** Approval verdict card (#187 Option 1, spec ③): embedded inside the
 * employee bubble; the verdict always starts a new sealed-envelope resume
 * turn — there is no in-run channel by contract. */
function ApprovalCard({
  turn,
  busy,
  decided,
  onVerdict,
}: {
  turn: TurnRecord;
  busy: boolean;
  decided: boolean;
  onVerdict: (turn: TurnRecord, decision: "granted" | "denied", reason?: string, scope?: "once" | "run") => void;
}) {
  const t = useT();
  const kindCopy: Record<string, string> = {
    exec: t("apr.kind.exec"),
    write: t("apr.kind.write"),
    network: t("apr.kind.network"),
    tool: t("apr.kind.tool"),
  };
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"once" | "run">("once");
  const request = turn.approvalRequest;
  if (request === undefined) return null;
  const trimmedReason = reason.trim();
  const isExpired = turn.approvalControl?.status === "expired";
  const disabled = busy || turn.approvalControl?.disabled === true || isExpired || new TextEncoder().encode(trimmedReason).length > 1024;
  return (
    <div className={`owb-turn__approval${decided || isExpired ? " is-decided" : ""}`} role="group" aria-label={t("apr.request")}>
      <p className="owb-turn__approval-title">
        <ShieldAlert aria-hidden="true" size={13} />
        {turn.approvalControl?.status ? t(`apr.status.${turn.approvalControl.status}`) : decided ? t("apr.decided") : t("apr.pending")} · {kindCopy[request.kind] ?? request.kind}
      </p>
      <p className="owb-turn__approval-description" title={request.description}>
        {request.description}
      </p>
      {request.target ? (
        <p className="owb-turn__approval-target" title={request.target}>{request.target}</p>
      ) : null}
      {request.expiresAt ? (
        <p className="owb-turn__approval-expires">{t("apr.expiresAt", { date: new Date(request.expiresAt).toLocaleString() })}</p>
      ) : null}
      {request.preview || request.requestReason || request.context ? (
        <details className="owb-turn__approval-preview" data-testid="in-thread-approval-preview">
          <summary style={{ fontSize: 11, cursor: "pointer", color: "var(--ui-accent, #1677ff)", margin: "4px 0" }}>
            {t("apr.inThreadPreview")}
          </summary>
          <div style={{ padding: "6px 8px", background: "rgba(0,0,0,0.03)", borderRadius: 4, margin: "4px 0", fontSize: 11 }}>
            {request.context?.risk ? (
              <p style={{ margin: "0 0 4px" }}>
                <strong>{t("apr.inThreadRisk", { risk: t(`apr.risk.${request.context.risk}`) })}</strong>
              </p>
            ) : null}
            {request.requestReason ? (
              <p style={{ margin: "0 0 4px" }}>
                <em>{request.requestReason}</em>
              </p>
            ) : null}
            {request.preview?.files && request.preview.files.length > 0 ? (
              <div>
                <p style={{ margin: "0 0 2px" }}>
                  <strong>{t("apr.inThreadFiles", { count: request.preview.files.length })}</strong>
                </p>
                <div style={{ display: "grid", gap: 4 }}>
                  {request.preview.files.map((f) => (
                    <details key={`${f.change}:${f.path}`} style={{ border: "1px solid var(--ui-border, #e8e8e8)", borderRadius: 4, padding: "2px 6px" }}>
                      <summary style={{ cursor: "pointer" }}>
                        <code>[{f.change}] {f.path}</code>
                      </summary>
                      {f.before !== undefined || f.after !== undefined ? (
                        <DiffViewer before={f.before} after={f.after} change={f.change} />
                      ) : null}
                    </details>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {decided ? (
        <p className="owb-turn__approval-decided">{t("apr.decidedNote")}</p>
      ) : isExpired ? (
        <p className="owb-turn__approval-decided">{t("apr.alertExpired")}</p>
      ) : (
        <>
          <input
            className="owb-turn__approval-reason"
            aria-label={t("apr.reasonOptional")}
            placeholder={t("apr.reasonOptional")}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="owb-turn__approval-actions">
            {request.scopeAllowed?.includes("run") ? <Select<"once" | "run">
              aria-label={t("apr.scopeTitle")}
              className="owb-turn__approval-scope"
              size="small"
              value={scope}
              disabled={disabled}
              options={[{ value: "once", label: t("apr.scope.once") }, { value: "run", label: t("apr.scope.run") }]}
              onChange={setScope}
            /> : null}
            <button
              type="button"
              className="owb-turn__approval-grant"
              disabled={disabled}
              onClick={() => scope === "run"
                ? onVerdict(turn, "granted", trimmedReason || undefined, scope)
                : trimmedReason ? onVerdict(turn, "granted", trimmedReason) : onVerdict(turn, "granted")}
            >
              {t("apr.grant")}
            </button>
            <button
              type="button"
              className="owb-turn__approval-deny"
              disabled={disabled}
              onClick={() => onVerdict(turn, "denied", trimmedReason.length > 0 ? trimmedReason : undefined)}
            >
              {t("apr.deny")}
            </button>
          </div>
        </>
      )}
      {turn.approvalControl?.phase && turn.approvalControl.phase !== "not_started" ? <p>{t(`apr.phase.${turn.approvalControl.phase}`)}</p> : null}
      {turn.approvalControl?.error ? <p role="alert">{turn.approvalControl.error}</p> : null}
      {turn.approvalControl?.unavailableReason && turn.approvalControl.status === "pending" ? <p>{t(`apr.unavailable.${turn.approvalControl.unavailableReason}`)}</p> : null}
      {new TextEncoder().encode(trimmedReason).length > 1024 ? <p role="alert">{t("apr.reasonTooLong")}</p> : null}
    </div>
  );
}

/** Append-only conversation history with collapsible public milestones.
 * Output, approvals and errors remain visible independently of the disclosure;
 * an indeterminate result is never presented as a completed response. */
export function TurnThread({ turns, loading = false, onEdit, viewportMemory, retrying = false, emptyPrompt, emptyDescription, canRetry, onRetry, onVerdict, decidedApprovalIds, scrollKey, focusTurnId, onOpenResource }: TurnThreadProps) {
  const t = useT();
  const engineLabel = useEngineLabel();
  const threadRef = useRef<HTMLOListElement>(null);
  const copy = useConversationCopy();
  const localMemory = useRef(new Map<string, ConversationViewport>());
  const memory = viewportMemory ?? localMemory.current;
  const scope = scrollKey ?? "default";
  const currentScope = useRef(scope);
  const lastViewport = useRef<ConversationViewport>({ top: 0, atBottom: true });
  const [newMessages, setNewMessages] = useState(false);
  const [away, setAway] = useState(false);
  const lastContent = useRef("");
  const restoring = useRef(true);
  const content = turns.map(turn => `${turn.id}:${turn.output ?? ""}:${turn.status}`).join("\n");

  function capture(node: HTMLOListElement): ConversationViewport {
    const edge = node.getBoundingClientRect().top;
    const anchor = Array.from(node.querySelectorAll<HTMLElement>("[data-turn-id]")).find(item => item.getBoundingClientRect().bottom > edge);
    return { top: node.scrollTop, atBottom: (node.scrollHeight > 0 || node.scrollTop === 0) && node.scrollHeight - node.clientHeight - node.scrollTop < 48,
      ...(anchor ? { anchor: anchor.dataset.turnId, offset: anchor.getBoundingClientRect().top - edge } : {}) };
  }
  function restore(node: HTMLOListElement, saved: ConversationViewport) {
    const anchor = saved.anchor ? Array.from(node.querySelectorAll<HTMLElement>("[data-turn-id]")).find(item => item.dataset.turnId === saved.anchor) : undefined;
    if (saved.atBottom) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    else if (anchor && (node.getBoundingClientRect().height > 0)) node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - (saved.offset ?? 0);
    else node.scrollTop = saved.top;
  }
  function goLatest() {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    lastViewport.current = capture(node);
    memory.set(scope, lastViewport.current);
    setNewMessages(false); setAway(false);
  }

  useLayoutEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    if (currentScope.current !== scope) {
      memory.set(currentScope.current, lastViewport.current);
      currentScope.current = scope;
      lastViewport.current = memory.get(scope) ?? { top: 0, atBottom: true };
      restoring.current = true;
      setNewMessages(false);
      lastContent.current = "";
    }
    if (restoring.current && turns.length) {
      const saved = memory.get(scope) ?? { top: 0, atBottom: true };
      restore(node, saved);
      lastViewport.current = saved;
      setAway(!saved.atBottom);
      restoring.current = false;
    } else if (!restoring.current && content !== lastContent.current) {
      if (lastViewport.current.atBottom) goLatest();
      else if (lastContent.current) setNewMessages(true);
    }
    lastContent.current = content;
  }, [scope, content, turns.length]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    const onScroll = () => {
      // Blank loading frames must not destroy a stored reading anchor.
      if (restoring.current || !node.querySelector("[data-turn-id]")) return;
      lastViewport.current = capture(node);
      memory.set(currentScope.current, lastViewport.current);
      setAway(!lastViewport.current.atBottom);
      if (lastViewport.current.atBottom) setNewMessages(false);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      if (!restoring.current && node.querySelector("[data-turn-id]")) restore(node, lastViewport.current);
    }) : undefined;
    observer?.observe(node);
    return () => {
      memory.set(currentScope.current, lastViewport.current);
      node.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [memory]);

  useEffect(() => {
    if (!focusTurnId || !threadRef.current) return;
    const target = threadRef.current.querySelector<HTMLElement>(`[data-turn-id="${focusTurnId}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusTurnId, turns]);

  return (
    <>
      {loading && turns.length === 0 ? <div className="owb-turn-thread owb-turn-thread--loading" aria-label={copy.preparing} aria-busy="true"><span /><span /><span /></div> : null}
      {turns.length === 0 && !loading ? (
      <div className="owb-turn-thread owb-turn-thread--empty">
        <EmptyState icon={<MessagesSquare size={32} strokeWidth={1.5} />}
          title={emptyPrompt ?? t("turn.emptyStart")} description={emptyDescription} />
      </div>
      ) : null}
      <ol ref={threadRef} className={`owb-turn-thread${turns.length === 0 ? " owb-turn-thread--empty" : ""}`} role="log" aria-live="polite" aria-label={t("turn.threadAria")} hidden={turns.length === 0}>
        {turns.map((turn) => {
        const retryable = turn.status === "failed" || turn.status === "indeterminate";
        const stateClass =
          turn.status === "running"
            ? "is-running"
            : turn.status === "failed"
              ? "is-failed"
              : turn.status === "indeterminate"
                ? "is-indeterminate"
                : "";
        // #142 AC-002: "provisional" is specifically the *live* state — text that
        // is still arriving and will be replaced by the verified output. An
        // interrupted turn also carries buffered text, but that text is frozen
        // and unconfirmed: it keeps the "unconfirmed output" region label and
        // must not take the provisional treatment, which would present the
        // interrupted stream as if more were still coming. The two states are
        // pinned by turn-provisional.test.tsx and turn-progress-interaction.
        const isProvisional = turn.status === "running" && Boolean(turn.output);
        const isFocused = focusTurnId === turn.id;
        return (
          <li className={`owb-turn ${stateClass}${isFocused ? " is-focused-turn" : ""}`} key={turn.id} data-turn-id={turn.id}>
            {/* #248 R2 ④：D3 升级为对话界面——操作员下达（右）与岗位回复（左）成对成线程。 */}
            <div className="owb-bubble-row owb-bubble-row--operator">
              <article className="owb-bubble owb-bubble--operator">
                <OperatorMessage turn={turn} onEdit={onEdit} />
              </article>
            </div>
            <div className="owb-bubble-row owb-bubble-row--employee">
            <article
              className={`owb-bubble owb-bubble--employee owb-tc ${stateClass}${isProvisional ? " owb-tc--provisional" : ""}`}
              aria-live={turn.status === "running" ? "polite" : undefined}
            >
              <header className="owb-tc-head">
                <span className="owb-tc-head__who">
                  {turn.positionName}
                </span>
                <Tooltip title={turn.model ? `${engineLabel(turn.engine)} · ${copy.requested}: ${turn.model}` : engineLabel(turn.engine)} trigger={["hover", "focus"]}>
                <span className="owb-tc-head__eng" tabIndex={0}>
                  <EngineIcon engine={turn.engine} />
                  {turn.model ? `${copy.requested}: ${turn.model}` : engineLabel(turn.engine)}
                </span>
                </Tooltip>
                {isProvisional ? (
                  <span className="owb-tc-head__provisional" aria-label={t("turn.provisionalTitle")}>
                    {t("turn.provisional")}
                  </span>
                ) : null}
                <time className="owb-tc-head__time" dateTime={turn.createdAt}>
                  {new Date(turn.createdAt).toLocaleTimeString()}
                </time>
              </header>

              <ProgressTrail turn={turn} approvalDecided={decidedApprovalIds?.has(turn.id) === true || decidedApprovalIds?.has(turn.approvalRequest?.approvalId ?? "") === true} onOpenResource={onOpenResource} />

              {turn.output ? (
                <section
                  className={`owb-turn__conclusion${isProvisional ? " is-provisional" : ""}`}
                  aria-label={isProvisional ? t("turn.liveOutput") : turn.status === "completed" ? t("turn.finalConclusion") : t("turn.unconfirmedOutput")}
                >
                  <div className="owb-turn-conclusion-label">{isProvisional ? t("turn.liveOutput") : turn.status === "completed" ? t("turn.finalConclusion") : t("turn.unconfirmedOutput")}</div>
                  {isProvisional ? (
                    <div className="owb-tc__out owb-tc__out--markdown owb-tc__out--provisional">
                      <Markdown content={turn.output} onNavigateDoc={onOpenResource ? (path) => onOpenResource(turn.positionId, path) : undefined} />
                    </div>
                  ) : (
                    <div className="owb-tc__out owb-tc__out--markdown">
                      <Markdown content={turn.output} onNavigateDoc={onOpenResource ? (path) => onOpenResource(turn.positionId, path) : undefined} />
                    </div>
                  )}
                </section>
              ) : null}
              <div className="owb-bubble__hover-actions">
                {turn.output ? <MessageActions raw={turn.output} plain={markdownToPlainText(turn.output)} /> : null}
                {turn.output && !isProvisional && turn.status === "completed" && window.owb.vault ? <TurnNoteAction turn={turn}
                  onCreated={(uri) => onOpenResource?.(turn.positionId, uri)} /> : null}
                {turn.approvalRequest === undefined && retryable && onRetry ? (
                  <button
                    type="button"
                    className="owb-turn__retry"
                    disabled={retrying || canRetry?.(turn) === false}
                    onClick={() => onRetry(turn)}
                  >
                    <RotateCcw aria-hidden="true" size={13} />
                    {t("turn.retry")}
                  </button>
                ) : null}
              </div>

              {turn.error ? (
                <div className="owb-bubble__error owb-turn-failure" role="alert" title={turn.error}>
                  <div className="owb-turn-failure__title"><AlertTriangle aria-hidden="true" size={14} />
                    {t(turn.errorCode === "turn_timeout" ? "turn.timeoutTitle" : "turn.failedTitle")}
                  </div>
                  {turn.errorCode === "turn_timeout" && turn.output ? <p>{t("turn.timeoutPreserved")}</p> : turn.error !== t("turn.failedTitle") ? <p>{turn.error}</p> : null}
                  {turn.errorCode !== "turn_timeout" ? <small>{t("turn.failedHelp")}</small> : null}
                </div>
              ) : null}
              {turn.diagnostic ? (
                <details className="owb-turn__diagnostic">
                  <summary>{t("turn.diagnosticTitle")}</summary>
                  <pre className="owb-turn__diagnostic-body">{turn.diagnostic}</pre>
                </details>
              ) : null}
              {turn.status === "indeterminate" ? (
                <p className="owb-turn__warning" title={t("turn.untrustedWarning")}>
                  <ShieldQuestion aria-hidden="true" size={13} />
                  {t("turn.untrustedWarning")}
                </p>
              ) : null}

              {turn.approvalRequest !== undefined && onVerdict ? (
                <ApprovalCard
                  turn={turn}
                  busy={retrying || canRetry?.(turn) === false}
                  decided={decidedApprovalIds?.has(turn.id) === true || decidedApprovalIds?.has(turn.approvalRequest.approvalId) === true}
                  onVerdict={onVerdict}
                />
              ) : null}
            </article>
            </div>
          </li>
        );
      })}
    </ol>
    {away ? <button type="button" className="owb-thread-latest" onClick={goLatest}>{newMessages ? copy.newMessages : copy.latest}</button> : null}
    </>
  );
}
