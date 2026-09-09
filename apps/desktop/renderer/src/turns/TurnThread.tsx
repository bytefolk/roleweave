import { useState } from "react";
import { Empty } from "antd";
import { AlertTriangle, Check, ChevronDown, Clock3, RotateCcw, ShieldAlert, ShieldQuestion } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useT } from "@roleweave/ui";
import { useEngineLabel } from "./TurnPanel";
import { EngineIcon } from "./engine-icon";
import type { TurnProgressKind, TurnProgressStep, TurnRecord, TurnStatus } from "./types";

export interface TurnThreadProps {
  turns: TurnRecord[];
  retrying?: boolean;
  /** #128 AC-002: when no turns exist, the empty-state heading is driven by
   * the caller so it can name the concrete prerequisite (e.g. "先从组织树
   * 或 @ 选择器选择岗位") rather than a generic "start from a clear task"
   * that contradicts the disabled composer hint below. */
  emptyPrompt?: string;
  canRetry?: (turn: TurnRecord) => boolean;
  onRetry?: (turn: TurnRecord) => void;
  /** Operator verdict for a turn settled as engine.approval_required. */
  onVerdict?: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void;
  /** Approval ids whose verdict was already dispatched; their cards settle
   * into a decided state so the operator cannot submit duplicate or
   * contradictory verdicts after a history reload. */
  decidedApprovalIds?: ReadonlySet<string>;
}

function StatusIcon({ status }: { status: TurnStatus }) {
  if (status === "completed") return <Check aria-hidden="true" size={13} />;
  if (status === "running") return <Clock3 aria-hidden="true" size={13} />;
  if (status === "indeterminate") return <ShieldQuestion aria-hidden="true" size={13} />;
  return <AlertTriangle aria-hidden="true" size={13} />;
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

function fallbackProgress(turn: TurnRecord): TurnProgressStep[] {
  const terminalKind: TurnProgressKind =
    turn.status === "completed"
      ? "completed"
      : turn.status === "failed"
        ? "failed"
        : turn.status === "indeterminate"
          ? "unknown"
          : "working";
  return [
    { kind: "received", at: turn.createdAt },
    { kind: terminalKind, at: turn.completedAt ?? turn.createdAt },
  ];
}

function ProgressIcon({ kind }: { kind: TurnProgressKind }) {
  if (kind === "working") return <Clock3 aria-hidden="true" size={13} />;
  if (kind === "awaiting_approval") return <ShieldAlert aria-hidden="true" size={13} />;
  if (kind === "failed" || kind === "unknown") return <AlertTriangle aria-hidden="true" size={13} />;
  return <Check aria-hidden="true" size={13} />;
}

function ProgressTrail({ turn }: { turn: TurnRecord }) {
  const t = useT();
  const progress = turn.progress ?? fallbackProgress(turn);
  const labels: Record<TurnProgressKind, string> = {
    received: t("turn.progressReceived"),
    working: t("turn.progressWorking"),
    awaiting_approval: t("turn.progressAwaitingApproval"),
    completed: t("turn.progressCompleted"),
    failed: t("turn.progressFailed"),
    unknown: t("turn.progressUnknown"),
  };
  return (
    <details className="owb-turn-progress" aria-label={t("turn.progressAria")}>
      <summary className="owb-turn-progress__header" aria-label={t("turn.progressDetails")}>
        <span className="owb-turn-progress__title">{t("turn.progressTitle")}</span>
        <ChevronDown className="owb-turn-progress__chevron" aria-hidden="true" size={14} />
      </summary>
      <ol className="owb-turn-progress__steps">
        {progress.map((step, index) => (
          <li
            className={`owb-turn-progress__step is-${step.kind}`}
            key={`${step.kind}-${step.at}-${index}`}
            title={`${labels[step.kind]} · ${new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          >
            <span className="owb-turn-progress__icon"><ProgressIcon kind={step.kind} /></span>
            <span className="owb-turn-progress__copy">{labels[step.kind]}</span>
          </li>
        ))}
      </ol>
    </details>
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
  onVerdict: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void;
}) {
  const t = useT();
  const kindCopy: Record<string, string> = {
    exec: t("apr.kind.exec"),
    write: t("apr.kind.write"),
    network: t("apr.kind.network"),
    tool: t("apr.kind.tool"),
  };
  const [reason, setReason] = useState("");
  const request = turn.approvalRequest;
  if (request === undefined) return null;
  const trimmedReason = reason.trim();
  return (
    <div className={`owb-turn__approval${decided ? " is-decided" : ""}`} role="group" aria-label={t("apr.request")}>
      <p className="owb-turn__approval-title">
        <ShieldAlert aria-hidden="true" size={13} />
        {decided ? t("apr.decided") : t("apr.pending")} · {kindCopy[request.kind] ?? request.kind}
      </p>
      <p className="owb-turn__approval-description owb-clamp-2" title={request.description}>
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
            <button
              type="button"
              className="owb-turn__approval-grant"
              disabled={busy}
              onClick={() => onVerdict(turn, "granted")}
            >
              {t("apr.grant")}
            </button>
            <button
              type="button"
              className="owb-turn__approval-deny"
              disabled={busy}
              onClick={() => onVerdict(turn, "denied", trimmedReason.length > 0 ? trimmedReason : undefined)}
            >
              {t("apr.deny")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Local, append-only turn history rendered as an evidence timeline
 * (#73 signature move ③「回合即证据」, docs/design/control-plane-v2-preview.html):
 * a guide rail with one state dot per turn (lavender settled / AI-purple
 * breathing while running / danger on failure), each carrying a `.owb-tc`
 * console card — head (position · engine · time), the dispatched task, the
 * engine output, compact progress labels and the approval card. It never
 * infers recall or delegation, and never upgrades an indeterminate terminal
 * state. (Supersedes the #61 bubble layout for this panel; the `.owb-bubble*`
 * classes stay in use by the group-chat timeline.) */
export function TurnThread({ turns, retrying = false, emptyPrompt, canRetry, onRetry, onVerdict, decidedApprovalIds }: TurnThreadProps) {
  const t = useT();
  const engineLabel = useEngineLabel();
  const statusCopy: Record<TurnStatus, string> = {
    running: t("turn.statusRunning"),
    completed: t("turn.done"),
    failed: t("turn.failed"),
    indeterminate: t("turn.statusUnknown"),
  };
  if (turns.length === 0) {
    return (
      <div className="owb-turn-thread owb-turn-thread--empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <strong>{emptyPrompt ?? t("turn.emptyStart")}</strong>
          }
        />
      </div>
    );
  }

  return (
    <ol className="owb-turn-thread" role="log" aria-live="polite" aria-label={t("turn.threadAria")}>
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
        const isProvisional = turn.status === "running" && Boolean(turn.output);
        return (
          <li className={`owb-turn ${stateClass}`} key={turn.id} data-turn-id={turn.id}>
            {/* #248 R2 ④：D3 升级为对话界面——操作员下达（右）与岗位回复（左）成对成线程。 */}
            <div className="owb-bubble-row owb-bubble-row--operator">
              <article className="owb-bubble owb-bubble--operator">
                <p className="owb-bubble__text owb-clamp-2" title={turn.input}>{turn.input}</p>
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
                <span className="owb-tc-head__eng">
                  <EngineIcon engine={turn.engine} />
                  {engineLabel(turn.engine)}
                </span>
                {isProvisional ? (
                  <span className="owb-tc-head__provisional" aria-label={t("turn.provisionalTitle")}>
                    {t("turn.provisional")}
                  </span>
                ) : null}
                <span className="owb-turn__status">
                  <StatusIcon status={turn.status} />
                  {statusCopy[turn.status]}
                </span>
                <time className="owb-tc-head__time" dateTime={turn.createdAt}>
                  {new Date(turn.createdAt).toLocaleTimeString()}
                </time>
              </header>

              <ProgressTrail turn={turn} />

              {turn.output ? (
                <section
                  className={`owb-turn__conclusion${isProvisional ? " is-provisional" : ""}`}
                  aria-label={isProvisional ? t("turn.liveOutput") : t("turn.finalConclusion")}
                >
                  <header className="owb-turn__conclusion-head">
                    <span className="owb-turn__conclusion-label">
                      {isProvisional ? <Clock3 aria-hidden="true" size={13} /> : <Check aria-hidden="true" size={13} />}
                      {isProvisional ? t("turn.liveOutput") : t("turn.finalConclusion")}
                    </span>
                  </header>
                  {isProvisional ? (
                    <div className="owb-tc__out owb-tc__out--markdown owb-tc__out--provisional" title={turn.output}>
                      <ReactMarkdown>{turn.output}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="owb-tc__out owb-tc__out--markdown" title={turn.output}>
                      <ReactMarkdown>{turn.output}</ReactMarkdown>
                    </div>
                  )}
                </section>
              ) : null}
              {turn.status === "running" && !turn.output ? <TypingIndicator /> : null}

              {turn.error ? (
                <div className="owb-bubble__error owb-clamp-2" title={turn.error}>{turn.error}</div>
              ) : null}
              {turn.status === "indeterminate" ? (
                <p className="owb-turn__warning owb-clamp-2" title={t("turn.untrustedWarning")}>
                  <ShieldQuestion aria-hidden="true" size={13} />
                  {t("turn.untrustedWarning")}
                </p>
              ) : null}

              {turn.approvalRequest !== undefined && onVerdict ? (
                <ApprovalCard
                  turn={turn}
                  busy={retrying || canRetry?.(turn) === false}
                  decided={decidedApprovalIds?.has(turn.approvalRequest.approvalId) === true}
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
  );
}
