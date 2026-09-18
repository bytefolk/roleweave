import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Descriptions, Dropdown, Empty, Modal, Select, Spin } from "antd";
import { MoreHorizontal, Sparkles } from "lucide-react";
import { useT, type PositionCardData } from "@roleweave/ui";
import type { EmployeeModelConfig, WorkspaceInfoResponse } from "@roleweave/shared";
import type { PositionMentionOption } from "../turns/types";
import { DismissPositionDialog } from "./OrgControls";
import { AVATAR_PRESETS, PositionAvatar, type AvatarValue } from "../PositionAvatar";

export type TreeAction = "settings" | "chat" | "memory" | "hire" | "group" | "switch" | "edit";
export function TreeRowMenu({ id, name, children, busy, onAction }: {
  id: string | null; name: string; children?: ReactNode; busy: boolean;
  onAction: (id: string | null, action: TreeAction) => void;
}) {
  const t = useT();
  const menu = { items: [
    // Structural actions come first: a context menu should answer the most
    // likely question for the node it was opened on before offering inspection.
    { key: "hire", label: t(id ? "manage.hireUnder" : "tree.create"), disabled: busy },
    { type: "divider" as const },
    // Record editing leads the per-employee menu: right-click / ellipsis on a
    // row must be able to modify exactly that row's record (#292 drawer), the
    // way a conventional tree's context menu edits the node it was invoked on.
    ...(id ? [{ key: "edit", label: t("profile.edit") }, { key: "chat", label: t("manage.chat") }] : []),
    { key: "settings", label: t(id ? "manage.employeeSettings" : "manage.projectSettings") },
    { key: "memory", label: t("memory.title") },
    { type: "divider" as const },
    { key: "group", label: t("memory.collaborate") },
    ...(!id ? [{ key: "switch", label: t("manage.switchProject"), disabled: busy }] : []),
  ], onClick: ({ key, domEvent }: { key: string; domEvent: { stopPropagation(): void } }) => {
    domEvent.stopPropagation(); onAction(id, key as TreeAction);
  } };
  if (children) return <Dropdown menu={menu} trigger={["contextMenu"]}>{children}</Dropdown>;
  return <span className="owb-tree-more" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <Dropdown menu={menu} trigger={["click"]}><button type="button" aria-label={t("manage.more", { name })} title={t("manage.more", { name })}><MoreHorizontal size={16} /></button></Dropdown>
  </span>;
}

export function EmployeeSettings({ id, positions, targets, isOwner, descendantCount, busy, avatar, onClose, onMove, onDismiss, onMemory, onSaved, onAvatarChange }: {
  id: string; positions: PositionMentionOption[]; targets: PositionMentionOption[]; isOwner: boolean; descendantCount: number; busy: boolean;
  avatar?: AvatarValue;
  onClose: () => void; onMove: (id: string, parent: string | null) => Promise<boolean>;
  onDismiss: (id: string) => Promise<boolean>; onMemory: () => void; onSaved: () => void; onAvatarChange: (value: string) => void;
}) {
  const t = useT();
  const [data, setData] = useState<PositionCardData>();
  const [config, setConfig] = useState<EmployeeModelConfig>();
  const [engine, setEngine] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [avatarGenerating, setAvatarGenerating] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.owb.position(id).then((res) => {
      if (!alive) return;
      if (res.status !== 200) throw new Error();
      const body = res.body as { position: PositionCardData; modelConfig?: EmployeeModelConfig; agentEngine?: string };
      setData(body.position); setParent(body.position.reportTo); setConfig(body.modelConfig); setEngine(body.agentEngine ?? "—");
    }).catch(() => { if (alive) setError(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);
  const chooseModel = async (model: string) => {
    if (!window.owb.setPositionModel) return;
    setSaving(true); setError(false);
    try {
      const res = await window.owb.setPositionModel({ positionId: id, model });
      if (res.status !== 200) throw new Error();
      setConfig(res.body); onSaved();
    } catch { setError(true); } finally { setSaving(false); }
  };
  const chooseAvatarFile = (file: File | undefined) => {
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 512 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" && onAvatarChange(reader.result);
    reader.readAsDataURL(file);
  };
  const generateAvatar = async () => {
    if (!data) return;
    const brief = [data.name, data.description].filter(Boolean).join(" · ");
    setAvatarGenerating(true);
    setAvatarError(null);
    try {
      const res = await window.owb.generateAvatar({ brief });
      const imageDataUrl = (res.body as { imageDataUrl?: unknown })?.imageDataUrl;
      if (res.status !== 200 || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/png;base64,")) throw new Error();
      onAvatarChange(imageDataUrl);
    } catch {
      setAvatarError(t("avatar.generationFailed"));
    } finally {
      setAvatarGenerating(false);
    }
  };
  return <Modal open onCancel={onClose} title={t("manage.employeeSettings")} width={680} footer={null} className="owb-management-modal">
    {error ? <Alert type="error" title={t("manage.failed")} /> : null}
    {loading ? <Spin /> : data ? <>
      <div className="owb-management-identity"><PositionAvatar id={id} name={data.name} avatars={{ [id]: avatar }} /><div><h2>{data.name}</h2><p>{data.description}</p></div></div>
      <section className="owb-management-avatar"><h3>{t("avatar.title")}</h3><p>{t("avatar.description")}</p>{avatarError ? <p className="owb-management-avatar__error">{avatarError}</p> : null}
        <div className="owb-management-avatar__choices">
          <button type="button" className="owb-management-avatar__generate" onClick={() => void generateAvatar()} disabled={avatarGenerating} aria-label={t("avatar.generateAria")}><Sparkles size={16} /><span>{avatarGenerating ? t("avatar.generating") : "AI"}</span></button>
          {AVATAR_PRESETS.map((preset) => <button key={preset.id} type="button" className={avatar === preset.id ? "is-selected" : undefined} onClick={() => onAvatarChange(preset.id)} aria-label={t("avatar.selectPreset", { name: t(preset.labelKey) })}><img src={preset.src} alt="" /></button>)}
          <label className="owb-management-avatar__upload"><span>{t("avatar.upload")}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseAvatarFile(event.target.files?.[0])} /></label>
        </div>
      </section>
      <section><h3>{t("manage.model")}</h3><p className="owb-muted">{engine}</p>
        <Select aria-label={t("model.select")} value={config?.selected} disabled={busy || saving || !config?.editable} loading={saving}
          options={config?.options.map((model) => ({ value: model.id, label: `${model.id === "provider-default" ? t("model.agentDefault") : model.name}${model.id === config.recommended ? ` · ${t("model.recommended")}` : ""}` }))} onChange={(model) => void chooseModel(model)} />
        <p>{t("model.switchHint")}</p></section>
      <section><h3>{t("manage.reporting")}</h3><Select aria-label={t("manage.reporting")} value={parent ?? "__root__"} disabled={busy || isOwner}
        options={[{ value: "__root__", label: t("org.enterpriseRoot") }, ...targets.map((p) => ({ value: p.id, label: p.name }))]} onChange={(value) => setParent(value === "__root__" ? null : value)} />
        <Button disabled={busy || isOwner || parent === data.reportTo} onClick={() => void onMove(id, parent).then((ok) => { if (ok) { setData({ ...data, reportTo: parent }); onSaved(); } })}>{t("manage.saveReporting")}</Button></section>
      <section><h3>{t("manage.contextBudget")}</h3><Descriptions column={1} size="small" items={[
        { key: "task", label: t("pos.perTask"), children: data.budget?.perTask.tokens?.toLocaleString() ?? "—" },
        { key: "day", label: t("pos.perDay"), children: data.budget?.perDay.tokens?.toLocaleString() ?? "—" },
        { key: "parent", label: t("manage.reporting"), children: positions.find((p) => p.id === data.reportTo)?.name ?? t("org.enterpriseRoot") },
      ]} /><p>{t("manage.budgetHint")}</p><Button onClick={onMemory}>{t("manage.openMemory")}</Button></section>
      {!isOwner ? <section className="owb-management-danger"><p>{t("manage.removeHint")}</p><DismissPositionDialog positionName={data.name} descendantCount={descendantCount} busy={busy || saving} onDismiss={async () => { const ok = await onDismiss(id); if (ok) onClose(); return ok; }} /></section> : null}
    </> : <Empty />}
  </Modal>;
}

export function ProjectSettings({ workspace, onClose, onMemory, onCollaborate, onSwitch }: {
  workspace: WorkspaceInfoResponse; onClose: () => void; onMemory: () => void; onCollaborate: () => void; onSwitch: () => void;
}) {
  const t = useT();
  return <Modal open onCancel={onClose} title={t("manage.projectSettings")} width={620} footer={null} className="owb-management-modal">
    <h2>{workspace.business}</h2><p className="owb-management-path">{workspace.path}</p>
    <section><h3>{t("manage.sharedContext")}</h3><p>{t("manage.projectHint")}</p><Button onClick={onMemory}>{t("memory.shared")}</Button><Button onClick={onCollaborate}>{t("memory.collaborate")}</Button></section>
    <section><h3>{t("manage.contextBudget")}</h3><p>{workspace.budgetPoolTokens?.toLocaleString() ?? "—"} tokens</p><p>{t("manage.projectModelHint")}</p></section>
    <Button onClick={onSwitch}>{t("manage.switchProject")}</Button>
  </Modal>;
}
