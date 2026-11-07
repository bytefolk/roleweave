/**
 * Edit an employee that already exists.
 *
 * The counterpart to `HireDrawer`: hiring had a full form while the resulting
 * record was immutable, so a mis-bound Skill set could only be fixed by
 * dismissing the position — which also discards every turn, session and group
 * reference filed under its id. This drawer edits the record in place.
 *
 * What it deliberately does NOT offer: the position id (a migration, not an
 * edit), the reporting line and the budget (their own governed channels), and
 * the Agent binding (locked by design after the initial selection). The patch
 * carries only the fields that actually changed, so an untouched section can
 * never be rewritten by a save.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Button as AntButton, Checkbox, Drawer, Input, Select, Spin, message } from "antd";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { HirePermissions, PositionProfilePatch } from "@roleweave/shared";
import type { PositionCardData } from "@roleweave/ui";
import { CapabilityPicker, PermissionPolicyEditor } from "./PermissionsEditor";
import { FileAccessEditor, nativePermissionIssue } from "./FileAccessEditor";
import type { TurnEngine } from "../turns/types";
import "./edit-employee.css";

const MAX_NAME_BYTES = 128;

/** Failure codes this surface can explain itself; anything else shows its code. */
const FAILURE_COPY_KEYS: Record<string, string> = {
  position_profile_invalid: "profile.failInvalid",
  session_conflict: "profile.failBusy",
  engine_unavailable: "profile.failEngine",
  engine_capability_missing: "profile.failEngine",
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function permissionFingerprint(policy: HirePermissions): string {
  return JSON.stringify({
    tools: [...policy.tools].sort(),
    nativeExecution: policy.nativeExecution === true,
    network: policy.network ?? "deny",
    rules: policy.rules.map((rule) => ({ ...rule, actions: [...rule.actions].sort() })),
    skills: [...(policy.skills ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    mcpServers: (policy.mcpServers ?? [])
      .map((server) => ({ ...server, tools: [...server.tools].sort() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function EditEmployeeDrawer({
  open,
  position,
  engine,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The selected position record; null while the card is still loading. */
  position: PositionCardData | null;
  engine?: TurnEngine;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: PositionProfilePatch) => Promise<{ ok: true; name: string } | { ok: false; code: string }>;
}) {
  const t = useT();
  const clientManaged = engine === "qwen-office-local";
  const nativeHost = engine === "codex" || engine === "codex-local";
  const [name, setName] = useState("");
  const [mode, setMode] = useState<PositionCardData["mode"]>("read_only");
  const [permissions, setPermissions] = useState<HirePermissions>({ tools: [], rules: [] });
  const [initial, setInitial] = useState<HirePermissions | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionsExpanded, setPermissionsExpanded] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const permissionsPanelId = useId();

  // Seed from the record each time it opens, so a previous edit never leaks into
  // another employee (or into the same employee after an external change).
  useEffect(() => {
    if (!open || position === null) return;
    const policy = position.permissionPolicy ?? { tools: position.permissions.toolAllow, rules: [] };
    setName(position.name);
    setMode(position.mode);
    setPermissions(policy);
    setInitial(policy);
    setSaving(false);
    setError(null);
    setPermissionsExpanded(false);
  }, [open, position]);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && byteLength(trimmedName) <= MAX_NAME_BYTES;
  const permissionsChanged = initial !== null && permissionFingerprint(permissions) !== permissionFingerprint(initial);
  const invalidRuleIndex = permissions.rules.findIndex((rule) => rule.resource.trim().length === 0 || rule.resource.length > 512 || rule.actions.length === 0);
  const nativeIssue = nativeHost && mode !== "read_only" ? nativePermissionIssue(permissions) : null;
  const validateDraftPermissions = permissionsChanged || (nativeHost && mode !== "read_only" && mode !== position?.mode);
  const permissionError = !validateDraftPermissions ? null
    : (permissions.mcpServers ?? []).length > 0 ? t("profile.removeConnectorsBeforeSave")
    : invalidRuleIndex >= 0 ? t("profile.invalidResource", { number: invalidRuleIndex + 1 })
    : nativeIssue ? t(nativeIssue.key, { path: nativeIssue.path ?? "" })
    : null;
  const changed = position !== null && (
    trimmedName !== position.name
    || (!clientManaged && mode !== position.mode)
    || (!clientManaged && permissionsChanged)
  );
  const canSave = position !== null && nameValid && changed && permissionError === null && !saving && !busy;

  const submit = useCallback(async () => {
    if (position === null || !canSave) return;
    // Send only what moved: an unchanged section is never rewritten, so a
    // permission grant this drawer did not intend to touch stays byte-identical.
    const patch: PositionProfilePatch = {};
    if (trimmedName !== position.name) patch.name = trimmedName;
    if (!clientManaged && mode !== position.mode) patch.mode = mode;
    if (!clientManaged && permissionsChanged) patch.permissions = permissions;
    setSaving(true);
    setError(null);
    const outcome = await onSave(patch);
    setSaving(false);
    if (outcome.ok) {
      void messageApi.success(t("profile.saved", { name: outcome.name }));
      onClose();
      return;
    }
    const copyKey = FAILURE_COPY_KEYS[outcome.code];
    setError(copyKey !== undefined ? t(copyKey) : t("profile.failUnknown", { code: outcome.code }));
  }, [canSave, clientManaged, messageApi, mode, onClose, onSave, permissions, permissionsChanged, position, t, trimmedName]);

  return (
    <Drawer
      className="owb-hire-drawer-shell owb-profile-drawer"
      title={t("profile.editHeading")}
      size="min(600px, 100vw)"
      open={open}
      onClose={saving ? undefined : onClose}
      closable={!saving}
      keyboard={!saving}
      maskClosable={!saving}
      destroyOnHidden
    >
      {contextHolder}
      <div className="owb-hire-shell owb-profile-shell">
        <div className="owb-hire-shell__scroll owb-profile-scroll">
          {position === null ? <div className="owb-profile-loading"><Spin /></div> : (
          <fieldset className="owb-profile-form" disabled={saving || busy}>
            <section className="owb-profile-section owb-profile-basics">
              <div className="owb-profile-section__head">
                <h4>{t("profile.basicSettings")}</h4>
                <span className="owb-profile-id" title={t("profile.idNote", { id: position.id })}>{position.id}</span>
              </div>
              <div className="owb-profile-setting">
                <label htmlFor={`${permissionsPanelId}-name`}>{t("profile.name")}</label>
                <Input
                  id={`${permissionsPanelId}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("profile.namePh")}
                  status={nameValid ? undefined : "error"}
                  aria-invalid={!nameValid}
                  aria-describedby={!nameValid ? `${permissionsPanelId}-name-error` : undefined}
                />
              </div>
              {nameValid ? null : <p id={`${permissionsPanelId}-name-error`} className="owb-profile-error" role="alert">{t(trimmedName.length === 0 ? "profile.nameRequired" : "profile.nameTooLong")}</p>}
              {!clientManaged ? <div className="owb-profile-setting">
                <label htmlFor={`${permissionsPanelId}-mode`}>{t("profile.mode")}</label>
                <Select
                  id={`${permissionsPanelId}-mode`}
                  value={mode}
                  disabled={saving || busy}
                  onChange={(value: PositionCardData["mode"]) => setMode(value)}
                  options={[
                    { value: "read_only", label: t("profile.modeReadOnly") },
                    { value: "approval_required", label: t("profile.modeApproval") },
                  ]}
                />
              </div> : null}
            </section>
            {clientManaged ? <p className="owb-profile-empty">{t("office.clientManaged")} {t("office.clientSettings")} {t("office.accountManaged")}</p> : <>
            <FileAccessEditor permissions={permissions} onChange={setPermissions} readOnly={mode === "read_only"}
              disabled={saving || busy} nativeHost={nativeHost} onEnableChanges={() => setMode("approval_required")} />
            {nativeHost ? <section className="owb-profile-section" aria-label={t("profile.internetAccess")}>
              <div className="owb-profile-section__head"><h4>{t("profile.internetAccess")}</h4></div>
              <Checkbox disabled={saving || busy} checked={permissions.network === "host_policy"}
                onChange={(event) => setPermissions({ ...permissions, network: event.target.checked ? "host_policy" : "deny" })}>
                {t("profile.allowInternet")}
              </Checkbox>
              <p className="owb-profile-help owb-profile-network-hint">{t("profile.internetHint")}</p>
            </section> : null}
            <CapabilityPicker variant="compact" permissions={permissions} onChange={setPermissions}
              nativeWork={nativeHost && mode !== "read_only" && permissions.nativeExecution === true} />
            <section className="owb-profile-advanced">
              <button
                type="button"
                className="owb-profile-advanced__summary"
                aria-expanded={permissionsExpanded}
                aria-controls={permissionsPanelId}
                onClick={() => setPermissionsExpanded((expanded) => !expanded)}
              >
                <span>{t("profile.advancedPermissions")}</span>
                <small>{t("profile.advancedHint")}</small>
                <ChevronDown aria-hidden="true" size={16} />
              </button>
              {permissionsExpanded ? (
                <div className="owb-profile-advanced__body" id={permissionsPanelId}>
                  <PermissionPolicyEditor variant="compact" disabled={saving || busy} permissions={permissions} onChange={setPermissions} />
                </div>
              ) : null}
            </section>
            </>}
          </fieldset>
          )}
        </div>
        <footer className="owb-profile-footer">
          {permissionError !== null || error !== null ? (
            <span className="owb-profile-error" role="alert">
              <AlertTriangle aria-hidden="true" size={13} />{permissionError ?? error}
            </span>
          ) : <span />}
          <AntButton onClick={onClose} disabled={saving}>{t("dlg.cancel")}</AntButton>
          <AntButton
            type="primary"
            disabled={!canSave}
            loading={saving}
            onClick={() => void submit()}
          >
            {saving ? t("profile.saving") : t("profile.save")}
          </AntButton>
        </footer>
      </div>
    </Drawer>
  );
}
