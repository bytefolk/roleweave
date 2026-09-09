import { Select as AntSelect } from "antd";
import { AtSign } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { PositionMentionOption } from "./types";

export interface PositionMentionProps {
  positions: PositionMentionOption[];
  value: string | null;
  disabled?: boolean;
  onChange: (positionId: string) => void;
}

/** Position addressability control. Options come only from the applied org tree. */
export function PositionMention({
  positions,
  value,
  disabled = false,
  onChange,
}: PositionMentionProps) {
  const t = useT();
  return (
    <label className="owb-position-mention">
      <span className="owb-turn-control__label">{t("turn.position")}</span>
      <span className="owb-position-mention__field">
        <AtSign aria-hidden="true" size={14} />
        <AntSelect
          aria-label={t("turn.pickPositionAria")}
          value={value ?? undefined}
          placeholder={t("turn.pickPositionPh")}
          disabled={disabled}
          onChange={(next) => {
            if (next) onChange(next);
          }}
          options={positions.map((position) => ({
            value: position.id,
            label: position.name,
          }))}
        />
      </span>
    </label>
  );
}
