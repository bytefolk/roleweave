import { Select as AntSelect } from "antd";
import { useCallback } from "react";
import { useT } from "@roleweave/ui";
import { EngineIcon } from "./engine-icon";
import type { TurnEngine, TurnEngineAvailability } from "./types";

/** The hosts supported by the desktop control plane, in the stable order used
 * everywhere a host picker is shown. Keeping this here prevents the task
 * surface, groups, and hiring flow from slowly acquiring different choices. */
export const TURN_ENGINES: readonly TurnEngine[] = [
  "qoder",
  "claude-code",
  "claude-local",
  "codex",
  "codex-local",
];

const ENGINE_LABEL: Record<TurnEngine, string> = {
  qoder: "Qoder",
  "claude-code": "Claude Code",
  "claude-local": "Claude Code",
  codex: "Codex",
  "codex-local": "Codex",
};

/** Engine brand names are product names, rather than UI copy. Only the local
 * sign-in suffix is translated. */
export function useEngineLabel(): (engine: TurnEngine) => string {
  const t = useT();
  return useCallback(
    (engine: TurnEngine) =>
      engine === "claude-local"
        ? `Claude Code · ${t("turn.claudeLocalSuffix")}`
        : engine === "codex-local"
          ? `Codex · ${t("turn.codexLocalSuffix")}`
          : ENGINE_LABEL[engine],
    [t],
  );
}

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

/** The trigger omits the availability suffix; the popup keeps it, while the
 * control itself remains compact enough for a task-focused toolbar. */
function engineTriggerLabel(engine: TurnEngine, labelOf: (engine: TurnEngine) => string) {
  return (
    <span className="owb-engine-option">
      <EngineIcon engine={engine} />
      {labelOf(engine)}
    </span>
  );
}

/** Shared Agent Host picker. `popupMatchSelectWidth={false}` is intentional:
 * a constrained toolbar must not truncate every choice in its popup. */
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
      classNames={{ popup: { root: "owb-conversation-select-popup" } }}
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
