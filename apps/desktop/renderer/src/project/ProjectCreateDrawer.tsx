import { useEffect, useMemo, useState } from "react";
import { Button as AntButton, Drawer, Input } from "antd";
import { FolderPlus } from "lucide-react";
import type { WorkspaceCreateResponse } from "@roleweave/shared";
import { useT } from "@roleweave/ui";

interface ProjectCreateDrawerProps {
  open: boolean;
  onClose: () => void;
  onCreated: (workspace: WorkspaceCreateResponse) => void;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug) return slug;
  if (!value.trim()) return "new-project";

  // Keep the platform rule deterministic for names without Latin letters
  // (for example, a Chinese-only project name) without inventing a second
  // editable field or relying on a locale-specific transliteration package.
  let hash = 2166136261;
  for (const character of value.trim()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `project-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

export function ProjectCreateDrawer({ open, onClose, onCreated }: ProjectCreateDrawerProps) {
  const t = useT();
  const [business, setBusiness] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusiness("");
    setDescription("");
    setBusy(false);
    setError(null);
  }, [open]);

  const generatedId = useMemo(() => slugify(business), [business]);
  const formValid = business.trim().length > 0;

  const create = async () => {
    if (!formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await window.owb.createWorkspace({
        projectId: generatedId,
        business: business.trim(),
        description: description.trim(),
      });
      if (!("status" in response)) return;
      if (response.status !== 201) {
        const body = response.body as { message?: unknown };
        setError(typeof body?.message === "string" ? body.message : t("project.createFailed"));
        return;
      }
      onCreated(response.body as WorkspaceCreateResponse);
      onClose();
    } catch {
      setError(t("project.createOffline"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      className="owb-project-drawer-shell"
      title={t("project.createTitle")}
      width="min(560px, calc(100vw - 24px))"
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      destroyOnHidden
    >
      <div className="owb-project-drawer">
        <section className="owb-project-hero">
          <div className="owb-project-hero__icon"><FolderPlus aria-hidden="true" size={20} /></div>
          <div>
            <p className="owb-project-eyebrow">{t("project.step")}</p>
            <h3>{t("project.heroTitle")}</h3>
            <p>{t("project.heroDescription")}</p>
          </div>
        </section>

        <section className="owb-project-form" aria-label={t("project.formAria")}>
          <label>
            <span>{t("project.business")}</span>
            <Input
              autoFocus
              value={business}
              maxLength={64}
              placeholder={t("project.businessPh")}
              onChange={(event) => setBusiness(event.target.value)}
            />
          </label>
          <p className="owb-project-form__note">{t("project.idAutoNote")}</p>
          <label>
            <span>{t("project.description")}</span>
            <Input.TextArea
              value={description}
              maxLength={1024}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder={t("project.descriptionPh")}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </section>

        {error ? <p className="owb-project-error" role="alert">{error}</p> : null}
        <footer className="owb-project-footer">
          <span>{t("project.locationHint")}</span>
          <AntButton onClick={onClose} disabled={busy}>{t("dlg.cancel")}</AntButton>
          <AntButton type="primary" onClick={() => void create()} loading={busy} disabled={!formValid} icon={<FolderPlus aria-hidden="true" size={14} />}>
            {t("project.createAction")}
          </AntButton>
        </footer>
      </div>
    </Drawer>
  );
}
