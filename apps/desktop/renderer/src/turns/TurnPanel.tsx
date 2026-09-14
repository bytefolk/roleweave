import { useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import type { EmployeeModelConfig, WorkbenchSession } from "@roleweave/shared";
import { ConversationOptions } from "./ConversationOptions";
import { useT } from "@roleweave/ui";
import { TurnComposer } from "./TurnComposer";
import { useEngineLabel } from "./engine-select";
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
  modelConfig?: EmployeeModelConfig;
  avatarUrls?: Record<string, string>;
  modelSaving?: boolean;
  onSelectModel?: (model: string) => void | Promise<void>;
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  engine: TurnEngine;
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
  /** An employee's agent is bound at creation time, not selected per turn. */
  onSelectEngine?: (engine: TurnEngine) => void;
  onCreateTurn: (request: CreateTurnRequest) => void | boolean | Promise<void | boolean>;
  /** Operator interrupt for the in-flight turn of the selected position. */
  onCancelTurn?: (positionId: string) => void | Promise<void>;
  /** Operator verdict for a turn settled as engine.approval_required (#25 Slice B). */
  onVerdictTurn?: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void | Promise<void>;
  /** Approval ids whose verdict was already dispatched this session; their
   * cards settle into a decided state (no duplicate verdicts). */
  decidedApprovalIds?: ReadonlySet<string>;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void | Promise<void>;
  onRotateSession?: (sessionId: string) => void | Promise<void>;
  onSetSessionContext?: (sessionId: string, enabled: boolean) => void | Promise<void>;
}

export function TurnPanel({
  modelConfig,
  avatarUrls,
  modelSaving = false,
  onSelectModel,
  onSetSessionContext,
  workspaceOpen,
  positions,
  selectedPositionId,
  engine,
  engineAvailability,
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
}: TurnPanelProps) {
  const t = useT();
  const engineLabel = useEngineLabel();
  const draftKey = `${selectedPositionId ?? ""}:${selectedSessionId ?? ""}`;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingKeys, setSendingKeys] = useState<Record<string, boolean>>({});
  const sendingRef = useRef(new Set<string>());
  const input = drafts[draftKey] ?? "";
  const sending = sendingKeys[draftKey] === true;
  const setInput = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const setSending = (value: boolean) => {
    if (value) sendingRef.current.add(draftKey); else sendingRef.current.delete(draftKey);
    setSendingKeys((current) => ({ ...current, [draftKey]: value }));
  };
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

  const disabledReason = useMemo(() => {
    if (modelSaving) return t("model.saving");
    if (!workspaceOpen) return t("turn.emptyOpenFirst");
    if (positions.length === 0) return t("turn.noPositions");
    if (!selectedPosition) return t("turn.emptyPick");
    if (sessionMode && sessionBusy) return t("turn.sessionPreparing");
    if (sessionMode && !selectedSession) return t("turn.emptySession");
    if (sessionMode && selectedSession?.status !== "active") return t("turn.sessionReadOnly");
    if (modelConfig?.connection?.status === "invalid") return modelConfig.connection.message ?? t("turn.engineNotReady", { engine: engineLabel(engine) });
    if (!engineAvailability[engine].ready) {
      return engineAvailability[engine].reason ?? t("turn.engineNotReady", { engine: engineLabel(engine) });
    }
    if (busy || employeeBusy || sending || sessionBusy) return t("turn.updating");
    return null;
  }, [busy, employeeBusy, engine, engineAvailability, engineLabel, modelConfig, modelSaving, positions.length, selectedPosition, selectedSession, sending, sessionBusy, sessionMode, t, workspaceOpen]);

  const dispatchTurn = async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || disabledReason || !selectedPosition || sendingRef.current.has(draftKey)) return;
    setSending(true);
    try {
      const created = await onCreateTurn({ positionId: selectedPosition.id, engine, input: trimmed });
      if (created !== false) setDrafts((current) => current[draftKey] === input ? { ...current, [draftKey]: "" } : current);
    } finally {
      setSending(false);
    }
  };

  const retry = async (turn: TurnRecord) => {
    if (busy || employeeBusy || sendingRef.current.has(draftKey) || !workspaceOpen || !engineAvailability[turn.engine].ready || modelConfig?.connection?.status === "invalid") return;
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
        <div className="owb-conversation-identity">
          {selectedPosition ? <PositionAvatar id={selectedPosition.id} name={selectedPosition.name} sources={avatarUrls} className="owb-conversation-avatar" /> : <span className="owb-conversation-avatar" aria-hidden="true"><MessagesSquare size={20} /></span>}
          <div className="owb-conversation-identity__copy">
            <h2>{selectedPosition?.name ?? t("turn.title")}</h2>
            <p>{selectedPosition ? engineLabel(engine) : t("turn.pickEmployeeHint")}</p>
          </div>
        </div>
        {selectedPosition ? <span className="owb-conversation-kind">{t("turn.title")}</span> : null}
      </header>

      <TurnThread
        turns={turns}
        retrying={busy || employeeBusy || sending}
        // The thread has one stable empty-state message. Concrete blockers
        // stay next to the input so the conversation area never oscillates
        // between "create a session" and "start from a clear task".
        emptyPrompt={selectedPosition ? t("turn.emptySelected") : t("turn.emptyStart")}
        canRetry={(turn) => workspaceOpen && engineAvailability[turn.engine].ready && modelConfig?.connection?.status !== "invalid" && (!sessionMode || selectedSession?.status === "active")}
        onRetry={(turn) => void retry(turn)}
        onVerdict={onVerdictTurn === undefined ? undefined : (turn, decision, reason) => void onVerdictTurn(turn, decision, reason)}
        decidedApprovalIds={decidedApprovalIds}
        scrollKey={`${selectedPositionId ?? ""}:${selectedSessionId ?? ""}`}
      />

      <TurnComposer
        options={selectedPosition && (modelConfig || onSetSessionContext) ? <ConversationOptions
          config={modelConfig} saving={modelSaving} disabled={busy || employeeBusy || sending || sessionBusy}
          session={selectedSession} turns={turns} onModel={onSelectModel} onContext={onSetSessionContext}
        /> : undefined}
        value={input}
        placeholder={selectedPosition ? t("turn.composeTo", { name: selectedPosition.name }) : t("turn.composePlaceholder")}
        disabledReason={disabledReason}
        running={runningTurn}
        cancelling={cancelling}
        canCancel={selectedPosition !== null}
        onChange={setInput}
        onSend={dispatchTurn}
        onCancel={() => {
          if (selectedPosition) return onCancelTurn?.(selectedPosition.id);
        }}
      />
    </section>
  );
}
