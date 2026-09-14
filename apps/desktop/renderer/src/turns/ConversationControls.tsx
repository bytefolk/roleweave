import { Button as AntButton, Select as AntSelect } from "antd";
import { Plus, RefreshCw } from "lucide-react";
import type { WorkbenchSession } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import { EngineSelect, TURN_ENGINES, useEngineLabel } from "./engine-select";
import { PositionMention } from "./PositionMention";
import type { PositionMentionOption, TurnEngine, TurnEngineAvailability } from "./types";

export interface ConversationControlsProps {
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  engine: TurnEngine;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  sessions?: WorkbenchSession[];
  selectedSessionId?: string | null;
  busy?: boolean;
  employeeBusy?: boolean;
  sending?: boolean;
  sessionBusy?: boolean;
  onSelectPosition: (positionId: string) => void;
  onSelectEngine: (engine: TurnEngine) => void;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void | Promise<void>;
  onRotateSession?: (sessionId: string) => void | Promise<void>;
}

interface SessionPickerProps {
  workspaceOpen: boolean;
  selectedPositionId: string | null;
  sessions: WorkbenchSession[];
  selectedSessionId: string | null;
  sessionBusy: boolean;
  busy: boolean;
  employeeBusy: boolean;
  sending: boolean;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void | Promise<void>;
  onRotateSession?: (sessionId: string) => void | Promise<void>;
}

/** A visible session picker makes continuation versus a fresh conversation an
 * explicit decision. It is deliberately a compact toolbar control, not a
 * drawer or a hidden configuration panel. */
function SessionPicker({
  workspaceOpen,
  selectedPositionId,
  sessions,
  selectedSessionId,
  sessionBusy,
  busy,
  employeeBusy,
  sending,
  onSelectSession,
  onCreateSession,
  onRotateSession,
}: SessionPickerProps) {
  const t = useT();
  const activeSession = sessions.find((session) => session.status === "active") ?? null;
  const controlsDisabled = sessionBusy || busy || employeeBusy || sending;
  return (
    <div className="owb-conversation-session" aria-label={t("turn.positionSessions")}>
      <label>
        <span className="owb-turn-control__label">{t("turn.session")}</span>
        <AntSelect
          classNames={{ popup: { root: "owb-conversation-select-popup" } }}
          aria-label={t("turn.pickSession")}
          value={selectedSessionId ?? undefined}
          placeholder={t("turn.noSession")}
          disabled={!workspaceOpen || !selectedPositionId || sessionBusy || sessions.length === 0}
          onChange={(next) => {
            if (next) onSelectSession?.(next);
          }}
          options={sessions.map((session, index) => ({
            value: session.sessionId,
            label: t("turn.sessionOption", {
              kind: session.status === "active" ? t("turn.sessionKindActive") : t("turn.sessionKindReadonly"),
              index: sessions.length - index,
            }),
          }))}
        />
      </label>
      {activeSession ? (
        <AntButton
          disabled={controlsDisabled}
          onClick={() => void onRotateSession?.(activeSession.sessionId)}
          icon={<RefreshCw aria-hidden="true" size={13} />}
        >
          {t("turn.rotate")}
        </AntButton>
      ) : (
        <AntButton
          disabled={!workspaceOpen || !selectedPositionId || sessionBusy}
          onClick={() => void onCreateSession?.()}
          icon={<Plus aria-hidden="true" size={13} />}
        >
          {t("turn.newSession")}
        </AntButton>
      )}
    </div>
  );
}

/** Conversation scope is intentionally separate from the message stream. The
 * user can see who will receive the task, which local session will continue,
 * and which host will execute it before they write anything. */
export function ConversationControls({
  workspaceOpen,
  positions,
  selectedPositionId,
  engine,
  engineAvailability,
  sessions,
  selectedSessionId = null,
  busy = false,
  employeeBusy = false,
  sending = false,
  sessionBusy = false,
  onSelectPosition,
  onSelectEngine,
  onSelectSession,
  onCreateSession,
  onRotateSession,
}: ConversationControlsProps) {
  const t = useT();
  const engineLabel = useEngineLabel();
  const modelPinnable = engineAvailability[engine].modelPinnable === true;
  const pinnedModel = engineAvailability[engine].model;
  const sessionMode = sessions !== undefined;

  return (
    <section className="owb-conversation-controls" aria-label={t("turn.sessionSettings")}>
      <div className="owb-conversation-controls__fields">
        <PositionMention
          positions={positions}
          value={selectedPositionId}
          disabled={!workspaceOpen || positions.length === 0}
          onChange={onSelectPosition}
        />

        {sessionMode ? (
          <SessionPicker
            workspaceOpen={workspaceOpen}
            selectedPositionId={selectedPositionId}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionBusy={sessionBusy}
            busy={busy}
            employeeBusy={employeeBusy}
            sending={sending}
            onSelectSession={onSelectSession}
            onCreateSession={onCreateSession}
            onRotateSession={onRotateSession}
          />
        ) : null}

        <label className="owb-turn-engine">
          <span className="owb-turn-control__label">Agent Host</span>
          <EngineSelect
            engines={TURN_ENGINES}
            engineAvailability={engineAvailability}
            value={engine}
            disabled={!workspaceOpen}
            onChange={onSelectEngine}
          />
          {modelPinnable ? (
            <span className="owb-turn-engine__model" title={pinnedModel === undefined
                ? t("turn.modelUnpinned", { engine: engineLabel(engine) })
                : t("turn.modelPinned", { model: pinnedModel })}>
              {pinnedModel === undefined
                ? t("turn.modelUnpinned", { engine: engineLabel(engine) })
                : t("turn.modelPinned", { model: pinnedModel })}
            </span>
          ) : null}
        </label>
      </div>
    </section>
  );
}
