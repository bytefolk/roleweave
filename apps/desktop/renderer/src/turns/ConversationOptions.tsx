import { Button, Popover, Select, Switch } from "antd";
import { Gauge, Layers3 } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { EmployeeModelConfig, WorkbenchSession } from "@roleweave/shared";
import type { TurnRecord } from "./types";

export function ConversationOptions({ config, saving, disabled, session, turns, onModel, onContext }: {
  config?: EmployeeModelConfig; saving: boolean; disabled: boolean;
  session: WorkbenchSession | null; turns: TurnRecord[];
  onModel?: (model: string) => void | Promise<void>;
  onContext?: (sessionId: string, enabled: boolean) => void | Promise<void>;
}) {
  const t = useT();
  const completed = turns.filter((turn) => !turn.provisional && turn.status !== "running");
  const reported = completed.filter((turn) => turn.totalTokens !== undefined);
  const total = reported.reduce((sum, turn) => sum + turn.totalTokens!, 0);
  const latest = [...completed].reverse().find((turn) => turn.threadContext)?.threadContext;
  const enabled = session?.threadContextEnabled !== false;
  const partial = reported.length < completed.length;
  const options = config?.options.map((m) => ({ value: m.id,
    label: m.tier === "default" && m.id === "provider-default" ? t("model.agentDefault") : m.name,
    search: `${m.name} ${m.id}`,
    tier: m.tier,
  }));
  return <div className="owb-conversation-options">
    {config ? <Select className="owb-model-picker" size="small" variant="borderless"
      aria-label={t("model.select")} showSearch={{ optionFilterProp: "search" }}
      value={config.selected} options={options} loading={saving}
      disabled={disabled || saving || !config.editable || !onModel}
      popupMatchSelectWidth={300}
      onChange={(value) => void onModel?.(value)}
      optionRender={(option) => <div className="owb-model-choice">
        <span>{option.label}{option.value === config.recommended ? <small>{t("model.recommended")}</small> : null}</span>
        <p>{t(`model.tier.${option.data.tier}`)}</p>
      </div>}
      popupRender={(menu) => <div className="owb-model-menu"><strong>{t("model.menuTitle")}</strong>{menu}<p>{t("model.switchHint")}</p></div>}
    /> : <span className="owb-model-picker__pending">{t("model.agentDefault")}</span>}
    <Popover trigger="click" placement="topRight" title={t("model.contextTitle")} content={
      <div className="owb-context-details">
        <div className="owb-context-details__toggle"><span>{t("model.history")}</span><Switch size="small"
          aria-label={t("model.history")} checked={enabled} disabled={disabled || !session || !onContext}
          onChange={(checked) => { if (session) void onContext?.(session.sessionId, checked); }} /></div>
        <p>{t("model.contextLimit")}</p>
        {latest ? <p>{t("model.lastContext", { count: latest.sourceTurnCount, bytes: latest.contextBytes.toLocaleString() })}</p> : <p>{t("model.noContextReceipt")}</p>}
        {latest?.truncated ? <p className="owb-context-details__warning">{t("model.contextTrimmed", { count: latest.omittedTurnCount })}</p> : null}
        <p>{t("model.contextScope")}</p>
      </div>
    }><Button type="text" size="small" icon={<Layers3 size={13} />} aria-label={t("model.contextTitle")}>{t(enabled ? "model.contextOn" : "model.contextOff")}</Button></Popover>
    <Popover trigger="click" placement="topRight" title={t("model.usageTitle")} content={
      <div className="owb-context-details"><p>{t("model.usageCount", { count: reported.length, total: completed.length })}</p>
        <p>{t("model.usageHint")}</p>
        {completed.at(-1)?.model ? <p>{t("model.lastModel", { model: completed.at(-1)!.model! })}</p> : null}
      </div>
    }><Button type="text" size="small" icon={<Gauge size={13} />} aria-label={t("model.usageTitle")}>
      {reported.length ? `${total.toLocaleString()}${partial ? "+" : ""} tokens` : t("model.usageUnknown")}
    </Button></Popover>
  </div>;
}
