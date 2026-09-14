import { useState, type FormEvent } from "react";
import { Button, Input, Popover, Select, Switch } from "antd";
import { CircleHelp, Gauge, Layers3 } from "lucide-react";
import { useT } from "@roleweave/ui";
import { isQoderModelId } from "@roleweave/shared/model-selection";
import type { EmployeeModelConfig, EmployeeModelConnection, EmployeeModelOption, WorkbenchSession } from "@roleweave/shared";
import type { TurnRecord } from "./types";
import "./model-connection.css";

function ConnectionDetails({ connection }: { connection: EmployeeModelConnection }) {
  const t = useT();
  const source = connection.kind === "unknown"
    ? t("model.connection.qoderConfigured")
    : t(`model.connection.source.${connection.source}`);
  return <div className="owb-model-connection__details">
    <dl>
      <div><dt>{t("model.connection.source")}</dt><dd>{source}</dd></div>
      <div><dt>{t("model.connection.kind")}</dt><dd>{t(`model.connection.kind.${connection.kind}`)}</dd></div>
      <div><dt>{t("model.billing")}</dt><dd>{t(`model.billing.${connection.billing}`)}</dd></div>
      {connection.endpointHost ? <div><dt>{t("model.connection.host")}</dt><dd>{connection.endpointHost}</dd></div> : null}
      <div><dt>{t("model.connection.status")}</dt><dd>{t(`model.connection.status.${connection.status}`)}</dd></div>
    </dl>
    {connection.status === "invalid" ? <p className="owb-model-connection__error" role="alert">{connection.message || t("model.connection.invalid")}</p> : null}
  </div>;
}

function ConnectionSummary({ connection }: { connection: EmployeeModelConnection }) {
  const t = useT();
  const source = connection.kind === "unknown"
    ? t("model.connection.qoderConfigured")
    : t(`model.connection.source.${connection.source}`);
  return <>{source} · {t(`model.billing.${connection.billing}`)}</>;
}

function CustomModelEntry({ onModel }: { onModel: (model: string) => void | Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = value.trim();
    if (!isQoderModelId(model)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setValue("");
    setOpen(false);
    void onModel(model);
  };
  return <div className="owb-model-menu__custom">
    <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={setOpen} title={t("model.customTitle")} content={
      <form className="owb-model-custom-form" onSubmit={submit}>
        <label htmlFor="owb-custom-model-id">{t("model.customLabel")}</label>
        <Input id="owb-custom-model-id" value={value} autoComplete="off" aria-invalid={invalid}
          placeholder={t("model.customPlaceholder")} onChange={(event) => { setValue(event.target.value); setInvalid(false); }} />
        <p>{t("model.customHelp")}</p>
        {invalid ? <p className="owb-model-custom-form__error" role="alert">{t("model.customInvalid")}</p> : null}
        <Button htmlType="submit" type="primary" size="small">{t("model.customApply")}</Button>
      </form>
    }>
      <Button type="text" size="small" onMouseDown={(event) => event.preventDefault()}>{t("model.useConfigured")}</Button>
    </Popover>
  </div>;
}

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
  // The latest completed turn is authoritative. Do not surface an older
  // receipt when the newest durable turn deliberately has no context.
  const latest = completed.at(-1)?.threadContext;
  const enabled = session?.threadContextEnabled !== false;
  const partial = reported.length < completed.length;
  const connection = config?.connection;
  const connectionInvalid = connection?.status === "invalid";
  const followsLocalConfig = config?.source === "local-config"
    || connection?.source === "local-config" || connection?.source === "environment";
  const options = config?.options.map((model) => ({
    value: model.id,
    label: model.id === "provider-default"
      ? t(followsLocalConfig ? "model.localConfigDefault" : "model.agentDefault")
      : model.name,
    search: [model.name, model.id, model.resolvedModel].filter(Boolean).join(" "),
    model,
  }));
  const modelDetail = (model: EmployeeModelOption) => {
    const details: string[] = [];
    if (model.resolvedModel) details.push(t("model.resolvedModel", { model: model.resolvedModel }));
    else if (model.id !== "provider-default") details.push(t("model.modelId", { model: model.id }));
    if (model.connectionLabel) details.push(model.connectionLabel);
    const billing = model.billing ?? connection?.billing;
    if (billing) details.push(t(`model.billing.${billing}`));
    // A gateway can point any alias at any upstream model. Do not attach an
    // inferred economy/default claim to an operator's custom connection.
    if ((!connection || connection.kind === "official") && model.id !== "provider-default" && !model.connectionLabel) {
      details.push(t(`model.tier.${model.tier}`));
    }
    return details;
  };
  return <div className="owb-conversation-options owb-model-connection">
    {config ? <div className="owb-model-connection__model">
      <Select className="owb-model-picker" size="small" variant="borderless"
        aria-label={t("model.select")} showSearch={{ optionFilterProp: "search" }}
        value={config.selected} options={options} loading={saving}
        disabled={disabled || saving || connectionInvalid || !config.editable || !onModel}
        popupMatchSelectWidth={300}
        onChange={(value) => void onModel?.(value)}
        optionRender={(option) => {
          const model = option.data.model as EmployeeModelOption | undefined;
          if (!model) return option.label;
          const details = modelDetail(model);
          return <div className="owb-model-choice">
            <span>{option.label}{option.value === config.recommended ? <small>{t("model.recommended")}</small> : null}</span>
            {details.length ? <p>{details.join(" · ")}</p> : null}
          </div>;
        }}
        popupRender={(menu) => <div className="owb-model-menu">
          <div className="owb-model-menu__heading"><strong>{t("model.menuTitle")}</strong>
            {connection ? <span><ConnectionSummary connection={connection} /></span> : null}
          </div>
          {menu}
          {config.allowCustomModel && !connectionInvalid && onModel ? <CustomModelEntry onModel={onModel} /> : null}
          <p>{t("model.switchHint")}</p>
        </div>}
      />
      {connection ? <Popover trigger="click" placement="topRight" title={t("model.connectionDetails")} content={<ConnectionDetails connection={connection} />}>
        <Button className="owb-model-connection__summary" type="text" size="small" icon={<CircleHelp size={13} />} aria-label={t("model.connectionDetails")}>
          <ConnectionSummary connection={connection} />
        </Button>
      </Popover> : null}
      {connectionInvalid ? <p className="owb-model-connection__error" role="alert">{connection.message || t("model.connection.invalid")}</p> : null}
    </div> : <span className="owb-model-picker__pending">{t("model.agentDefault")}</span>}
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
