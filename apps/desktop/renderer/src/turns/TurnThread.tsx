import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, Check, ChevronRight, LoaderCircle, MessagesSquare, RotateCcw, ShieldAlert, ShieldQuestion } from "lucide-react";
import { Markdown, markdownToPlainText } from "../markdown/Markdown";
import { useConversationCopy } from "../locales/conversation";
import type { ConversationViewport } from "./conversation-memory";
import { MessageActions, OperatorMessage } from "./message-actions";
import { EmptyState, useT } from "@roleweave/ui";
import { useEngineLabel } from "./engine-select";
import { EngineIcon } from "./engine-icon";
import type { TurnProgressKind, TurnRecord } from "./types";

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
}

/** Running bubble typing indicator (#61, spec ②): three 6px dots, 150ms
 * stagger, 1.05s ease-out loop — 处方4 聊天例外（见 ADR-0007）。Screen-reader
 * copy stays intact. */
export function TypingIndicator() {
  const t = useT();
  return (
    <span className="owb-bubble__typing" role="status">
      <span className="owb-bubble__typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {t("turn.waiting")}
    </span>
  );
}

function fallbackProgress(turn: TurnRecord): Array<{ kind: TurnProgressKind; at?: string }> {
  const terminalKind: TurnProgressKind =
    turn.approvalRequest
      ? "awaiting_approval"
      : turn.status === "completed"
      ? "completed"
      : turn.status === "failed"
        ? "failed"
        : turn.status === "indeterminate"
          ? "unknown"
          : "working";
  return [
    { kind: "received", at: turn.createdAt },
    { kind: terminalKind, at: turn.completedAt },
  ];
}

function ProgressIcon({ kind, active }: { kind: TurnProgressKind; active: boolean }) {
  if (active) return (
    <span className="owb-turn-progress__activity" aria-hidden="true">
      <span className="owb-turn-progress__activity-orbit" />
      <LoaderCircle className="owb-turn-progress__spinner" size={12} />
    </span>
  );
  if (kind === "awaiting_approval") return <ShieldAlert aria-hidden="true" size={12} />;
  if (kind === "failed" || kind === "unknown") return <AlertTriangle aria-hidden="true" size={12} />;
  return <Check aria-hidden="true" size={12} />;
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

/** A live clock only while executing. Missing terminal timestamps stay absent;
 * a historical response must not acquire a duration from today's clock. */
function ElapsedTime({ turn }: { turn: TurnRecord }) {
  const t = useT();
  const running = turn.status === "running";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running, turn.createdAt]);
  const terminalStep = turn.progress?.slice().reverse().find((step) =>
    ["completed", "failed", "unknown", "awaiting_approval"].includes(step.kind));
  const seconds = elapsedSeconds(turn.createdAt, running ? now : turn.completedAt ?? terminalStep?.at);
  if (seconds === null) return null;
  const duration = formatElapsed(seconds);
  return <time className="owb-turn-progress__elapsed" dateTime={`PT${seconds}S`}
    role="timer" aria-live="off" aria-label={t("turn.elapsed", { duration })}>· {duration}</time>;
}

export function ProgressTrail({ turn, approvalDecided = false }: { turn: TurnRecord; approvalDecided?: boolean }) {
  const t = useT();
  const copy = useConversationCopy();
  const stepsId = useId();
  const progress = turn.progress?.length ? turn.progress : fallbackProgress(turn);
  const awaitingApproval = turn.approvalRequest !== undefined;
  const running = turn.status === "running" && !awaitingApproval;
  // A user's disclosure choice survives streamed text updates. A new terminal
  // phase starts collapsed, leaving the final response in the foreground.
  const phase = `${turn.id}:${turn.status}:${approvalDecided}`;
  const [choice, setChoice] = useState<{ phase: string; open: boolean } | null>(null);
  const open = choice?.phase === phase ? choice.open : running;
  const state = awaitingApproval ? (approvalDecided ? "decided" : "awaiting_approval") : turn.status;
  const summary = awaitingApproval
    ? t(approvalDecided ? "apr.decided" : "turn.progressAwaitingApproval")
    : turn.errorCode === "turn_cancelled" ? copy.cancelled : t({ running: "turn.statusRunning", completed: "turn.done", failed: "turn.failed", indeterminate: "turn.statusUnknown" }[turn.status]);
  const labels: Record<TurnProgressKind, string> = {
    received: t("turn.progressReceived"),
    working: t("turn.progressProcessing"),
    awaiting_approval: t("turn.progressAwaitingApproval"),
    completed: t("turn.progressCompleted"),
    failed: t("turn.progressFailed"),
    unknown: t("turn.progressUnknown"),
  };
  return (
    <div className={`owb-turn-progress is-${state}`} role="group" aria-label={t("turn.progressAria")}
      data-motion={running ? "live" : undefined}>
      <div className="owb-turn-progress__summary">
        <button type="button" className="owb-turn-progress__header"
          aria-label={`${t("turn.progressDetails")} · ${summary}`} aria-expanded={open} aria-controls={stepsId}
          onClick={() => setChoice({ phase, open: !open })}>
          <span className="owb-turn-progress__toggle"><ChevronRight className="owb-turn-progress__chevron" aria-hidden="true" size={11} /></span>
          <span className="owb-turn-progress__title">{summary}</span>
        </button>
        <ElapsedTime turn={turn} />
      </div>
      <ol id={stepsId} className="owb-turn-progress__steps" hidden={!open}>
        {progress.map((step, index) => {
          const active = running && index === progress.length - 1;
          const offset = elapsedSeconds(turn.createdAt, step.at);
          return (
            <li className={`owb-turn-progress__step is-${step.kind}${active ? " is-current" : ""}`}
              key={`${step.kind}-${step.at}-${index}`} aria-current={active ? "step" : undefined}
              data-motion={active ? "active" : undefined} style={{ "--progress-step": index } as CSSProperties}>
              <span className="owb-turn-progress__icon"><ProgressIcon kind={step.kind} active={active} /></span>
              <span className="owb-turn-progress__copy">{labels[step.kind]}</span>
              {offset !== null ? <time className="owb-turn-progress__at" dateTime={step.at}>{formatElapsed(offset)}</time> : null}
            </li>
          );
        })}
      </ol>
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
  const disabled = busy || turn.approvalControl?.disabled === true || new TextEncoder().encode(trimmedReason).length > 1024;
  return (
    <div className={`owb-turn__approval${decided ? " is-decided" : ""}`} role="group" aria-label={t("apr.request")}>
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
      {decided ? (
        <p className="owb-turn__approval-decided">{t("apr.decidedNote")}</p>
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
            {request.scopeAllowed?.includes("run") ? <select aria-label={t("apr.scopeTitle")} value={scope} disabled={disabled} onChange={(event) => setScope(event.target.value as "once" | "run")}>
              <option value="once">{t("apr.scope.once")}</option>
              <option value="run">{t("apr.scope.run")}</option>
            </select> : null}
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
export function TurnThread({ turns, loading = false, onEdit, viewportMemory, retrying = false, emptyPrompt, emptyDescription, canRetry, onRetry, onVerdict, decidedApprovalIds, scrollKey }: TurnThreadProps) {
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

  return (
    <>
      {loading && turns.length === 0 ? <div className="owb-turn-thread owb-turn-thread--loading" aria-label={copy.preparing} aria-busy="true"><span /><span /><span /></div> : null}
      <div className="owb-turn-thread owb-turn-thread--empty" hidden={turns.length > 0 || loading}>
        <EmptyState icon={<MessagesSquare size={32} strokeWidth={1.5} />}
          title={emptyPrompt ?? t("turn.emptyStart")} description={emptyDescription} />
      </div>
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
        return (
          <li className={`owb-turn ${stateClass}`} key={turn.id} data-turn-id={turn.id}>
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
                <span className="owb-tc-head__eng" title={turn.model ? `${copy.requested}: ${turn.model}` : engineLabel(turn.engine)}>
                  <EngineIcon engine={turn.engine} />
                  {turn.model ? `${copy.requested}: ${turn.model}` : engineLabel(turn.engine)}
                </span>
                {isProvisional ? (
                  <span className="owb-tc-head__provisional" aria-label={t("turn.provisionalTitle")}>
                    {t("turn.provisional")}
                  </span>
                ) : null}
                <time className="owb-tc-head__time" dateTime={turn.createdAt}>
                  {new Date(turn.createdAt).toLocaleTimeString()}
                </time>
              </header>

              <ProgressTrail turn={turn} approvalDecided={decidedApprovalIds?.has(turn.id) === true || decidedApprovalIds?.has(turn.approvalRequest?.approvalId ?? "") === true} />

              {turn.output ? (
                <section
                  className={`owb-turn__conclusion${isProvisional ? " is-provisional" : ""}`}
                  aria-label={isProvisional ? t("turn.liveOutput") : turn.status === "completed" ? t("turn.finalConclusion") : t("turn.unconfirmedOutput")}
                >
                  <div className="owb-turn-conclusion-label">{isProvisional ? t("turn.liveOutput") : turn.status === "completed" ? t("turn.finalConclusion") : t("turn.unconfirmedOutput")}</div>
                  {isProvisional ? (
                    <div className="owb-tc__out owb-tc__out--markdown owb-tc__out--provisional" title={turn.output}>
                      <Markdown content={turn.output} />
                    </div>
                  ) : (
                    <div className="owb-tc__out owb-tc__out--markdown" title={turn.output}>
                      <Markdown content={turn.output} />
                    </div>
                  )}
                </section>
              ) : null}
              {turn.output ? <MessageActions raw={turn.output} plain={markdownToPlainText(turn.output)} /> : null}
              {turn.status === "running" && !turn.output ? <TypingIndicator /> : null}

              {turn.error ? (
                <div className="owb-bubble__error" title={turn.error}>{turn.error}</div>
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

              {turn.approvalRequest === undefined && retryable && onRetry ? (
                <div className="owb-bubble__retryrow">
                  <button
                    type="button"
                    className="owb-turn__retry"
                    disabled={retrying || canRetry?.(turn) === false}
                    onClick={() => onRetry(turn)}
                  >
                    <RotateCcw aria-hidden="true" size={13} />
                    {t("turn.retry")}
                  </button>
                </div>
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
