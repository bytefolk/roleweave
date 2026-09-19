import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Popover } from "antd";
import { useConversationCopy } from "../locales/conversation";
import { createConversationMemory, conversationKey, type ConversationMemory } from "./conversation-memory";
import { Maximize2, Minimize2, History, MessagesSquare } from "lucide-react";
import type { EmployeeModelConfig, WorkbenchSession } from "@roleweave/shared";
import { ConversationOptions } from "./ConversationOptions";
import { useT } from "@roleweave/ui";
import type { AvailabilityCheck, NoticeAction } from "../DiagnosticNotice";
import { TurnComposer } from "./TurnComposer";
import { EngineSelect, TURN_ENGINES, useEngineLabel } from "./engine-select";
import { EngineBadge } from "./EngineBadge";
import { TurnThread } from "./TurnThread";
import { PositionAvatar } from "../PositionAvatar";
import type {
  CreateTurnRequest,
  PositionMentionOption,
  TurnEngine,
  TurnEngineAvailability,
  TurnRecord,
} from "./types";

export { EngineSelect, useEngineLabel } from "./engine-select";

export interface TurnPanelProps {
  active?: boolean;
  workspaceKey?: string;
  memory?: ConversationMemory;
  focused?: boolean;
  onToggleFocus?: () => void;
  onSelectSession?: (sessionId: string) => void;
  historyLoading?: boolean;
  modelLoading?: boolean;
  modelError?: string;
  modelNotice?: string;
  onReloadModel?: () => void;
  sendShortcut?: "enter" | "mod-enter";
  availabilityCheck?: AvailabilityCheck;
  /** One-click Qoder login surface owned by the shell; rendered only while the
   *  qoder Host is the selected runtime and reports loginRequired. */
  qoderLogin?: { action: NoticeAction; link?: NoticeAction; feedback: string | null };
  modelConfig?: EmployeeModelConfig;
  avatarUrls?: Record<string, string>;
  modelSaving?: boolean;
  onSelectModel?: (model: string) => void | Promise<void>;
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  engine: TurnEngine;
  /** The initial runtime selection locks an employee to one runtime. */
  engineLocked?: boolean;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  turns: TurnRecord[];
  busy?: boolean;
  employeeBusy?: boolean;
  cancelling?: boolean;
  sessions?: WorkbenchSession[];
  selectedSessionId?: string | null;
  sessionBusy?: boolean;
  /** Selection happens in the organization tree. Kept optional for callers
   * that share the old panel contract; this panel deliberately has no second
   * recipient picker. */
  onSelectPosition?: (positionId: string) => void;
  /** Host selection for unlocked positions (e.g. imported employees before initial choice). */
  onSelectEngine?: (engine: TurnEngine) => void;
  onCreateTurn: (request: CreateTurnRequest) => void | boolean | Promise<void | boolean>;
  /** Operator interrupt for the in-flight turn of the selected position. */
  onCancelTurn?: (positionId: string) => void | boolean | Promise<void | boolean>;
  /** Operator verdict for a turn settled as engine.approval_required (#25 Slice B). */
  onVerdictTurn?: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void | Promise<void>;
  /** Approval ids whose verdict was already dispatched this session; their
   * cards settle into a decided state (no duplicate verdicts). */
  decidedApprovalIds?: ReadonlySet<string>;
  onSetSessionContext?: (sessionId: string, enabled: boolean) => void | Promise<void>;
  /** #305 Operator restart: rotate the attached active session into history
   * and continue on its successor. Optional; callers without it simply get a
   * conversation without the restart control. */
  onRotateSession?: (sessionId: string) => void | Promise<void>;
}

export function TurnPanel({
  active = true,
  workspaceKey = "",
  memory,
  focused = false,
  onToggleFocus,
  onSelectSession,
  historyLoading = false,
  modelLoading = false,
  modelError,
  modelNotice,
  onReloadModel,
  sendShortcut = "enter",
  availabilityCheck,
  qoderLogin,
  modelConfig,
  avatarUrls,
  modelSaving = false,
  onSelectModel,
  onSetSessionContext,
  workspaceOpen,
  positions,
  selectedPositionId,
  engine,
  engineLocked = true,
  engineAvailability,
  onSelectEngine,
  turns,
  busy = false,
  employeeBusy = false,
  cancelling = false,
  sessions,
  selectedSessionId = null,
  sessionBusy = false,
  onCreateTurn,
  onCancelTurn,
  onVerdictTurn,
  decidedApprovalIds,
  onRotateSession,
}: TurnPanelProps) {
  const t = useT();
  const engineLabel = useEngineLabel();
  const copy = useConversationCopy();
  const localMemory = useRef(createConversationMemory());
  const conversationMemory = memory ?? localMemory.current;
  const draftKey = conversationKey(workspaceKey, selectedPositionId, selectedSessionId);
  const [, renderDraft] = useState(0);
  const [sendingKeys, setSendingKeys] = useState<Record<string, boolean>>({});
  const sendingRef = useRef(new Set<string>());
  const stopRequests = conversationMemory.stopping;
  const [, renderStop] = useState(0);
  const [editRequest, setEditRequest] = useState<{ key: string; text: string } | null>(null);
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const input = conversationMemory.drafts.get(draftKey) ?? "";
  const sending = sendingKeys[draftKey] === true;
  const setInput = (value: string, key = draftKey) => {
    conversationMemory.drafts.set(key, value);
    renderDraft(value => value + 1);
  };
  const setSending = (value: boolean) => {
    if (value) sendingRef.current.add(draftKey); else sendingRef.current.delete(draftKey);
    setSendingKeys((current) => ({ ...current, [draftKey]: value }));
  };
  function edit(text: string) {
    if (input.trim() && input !== text) setEditRequest({ key: draftKey, text });
    else { setInput(text); document.getElementById("owb-turn-input")?.focus(); }
  }
  useEffect(() => { setHistoryOpen(false); setEditRequest(null); }, [draftKey, active]);
  const selectedPosition = positions.find((position) => position.id === selectedPositionId) ?? null;
  const runningTurn = selectedPositionId !== null && turns.some(
    (turn) => turn.positionId === selectedPositionId && turn.status === "running",
  );

  const stopping = cancelling || stopRequests.has(draftKey);
  useEffect(() => {
    if (!runningTurn) { stopRequests.delete(draftKey); renderStop(value => value + 1); }
  }, [draftKey, runningTurn]);
  const requestStop = async () => {
    if (!selectedPosition || !runningTurn || stopping || stopRequests.has(draftKey)) return;
    stopRequests.add(draftKey); renderStop(value => value + 1);
    try {
      const accepted = await onCancelTurn?.(selectedPosition.id);
      if (accepted !== false) return;
    } catch { /* The real execution remains running after a failed stop. */ }
    stopRequests.delete(draftKey); renderStop(value => value + 1);
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.key !== ".") return;
      if (!runningTurn || stopping || !selectedPosition) return;
      event.preventDefault();
      void requestStop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, draftKey, stopping, onCancelTurn, runningTurn, selectedPosition]);

  const sessionMode = sessions !== undefined;
  const selectedSession = sessions?.find((session) => session.sessionId === selectedSessionId) ?? null;

  const disabledState = useMemo(() => {
    const blocked = (reason: string, summary = reason, diagnostic?: string, canRecheck = false) => ({ reason, summary, diagnostic, canRecheck });
    if (modelSaving) return blocked(t("model.saving"));
    if (!workspaceOpen) return blocked(t("turn.emptyOpenFirst"));
    if (positions.length === 0) return blocked(t("turn.noPositions"));
    if (!selectedPosition) return blocked(t("turn.emptyPick"));
    if (sessionMode && sessionBusy) return blocked(t("turn.sessionPreparing"));
    if (sessionMode && !selectedSession) return blocked(t("turn.emptySession"));
    if (sessionMode && selectedSession?.status !== "active") return blocked(t("turn.sessionReadOnly"));
    if (modelConfig?.connection?.status === "invalid") return blocked(
      modelConfig.connection.message ?? t("turn.engineNotReady", { engine: engineLabel(engine) }),
      t("turn.modelConnectionNotReady"), modelConfig.connection.message, true,
    );
    if (!engineAvailability[engine].ready) {
      const summary = t("turn.engineNotReady", { engine: engineLabel(engine) });
      return blocked(engineAvailability[engine].reason ?? summary, summary, engineAvailability[engine].reason, true);
    }
    if (runningTurn || busy || employeeBusy || sending || sessionBusy) return blocked(t("turn.updating"));
    return null;
  }, [runningTurn, busy, employeeBusy, engine, engineAvailability, engineLabel, modelConfig, modelSaving, positions.length, selectedPosition, selectedSession, sending, sessionBusy, sessionMode, t, workspaceOpen]);
  const disabledReason = disabledState?.reason ?? null;

  const dispatchTurn = async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || disabledReason || !selectedPosition || sendingRef.current.has(draftKey)) return;
    setSending(true);
    setSendErrors(current => ({ ...current, [draftKey]: "" }));
    try {
      const created = await onCreateTurn({ positionId: selectedPosition.id, engine, input: trimmed });
      if (created !== false && conversationMemory.drafts.get(draftKey) === input) setInput("", draftKey);
      if (created === false) setSendErrors(current => ({ ...current, [draftKey]: copy.sendFailed }));
    } catch {
      setSendErrors(current => ({ ...current, [draftKey]: copy.sendFailed }));
    } finally {
      setSending(false);
    }
  };

  const retryBusy = runningTurn || busy || employeeBusy || sending || modelSaving || sessionBusy || historyLoading;
  const canRetry = (turn: TurnRecord) => !retryBusy && workspaceOpen
    && selectedPosition?.id === turn.positionId && engineAvailability[turn.engine].ready
    && modelConfig?.connection?.status !== "invalid" && (!sessionMode || selectedSession?.status === "active");
  const retry = async (turn: TurnRecord) => {
    if (!canRetry(turn) || sendingRef.current.has(draftKey)) return;
    setSending(true);
    try {
      await onCreateTurn({
        positionId: turn.positionId,
        engine: turn.engine,
        input: turn.input,
        retryOf: turn.id,
      });
    } catch {
      setSendErrors(current => ({ ...current, [draftKey]: copy.sendFailed }));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="owb-turn-panel owb-panel" aria-label={t("turn.panelAria")}>
      <header className="owb-turn-panel__header owb-panel-head">
        <div className="owb-conversation-identity">
          {selectedPosition ? <PositionAvatar id={selectedPosition.id} name={selectedPosition.name} sources={avatarUrls} className="owb-conversation-avatar" /> : <span className="owb-conversation-avatar" aria-hidden="true"><MessagesSquare size={20} /></span>}
          <div className="owb-conversation-identity__copy">
            <h2>{selectedPosition?.name ?? t("turn.title")}</h2>
            {selectedPosition && selectedSession ? <p>{copy.session} {selectedSession.sessionId.slice(-8)}</p> : null}
          </div>
        </div>
        <div className="owb-conversation-header-actions">
          {selectedPosition ? (
            engineLocked ? (
              <EngineBadge engine={engine} />
            ) : (
              <EngineSelect
                engines={TURN_ENGINES}
                engineAvailability={engineAvailability}
                value={engine}
                disabled={busy || employeeBusy || sending || modelSaving}
                onChange={(next) => onSelectEngine?.(next)}
              />
            )
          ) : null}
          {selectedPosition && sessions && onSelectSession ? <Popover trigger="click" placement="bottomRight" open={active && historyOpen} onOpenChange={setHistoryOpen} title={copy.history}
            content={<div className="owb-session-history">{sessions.length ? sessions.map(session => <button type="button" key={session.sessionId}
              className={session.sessionId === selectedSessionId ? "is-selected" : ""}
              aria-current={session.sessionId === selectedSessionId ? "true" : undefined}
              onClick={() => { onSelectSession(session.sessionId); setHistoryOpen(false); }}>
                <span>{new Date(session.createdAt).toLocaleString()}</span><small>{session.sessionId.slice(-8)} · {session.status === "active" ? copy.currentSession : t("turn.sessionReadOnly")}</small>
            </button>) : copy.unavailableHistory}</div>}>
            <Button type="text" size="small" aria-label={copy.history} title={copy.history} icon={<History size={16} aria-hidden="true" />} />
          </Popover> : null}
          {onToggleFocus ? <Button type="text" size="small" aria-label={focused ? copy.exitFocus : copy.focus} title={focused ? copy.exitFocus : copy.focus} aria-pressed={focused}
            icon={focused ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />} onClick={onToggleFocus}>{focused ? copy.exitFocus : null}</Button> : null}
        </div>
      </header>

      <TurnThread
        turns={turns}
        loading={historyLoading || sessionBusy}
        onEdit={edit}
        viewportMemory={conversationMemory.viewports}
        retrying={retryBusy}
        emptyPrompt={selectedPosition ? t("turn.emptySelected") : !workspaceOpen ? t("project.welcomeTitle") : positions.length === 0 ? t("turn.emptyAddEmployee") : t("turn.emptyChooseEmployee")}
        emptyDescription={selectedPosition ? t("turn.emptySelectedBody") : !workspaceOpen ? t("turn.emptyOpenFirst") : positions.length === 0 ? t("turn.emptyAddEmployeeBody") : t("turn.emptyChooseEmployeeBody")}
        canRetry={canRetry}
        onRetry={(turn) => void retry(turn)}
        onVerdict={onVerdictTurn === undefined ? undefined : (turn, decision, reason) => void onVerdictTurn(turn, decision, reason)}
        decidedApprovalIds={decidedApprovalIds}
        scrollKey={draftKey}
      />

      {sendErrors[draftKey] ? <p role="alert" className="owb-conversation-error">{sendErrors[draftKey]}</p> : null}
      {selectedPosition ? <TurnComposer
        sendShortcut={sendShortcut}
        options={active ? <ConversationOptions
          config={modelConfig} saving={modelSaving} disabled={runningTurn || busy || employeeBusy || sending || sessionBusy}
          loading={modelLoading} error={modelError} notice={modelNotice} onReload={onReloadModel} running={runningTurn || employeeBusy}
          session={selectedSession} turns={turns} onModel={onSelectModel} onContext={onSetSessionContext}
          onRotate={onRotateSession}
        /> : undefined}
        value={input}
        placeholder={selectedPosition ? t("turn.composeTo", { name: selectedPosition.name }) : t("turn.composePlaceholder")}
        disabledReason={disabledReason}
        disabledSummary={disabledState?.summary}
        disabledDiagnostic={disabledState?.diagnostic}
        availabilityCheck={disabledState?.canRecheck ? availabilityCheck : undefined}
        primaryAction={engine === "qoder" && engineAvailability.qoder.loginRequired === true ? qoderLogin?.action : undefined}
        linkAction={engine === "qoder" && engineAvailability.qoder.loginRequired === true ? qoderLogin?.link : undefined}
        primaryFeedback={engine === "qoder" && engineAvailability.qoder.loginRequired === true ? qoderLogin?.feedback ?? null : undefined}
        diagnosticKey={`${selectedPositionId}:${selectedSessionId ?? ""}:${engine}`}
        running={runningTurn}
        cancelling={stopping}
        canCancel={selectedPosition !== null}
        onChange={setInput}
        onSend={dispatchTurn}
        onCancel={requestStop}
      /> : null}
      <Modal open={editRequest?.key === draftKey} title={copy.replaceTitle} okText={copy.replace} cancelText={copy.keep}
        onCancel={() => setEditRequest(null)} onOk={() => {
          if (editRequest?.key === draftKey) setInput(editRequest.text);
          setEditRequest(null); document.getElementById("owb-turn-input")?.focus();
        }}><p>{copy.replaceBody}</p></Modal>
    </section>
  );
}
