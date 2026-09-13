import { Switch } from "antd";
import type { WorkbenchSession } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import type { TurnRecord } from "./types";

export interface SessionContextProps {
  session: WorkbenchSession;
  turnsCount: number;
  lastContext?: NonNullable<TurnRecord["threadContext"]>;
  disabled?: boolean;
  onSetContext?: (sessionId: string, enabled: boolean) => void | Promise<void>;
}

/** A small, inspectable record of what the selected session carries forward.
 * It stays adjacent to the composer because it changes how the next task is
 * executed, while raw receipts remain behind an intentional disclosure. */
export function SessionContext({
  session,
  turnsCount,
  lastContext,
  disabled = false,
  onSetContext,
}: SessionContextProps) {
  const t = useT();
  const enabled = session.threadContextEnabled !== false;
  return (
    <section className="owb-thread-context owb-session-context" aria-label={t("turn.contextLabel")}>
      <div className="owb-session-context__summary">
        <span className="owb-session-context__label">{t("turn.contextLabel")}</span>
        <Switch
          size="small"
          aria-label={t("turn.contextToggle")}
          checked={enabled}
          disabled={disabled || session.status !== "active"}
          onChange={(next) => void onSetContext?.(session.sessionId, next)}
        />
        <span className="owb-session-context__state">
          {enabled ? t("turn.contextOn") : t("turn.contextOff")}
        </span>
      </div>
      <div className="owb-session-context__usage">
        {lastContext ? (
          <details>
            <summary>{t("turn.contextLast", { count: lastContext.sourceTurnCount, bytes: lastContext.contextBytes })}</summary>
            <p>{t("turn.contextOmitted", { count: lastContext.omittedTurnCount })}</p>
            <code>{lastContext.contextDigest}</code>
            <pre>{lastContext.summary || t("turn.contextEmpty")}</pre>
          </details>
        ) : (
          <span>{t(turnsCount === 0 ? "turn.contextUnused" : "turn.contextUnrecorded")}</span>
        )}
      </div>
    </section>
  );
}
