import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input, Popover, Select, Switch } from "antd";
import { Check, CircleHelp, Gauge, Layers3, RefreshCw } from "lucide-react";
import { useT } from "@roleweave/ui";
import { isQoderModelId } from "@roleweave/shared/model-selection";
import type { EmployeeModelConfig, EmployeeModelConnection, EmployeeModelOption, WorkbenchSession } from "@roleweave/shared";
import type { TurnRecord } from "./types";
import { useConversationCopy } from "../locales/conversation";
import "./model-connection.css";

const popoverClassNames = { root: "owb-conversation-popover" };
// Context updates cross rc-trigger's cached dropdown content, so an already
// open editor still sees the current guard and callback when Select closes.
const ModelSelectionContext = createContext<{
  disabled: boolean;
  onModel?: (model: string) => void | Promise<void>;
}>({ disabled: true });

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
    {connection.status === "invalid" ? <p className="owb-model-connection__error" role="alert">{t("model.connection.invalid")}</p> : null}
  </div>;
}

function ConnectionSummary({ connection }: { connection: EmployeeModelConnection }) {
  const t = useT();
  const source = connection.kind === "unknown"
    ? t("model.connection.qoderConfigured")
    : t(`model.connection.source.${connection.source}`);
  return <>{source} · {t(`model.billing.${connection.billing}`)}</>;
}

function CustomModelEntry() {
  const t = useT();
  const selection = useContext(ModelSelectionContext);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const { disabled } = selection;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The closing Popover can still retain a form's previous event handler.
    const { disabled: currentlyDisabled, onModel } = currentSelection.current;
    if (currentlyDisabled || !onModel) return;
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
    {/* This nested editor sits above its Select popup (z-index 1050). */}
    <Popover classNames={popoverClassNames} trigger="click" placement="topLeft" autoAdjustOverflow zIndex={1060} fresh open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)} title={t("model.customTitle")} content={
      <form className="owb-model-custom-form" onSubmit={submit}>
        <label htmlFor="owb-custom-model-id">{t("model.customLabel")}</label>
        <Input id="owb-custom-model-id" value={value} disabled={disabled} autoComplete="off" aria-invalid={invalid}
          placeholder={t("model.customPlaceholder")} onChange={(event) => { setValue(event.target.value); setInvalid(false); }} />
        <p>{t("model.customHelp")}</p>
        {invalid ? <p className="owb-model-custom-form__error" role="alert">{t("model.customInvalid")}</p> : null}
        <Button htmlType="submit" type="primary" size="small" disabled={disabled}>{t("model.customApply")}</Button>
      </form>
    }>
      <Button type="text" size="small" disabled={disabled} onMouseDown={(event) => event.preventDefault()}>{t("model.useConfigured")}</Button>
    </Popover>
  </div>;
}

export function ConversationOptions({ config, saving, disabled, loading = false, running = false, error, notice, onReload, session, turns, onModel, onContext }: {
  config?: EmployeeModelConfig; saving: boolean; disabled: boolean;
  loading?: boolean; running?: boolean; error?: string; notice?: string; onReload?: () => void;
  session: WorkbenchSession | null; turns: TurnRecord[];
  onModel?: (model: string) => void | Promise<void>;
  onContext?: (sessionId: string, enabled: boolean) => void | Promise<void>;
}) {
  const t = useT();
  const copy = useConversationCopy();
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
  const modelOptions = config?.options.map((model) => ({
    value: model.id,
    label: model.id === "provider-default"
      ? t(followsLocalConfig ? "model.localConfigDefault" : "model.agentDefault")
      : model.name,
    search: [model.name, model.id, model.resolvedModel].filter(Boolean).join(" "),
    model,
  }));
  const groupBilling = new Map<NonNullable<EmployeeModelOption["group"]>, NonNullable<EmployeeModelOption["billing"]>>();
  const options = modelOptions && [
    ...modelOptions.filter((option) => !option.model.group),
    ...(["tiers", "models", "custom"] as const).flatMap((group) => {
      const grouped = modelOptions.filter((option) => option.model.group === group);
      const billing = grouped[0]?.model.billing;
      // Routing tiers and concrete catalog models often share a billing
      // source. State it once per group; custom overrides stay beside the ID.
      if (group !== "custom" && billing && grouped.every((option) => option.model.billing === billing)) groupBilling.set(group, billing);
      const billingLabel = groupBilling.get(group);
      const label = t(`model.group.${group}`) + (billingLabel && billingLabel !== connection?.billing ? ` · ${t(`model.billing.${billingLabel}`)}` : "");
      return grouped.length ? [{ label, options: grouped }] : [];
    }),
  ];
  const modelDetail = (model: EmployeeModelOption) => {
    const details: string[] = [];
    const catalogChoice = model.group === "tiers" || model.group === "models";
    if (model.resolvedModel && model.resolvedModel !== model.name) details.push(`${copy.mapping}: ${model.resolvedModel}`);
    else if (!model.resolvedModel && !catalogChoice && model.id !== "provider-default" && model.id !== model.name) details.push(t("model.modelId", { model: model.id }));
    if (model.connectionLabel) details.push(model.connectionLabel);
    // The menu/details already describe the shared connection. A row only
    // needs billing text when the provider explicitly reports a difference.
    const presentedBilling = (model.group && groupBilling.get(model.group)) || connection?.billing;
    if (model.billing && model.billing !== presentedBilling) details.push(t(`model.billing.${model.billing}`));
    // A gateway can point any alias at any upstream model. Do not attach an
    // inferred economy/default claim to an operator's custom connection.
    if (!catalogChoice && model.group !== "custom" && (!connection || connection.kind === "official") && model.id !== "provider-default" && !model.connectionLabel) {
      details.push(t(`model.tier.${model.tier}`));
    }
    return details;
  };
  const unavailable = loading ? copy.modelLoading : saving ? copy.modelSaving : running ? copy.modelRunning
    : error ? error : !config ? copy.modelMissing : connectionInvalid ? t("model.connection.invalid") : !config.editable || !onModel ? copy.modelReadonly : undefined;
  const modelDisabled = disabled || saving || loading || running || Boolean(error) || connectionInvalid || !config?.editable || !onModel;
  return <div className="owb-conversation-options owb-model-connection">
    <span className="owb-model-picker__label owb-sr-only">{copy.model}</span>
    {config ? <div className="owb-model-connection__model">
      <ModelSelectionContext.Provider value={{ disabled: modelDisabled, onModel }}>
      <Select className="owb-model-picker" size="small" variant="borderless"
        classNames={{ popup: { root: "owb-conversation-select-popup owb-model-select-popup" } }}
        aria-label={t("model.select")} title={unavailable} showSearch={{ optionFilterProp: "search" }}
        value={config.selected} options={options} loading={saving || loading}
        disabled={modelDisabled}
        popupMatchSelectWidth={300}
        placement="topLeft" listHeight={240}
        menuItemSelectedIcon={<Check aria-hidden="true" size={14} strokeWidth={2} />}
        onChange={(value) => void onModel?.(value)}
        optionRender={(option) => {
          const model = "model" in option.data ? option.data.model : undefined;
          if (!model) return option.label;
          const details = modelDetail(model);
          return <div className="owb-model-choice">
            <span>{option.label}{option.value === config.recommended ? <small>{t("model.recommended")}</small> : null}</span>
            {details.length ? <p>{details.join(" · ")}</p> : null}
          </div>;
        }}
        popupRender={(menu) => <div className="owb-model-menu">
          <div className="owb-model-menu__heading"><strong>{t("model.menuTitle")}</strong>
            {config.catalogStatus && onReload ? <Button type="text" size="small" className="owb-model-menu__refresh"
              icon={<RefreshCw aria-hidden="true" size={13} />} aria-label={t("model.catalogRefresh")} title={t("model.catalogRefresh")}
              loading={loading} disabled={disabled || saving || loading || running} onMouseDown={(event) => event.preventDefault()} onClick={onReload} /> : null}
          </div>
          {config.catalogStatus && config.catalogStatus !== "ready" ? <p className="owb-model-menu__catalog-status" role="status">{t(`model.catalog.${config.catalogStatus}`)}</p> : null}
          {connection ? <div className="owb-model-menu__connection"><ConnectionSummary connection={connection} /></div> : null}
          {menu}
          {config.allowCustomModel && !connectionInvalid && onModel ? <CustomModelEntry /> : null}
          <p>{t("model.switchHint")}</p>
        </div>}
      />
      </ModelSelectionContext.Provider>
      {connection ? <Popover classNames={popoverClassNames} trigger="click" placement="topRight" title={t("model.connectionDetails")} content={<ConnectionDetails connection={connection} />}>
        <Button className="owb-model-connection__summary" type="text" size="small" icon={<CircleHelp aria-hidden="true" size={14} />} aria-label={t("model.connectionDetails")} title={t("model.connectionDetails")} />
      </Popover> : null}
    </div> : <span className="owb-model-picker__pending">{loading ? copy.modelLoading : t("model.agentDefault")}</span>}
    <div className="owb-conversation-options__tools">
    <Popover classNames={popoverClassNames} trigger="click" placement="topRight" title={t("model.contextTitle")} content={
      <div className="owb-context-details">
        <div className="owb-conversation-popover__section">
          <div className="owb-context-details__toggle"><span>{t("model.history")}</span><Switch size="small"
            aria-label={t("model.history")} checked={enabled} disabled={disabled || !session || !onContext}
            onChange={(checked) => { if (session) void onContext?.(session.sessionId, checked); }} /></div>
          <p>{t("model.contextLimit")}</p>
          <p>{t("model.contextOffHint")}</p>
        </div>
        <div className="owb-conversation-popover__section">
          <p className="owb-context-details__stat">{latest ? t("model.lastContext", { count: latest.sourceTurnCount, bytes: latest.contextBytes.toLocaleString() }) : t("model.noContextReceipt")}</p>
          {latest?.truncated ? <p className="owb-context-details__warning">{t("model.contextTrimmed", { count: latest.omittedTurnCount })}</p> : null}
        </div>
        <div className="owb-conversation-popover__section"><p>{t("model.contextScope")}</p></div>
      </div>
    }><Button type="text" size="small" icon={<Layers3 size={13} />} aria-label={t("model.contextTitle")}>{t(enabled ? "model.contextOn" : "model.contextOff")}</Button></Popover>
    <Popover classNames={popoverClassNames} trigger="click" placement="topRight" title={t("model.usageTitle")} content={
      <div className="owb-context-details"><p className="owb-context-details__stat">{t("model.usageCount", { count: reported.length, total: completed.length })}</p>
        <p>{t("model.usageHint")}</p>
        {completed.at(-1)?.model ? <p>{t("model.lastModel", { model: completed.at(-1)!.model! })}</p> : null}
      </div>
    }><Button type="text" size="small" icon={<Gauge size={13} />} aria-label={t("model.usageTitle")}>
      {reported.length ? `${total.toLocaleString()}${partial ? "+" : ""} tokens` : t("model.usageUnknown")}
    </Button></Popover>
    </div>
    {(unavailable || notice) ? <div className={`owb-model-picker__state${error ? " is-error" : ""}`}>
      <span role={error ? "alert" : undefined}>{unavailable ?? notice}</span>
      {(error || (!config && !loading)) && onReload ? <Button type="link" size="small" onClick={onReload}>{copy.modelRetry}</Button> : null}
    </div> : null}
  </div>;
}
