import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button as AntButton, Input, Select as AntSelect } from "antd";
import { ArrowUp, MessagesSquare, Plus, RefreshCw, Square } from "lucide-react";
import type { WorkbenchSession } from "@org-workbench/shared";
import { useT } from "@org-workbench/ui";
import { PositionMention } from "./PositionMention";
import { EngineIcon } from "./engine-icon";
import { TurnThread } from "./TurnThread";
import type {
  CreateTurnRequest,
  PositionMentionOption,
  TurnEngine,
  TurnEngineAvailability,
  TurnRecord,
} from "./types";

export interface TurnPanelProps {
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  engine: TurnEngine;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  turns: TurnRecord[];
  busy?: boolean;
  cancelling?: boolean;
  sessions?: WorkbenchSession[];
  selectedSessionId?: string | null;
  sessionBusy?: boolean;
  onSelectPosition: (positionId: string) => void;
  onSelectEngine: (engine: TurnEngine) => void;
  onCreateTurn: (request: CreateTurnRequest) => void | boolean | Promise<void | boolean>;
  /** Operator interrupt for the in-flight turn of the selected position. */
  onCancelTurn?: (positionId: string) => void | Promise<void>;
  /** Operator verdict for a turn settled as engine.approval_required (#25 Slice B). */
  onVerdictTurn?: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void | Promise<void>;
  /** Approval ids whose verdict was already dispatched this session; their
   * cards settle into a decided state (no duplicate verdicts). */
  decidedApprovalIds?: ReadonlySet<string>;
  /** SSE stream health for the header badge — honest state only: the badge
   * goes dim while reconnecting, it never fakes a live stream. */
  sseConnected?: boolean;
  /** Selected position's mode / per-task budget for the boundary chips
   * (设计稿 .boundaries). Both come straight from /positions/:id; absent
   * means the card has not loaded and the chip shows —, never a guess. */
  selectedMode?: "read_only" | "approval_required" | null;
  selectedBudgetLabel?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void | Promise<void>;
  onRotateSession?: (sessionId: string) => void | Promise<void>;
}

const ENGINE_LABEL: Record<TurnEngine, string> = {
  qoder: "Qoder",
  "claude-code": "Claude Code",
  "claude-local": "Claude Code",
  codex: "Codex",
};

/** #146：引擎品牌名保持原文（数据面不迁）；只有 claude-local 的变体修饰词
 * 走目录。同 locale 内返回的函数身份稳定。 */
export function useEngineLabel(): (engine: TurnEngine) => string {
  const t = useT();
  return useCallback(
    (engine: TurnEngine) =>
      engine === "claude-local" ? `Claude Code · ${t("turn.claudeLocalSuffix")}` : ENGINE_LABEL[engine],
    [t],
  );
}

/** antd Select option list for the Agent Host picker (#57): brand icon + label
 * + availability suffix. Only EngineSelect consumes it. */
function engineSelectOptions(
  engines: readonly TurnEngine[],
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>,
  labelOf: (engine: TurnEngine) => string,
) {
  return engines.map((candidate) => ({
    value: candidate,
    label: (
      <span className="owb-engine-option">
        <EngineIcon engine={candidate} />
        {labelOf(candidate)}
        {engineAvailability[candidate].ready
          ? " · Configured"
          : engineAvailability[candidate].configured
            ? " · Blocked"
            : " · Idle"}
      </span>
    ),
  }));
}

function isTurnEngine(value: unknown): value is TurnEngine {
  return typeof value === "string" && value in ENGINE_LABEL;
}

/** Compact trigger label (#94 defect 2). The popup keeps the full option text
 * including the availability suffix; the trigger only ever has ~220px, so it
 * shows icon + host name. Readiness is already stated in prose right under the
 * control (see the engine hint below) and in GroupsPanel's engine chip, so the
 * suffix is the redundant half and the right thing to drop here. */
function engineTriggerLabel(engine: TurnEngine, labelOf: (engine: TurnEngine) => string) {
  return (
    <span className="owb-engine-option">
      <EngineIcon engine={engine} />
      {labelOf(engine)}
    </span>
  );
}

/** Agent Host picker, shared by TurnPanel and GroupsPanel so the two cannot
 * drift apart again.
 *
 * `popupMatchSelectWidth={false}` is load-bearing rather than cosmetic: left
 * unset, @rc-component/select pins the popup to the trigger's *width* (not
 * min-width), so a trigger too narrow for the longest label ellipsises every
 * option too and no interaction is left that reveals the full text (#94). */
export function EngineSelect({
  engines,
  engineAvailability,
  value,
  disabled = false,
  onChange,
}: {
  engines: readonly TurnEngine[];
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  value: TurnEngine;
  disabled?: boolean;
  onChange: (engine: TurnEngine) => void;
}) {
  const t = useT();
  const labelOf = useEngineLabel();
  return (
    <AntSelect
      aria-label={t("turn.pickHost")}
      value={value}
      disabled={disabled}
      onChange={(next) => onChange(next as TurnEngine)}
      options={engineSelectOptions(engines, engineAvailability, labelOf)}
      labelRender={({ value: selected, label }) =>
        isTurnEngine(selected) ? engineTriggerLabel(selected, labelOf) : label}
      popupMatchSelectWidth={false}
    />
  );
}

export function TurnPanel({
  workspaceOpen,
  positions,
  selectedPositionId,
  engine,
  engineAvailability,
  turns,
  busy = false,
  cancelling = false,
  sessions,
  selectedSessionId = null,
  sessionBusy = false,
  onSelectPosition,
  onSelectEngine,
  onCreateTurn,
  onCancelTurn,
  onVerdictTurn,
  decidedApprovalIds,
  sseConnected = false,
  selectedMode = null,
  selectedBudgetLabel = null,
  onSelectSession,
  onCreateSession,
  onRotateSession,
}: TurnPanelProps) {
  const t = useT();
  const engineLabel = useEngineLabel();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const selectedPosition = positions.find((position) => position.id === selectedPositionId) ?? null;
  const runningTurn = selectedPositionId !== null && turns.some(
    (turn) => turn.positionId === selectedPositionId && turn.status === "running",
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.key !== ".") return;
      if (!runningTurn || cancelling || !selectedPosition) return;
      event.preventDefault();
      void onCancelTurn?.(selectedPosition.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelling, onCancelTurn, runningTurn, selectedPosition]);

  const sessionMode = sessions !== undefined;
  const selectedSession = sessions?.find((session) => session.sessionId === selectedSessionId) ?? null;
  const activeSession = sessions?.find((session) => session.status === "active") ?? null;

  const disabledReason = useMemo(() => {
    if (!workspaceOpen) return t("turn.emptyOpenFirst");
    if (positions.length === 0) return t("turn.noPositions");
    if (!selectedPosition) return t("turn.emptyPick");
    if (sessionMode && !selectedSession) return t("turn.emptySession");
    if (sessionMode && selectedSession?.status !== "active") return t("turn.sessionReadOnly");
    if (!engineAvailability[engine].ready) {
      return engineAvailability[engine].reason ?? t("turn.engineNotReady", { engine: engineLabel(engine) });
    }
    if (busy || sending || sessionBusy) return t("turn.updating");
    return null;
  }, [busy, engine, engineAvailability, engineLabel, positions.length, selectedPosition, selectedSession, sending, sessionBusy, sessionMode, t, workspaceOpen]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await dispatchTurn();
  };

  const dispatchTurn = async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || disabledReason || !selectedPosition) return;
    setSending(true);
    try {
      const created = await onCreateTurn({ positionId: selectedPosition.id, engine, input: trimmed });
      if (created !== false) setInput("");
    } finally {
      setSending(false);
    }
  };

  const retry = async (turn: TurnRecord) => {
    if (busy || sending || !workspaceOpen || !engineAvailability[turn.engine].ready) return;
    setSending(true);
    try {
      await onCreateTurn({
        positionId: turn.positionId,
        engine: turn.engine,
        input: turn.input,
        retryOf: turn.id,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="owb-turn-panel owb-panel" aria-label={t("turn.panelAria")}>
      <header className="owb-turn-panel__header owb-panel-head">
        <div className="owb-panel-head__main">
          <h2>
            <MessagesSquare aria-hidden="true" size={15} />
            {t("turn.title")}
            {selectedPosition ? (
              <span className="owb-turn-panel__subject">· {selectedPosition.id}</span>
            ) : null}
          </h2>
        </div>
        <div className="owb-panel-head__right">
          <span className="owb-badge owb-badge--ai">
            <span
              className={sseConnected ? "owb-led owb-led--running" : "owb-led owb-led--off"}
              aria-hidden="true"
            />
            SSE
          </span>
        </div>
      </header>

      <TurnThread
        turns={turns}
        retrying={busy || sending}
        emptyPrompt={disabledReason ?? t("turn.emptyStart")}
        canRetry={(turn) => workspaceOpen && engineAvailability[turn.engine].ready && (!sessionMode || selectedSession?.status === "active")}
        onRetry={(turn) => void retry(turn)}
        onVerdict={onVerdictTurn === undefined ? undefined : (turn, decision, reason) => void onVerdictTurn(turn, decision, reason)}
        decidedApprovalIds={decidedApprovalIds}
      />

      <form className="owb-turn-composer" onSubmit={(event) => void submit(event)}>
        <label htmlFor="owb-turn-input">{t("turn.compose")}</label>
        <div className="owb-turn-composer__surface">
          <Input.TextArea
            id="owb-turn-input"
            value={input}
            rows={3}
            placeholder={selectedPosition ? t("turn.composeTo", { name: selectedPosition.name }) : t("turn.composePlaceholder")}
            disabled={disabledReason !== null}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // ⌘↵ / Ctrl+↵ 发送（提示条声明了这个快捷键，就必须真的能用）。
              //
              // #128 AC-003 / #127 AC-003: while a Chinese IME is composing,
              // pressing Enter commits the candidate — never a message. React
              // exposes `nativeEvent.isComposing`; older WebKit/Firefox
              // fall back to `keyCode === 229` while composing. Guard on
              // both so ⌘↵ during composition is a no-op, not a send.
              const native = event.nativeEvent as KeyboardEvent;
              if (native.isComposing || native.keyCode === 229) return;
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void dispatchTurn();
              }
            }}
          />
          {runningTurn ? (
            <AntButton
              danger
              disabled={cancelling || !selectedPosition}
              aria-label={t("turn.interrupt")}
              title={t("turn.interruptTitle")}
              icon={<Square aria-hidden="true" size={15} />}
              onClick={() => {
                if (selectedPosition) void onCancelTurn?.(selectedPosition.id);
              }}
            />
          ) : (
            <AntButton
              type="primary"
              htmlType="submit"
              disabled={disabledReason !== null || input.trim().length === 0}
              aria-label={t("turn.send")}
              icon={<ArrowUp aria-hidden="true" size={15} />}
            />
          )}
        </div>
        {/* #167：空闲不挂提示行；运行态/禁用原因保留（有用反馈）。 */}
        {runningTurn || disabledReason ? (
          <p className="owb-turn-composer__hint" role="status">
          {runningTurn
            ? cancelling
              ? t("turn.interrupting")
              : t("turn.running")
            : disabledReason}
          </p>
        ) : null}
      </form>

      {/* #248 R2 ③：对话岗位 / 新建会话 / Agent Host 降级为默认收起的会话设置，
          值由点人即聊自动填充，不挡在聊天输入前面。 */}
      <details className="owb-turn-panel__settings">
        <summary className="owb-turn-panel__settings-summary">{t("turn.sessionSettings")}</summary>
        <div className="owb-turn-panel__settings-body">
          <div className="owb-turn-panel__controls">
            <PositionMention
              positions={positions}
              value={selectedPositionId}
              disabled={!workspaceOpen || positions.length === 0}
              onChange={onSelectPosition}
            />
            <label className="owb-turn-engine">
              <span className="owb-turn-control__label">Agent Host</span>
              <EngineSelect
                engines={Object.keys(ENGINE_LABEL) as TurnEngine[]}
                engineAvailability={engineAvailability}
                value={engine}
                disabled={!workspaceOpen}
                onChange={onSelectEngine}
              />
            </label>
          </div>

          {sessionMode && selectedSession ? (
            <div className="owb-session-row" aria-label={t("turn.currentSession")}>
              <div className="owb-session-chip">
                <span
                  className={selectedSession.status === "active" ? "owb-led owb-led--running" : "owb-led owb-led--off"}
                  aria-hidden="true"
                />
                <span className="owb-session-chip__kind">session</span>
                <span className="owb-session-chip__id">
                  {selectedSession.sessionId.slice(0, 8)} · {selectedSession.status === "active" ? "active" : t("turn.sessionKindReadonly")}
                  {selectedPosition ? ` · ${selectedPosition.id}` : ""}
                </span>
              </div>
            </div>
          ) : null}

          {sessionMode ? (
            <div className="owb-session-controls" aria-label={t("turn.positionSessions")}>
              <label>
                <span className="owb-turn-control__label">{t("turn.session")}</span>
                <AntSelect
                  aria-label={t("turn.pickSession")}
                  value={selectedSessionId ?? undefined}
                  placeholder={t("turn.noSession")}
                  disabled={!workspaceOpen || !selectedPosition || sessionBusy || sessions.length === 0}
                  onChange={(next) => {
                    if (next) onSelectSession?.(next);
                  }}
                  options={sessions.map((session, index) => ({
                    value: session.sessionId,
                    label: t("turn.sessionOption", {
                      kind: session.status === "active" ? t("turn.sessionKindActive") : t("turn.sessionKindReadonly"),
                      index: sessions.length - index,
                      shortId: session.sessionId.slice(0, 8),
                    }),
                  }))}
                />
              </label>
              {activeSession ? (
                <AntButton
                  disabled={sessionBusy || busy}
                  onClick={() => void onRotateSession?.(activeSession.sessionId)}
                  icon={<RefreshCw aria-hidden="true" size={13} />}
                >
                  {t("turn.rotate")}
                </AntButton>
              ) : (
                <AntButton
                  disabled={!workspaceOpen || !selectedPosition || sessionBusy}
                  onClick={() => void onCreateSession?.()}
                  icon={<Plus aria-hidden="true" size={13} />}
                >
                  {t("turn.newSession")}
                </AntButton>
              )}
            </div>
          ) : null}

          {/* 设计稿 .boundaries：host / mode / budget 三枚实况 chip。全部来自
              /health 与 /positions/:id 的事实，缺失即显示 —，不猜。 */}
          <div className="owb-turn-panel__boundaries" aria-label={t("turn.boundaries")}>
            <span className="owb-boundary">
              <b>host</b>
              {engineLabel(engine)} — {engineAvailability[engine].ready
                ? "available"
                : engineAvailability[engine].configured
                  ? "blocked"
                  : "idle"}
            </span>
            <span className="owb-boundary">
              <b>mode</b>
              {selectedMode === null
                ? "—"
                : selectedMode === "read_only"
                  ? `read_only · ${t("pos.readOnly")}`
                  : `approval_required · ${t("pos.approval")}`}
            </span>
            <span className="owb-boundary">
              <b>budget</b>
              {selectedBudgetLabel ?? "—"}
            </span>
          </div>
        </div>
      </details>
    </section>
  );
}
