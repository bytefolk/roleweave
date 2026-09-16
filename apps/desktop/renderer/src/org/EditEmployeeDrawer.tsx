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
import { useCallback, useEffect, useState } from "react";
import { Button as AntButton, Drawer, Input, Select, message } from "antd";
import { AlertTriangle, LoaderCircle, ShieldCheck } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { HirePermissions, PositionProfilePatch, PositionProfileResult } from "@roleweave/shared";
import type { PositionCardData } from "@roleweave/ui";
import { CapabilityPicker, PermissionPolicyEditor } from "./PermissionsEditor";

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

export function EditEmployeeDrawer({
  open,
  position,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The selected position record; null while the card is still loading. */
  position: PositionCardData | null;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: PositionProfilePatch) => Promise<{ ok: true; name: string } | { ok: false; code: string }>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<PositionCardData["mode"]>("read_only");
  const [permissions, setPermissions] = useState<HirePermissions>({ tools: [], rules: [] });
  const [initial, setInitial] = useState<HirePermissions | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

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
  }, [open, position]);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && byteLength(trimmedName) <= MAX_NAME_BYTES;
  const changed = position !== null && (
    trimmedName !== position.name
    || mode !== position.mode
    || (initial !== null && permissions !== initial)
  );
  const canSave = position !== null && nameValid && changed && !saving && !busy;

  const submit = useCallback(async () => {
    if (position === null || !canSave) return;
    // Send only what moved: an unchanged section is never rewritten, so a
    // permission grant this drawer did not intend to touch stays byte-identical.
    const patch: PositionProfilePatch = {};
    if (trimmedName !== position.name) patch.name = trimmedName;
    if (mode !== position.mode) patch.mode = mode;
    if (initial !== null && permissions !== initial) patch.permissions = permissions;
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
  }, [canSave, initial, messageApi, mode, onClose, onSave, permissions, position, t, trimmedName]);

  return (
    <Drawer
      className="owb-hire-drawer-shell"
      title={t("profile.editHeading")}
      width="min(760px, calc(100vw - 24px))"
      open={open}
      onClose={onClose}
      destroyOnHidden
    >
      {contextHolder}
      <div className="owb-hire-shell">
        <div className="owb-hire-shell__scroll">
          <div className="owb-hire-drawer">
            <section className="owb-hire-section-head">
              <div>
                <h4><ShieldCheck aria-hidden="true" size={15} />{t("profile.identity")}</h4>
                <p>{t("profile.editDescription")}</p>
              </div>
            </section>
            <div className="owb-hire-basic-grid">
              <label>
                <span>{t("profile.name")}</span>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("profile.namePh")}
                  status={nameValid ? undefined : "error"}
                  aria-invalid={!nameValid}
                />
              </label>
              <label>
                <span>{t("profile.mode")}</span>
                <Select
                  value={mode}
                  onChange={(value: PositionCardData["mode"]) => setMode(value)}
                  options={[
                    { value: "read_only", label: t("profile.modeReadOnly") },
                    { value: "approval_required", label: t("profile.modeApproval") },
                  ]}
                />
              </label>
            </div>
            {nameValid ? null : <p className="owb-hire-drawer__hint owb-hire-drawer__hint--error">{t("profile.nameTooLong")}</p>}
            {position !== null ? <p className="owb-hire-capability-note">{t("profile.idNote", { id: position.id })}</p> : null}

            <PermissionPolicyEditor permissions={permissions} onChange={setPermissions} />
            <p className="owb-hire-capability-note">{t("profile.permissionsNote")}</p>
            <CapabilityPicker permissions={permissions} onChange={setPermissions} />
          </div>
        </div>
        <footer className="owb-modal__footer owb-hire-footer">
          {error !== null ? (
            <span className="owb-hire-drawer__hint owb-hire-drawer__hint--error" role="alert">
              <AlertTriangle aria-hidden="true" size={13} />{error}
            </span>
          ) : !changed && position !== null ? (
            <span>{t("profile.noChanges")}</span>
          ) : <span />}
          <AntButton onClick={onClose} disabled={saving}>{t("dlg.cancel")}</AntButton>
          <AntButton
            type="primary"
            disabled={!canSave}
            loading={saving}
            icon={saving ? <LoaderCircle aria-hidden="true" size={14} /> : undefined}
            onClick={() => void submit()}
          >
            {saving ? t("profile.saving") : t("profile.save")}
          </AntButton>
        </footer>
      </div>
    </Drawer>
  );
}
