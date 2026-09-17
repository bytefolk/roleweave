import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@fullstack-ai-infra/ui";
import type { OrgBackupEntry } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import { ArchiveRestore, ChevronDown, Trash2 } from "lucide-react";

export function DismissPositionDialog({
  positionName,
  descendantCount,
  busy,
  onDismiss,
}: {
  positionName: string;
  descendantCount: number;
  busy: boolean;
  onDismiss: () => Promise<boolean>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* 触发键克制：平时是 hairline 幽灵按钮，hover/focus 才转 danger。
          裁撤是低频且不可逆的操作，不该用实心红长期占据视觉重心；真正的
          警示留给二次确认弹窗。 */}
      <button
        type="button"
        className="owb-dismiss"
        onClick={() => setOpen(true)}
        disabled={busy}
        title={t("pos.dismissTitle")}
      >
        <Trash2 aria-hidden="true" size={13} />
        {t("pos.dismiss")}
      </button>
      <Modal
        open={open}
        title={t("dlg.dismissTitle", { name: positionName })}
        description={descendantCount > 0
          ? t("dlg.dismissDescWithReports", { count: descendantCount })
          : t("dlg.dismissDesc")}
        onOpenChange={setOpen}
      >
        <footer className="owb-modal__footer">
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{t("dlg.cancel")}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void onDismiss().then((ok) => ok && setOpen(false))}>{t("dlg.dismissConfirm")}</Button>
        </footer>
      </Modal>
    </>
  );
}

export function BackupTray({
  backups,
  busy,
  status = "ready",
  positionNames,
  onRestore,
  onRetry,
}: {
  backups: OrgBackupEntry[];
  busy: boolean;
  status?: "loading" | "ready" | "error";
  positionNames?: Record<string, string>;
  onRestore: (backupId: string) => Promise<boolean>;
  onRetry?: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (status === "ready" && backups.length === 0) return null;
  return (
    <section className="owb-backups" aria-label={t("tree.recovery")}>
      {status === "loading" ? (
        <div className="owb-backups__status" role="status">
          <ArchiveRestore aria-hidden="true" size={14} /><span>{t("tree.recoveryLoading")}</span>
        </div>
      ) : status === "error" ? (
        <div className="owb-backups__status" role="alert">
          <span>{t("tree.recoveryFailed")}</span>
          <button type="button" className="owb-backups__retry" onClick={onRetry}>{t("tree.recoveryRetry")}</button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="owb-backups__toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((current) => !current)}
          >
            <ArchiveRestore aria-hidden="true" size={14} />
            <span>{t("tree.recoveryHead", { count: backups.length })}</span>
            <ChevronDown className="owb-backups__chevron" aria-hidden="true" size={14} />
          </button>
          <div id={listId} className="owb-backups__list" hidden={!expanded}>
            {backups.map((backup) => (
              <div className="owb-backups__item" key={backup.backupId}>
                <span><strong title={backup.name}>{backup.name}</strong><small>{t("tree.backupOrigin", { target: backup.reportTo ? positionNames?.[backup.reportTo] ?? t("org.unknownPosition") : t("org.enterpriseRoot") })}</small></span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onRestore(backup.backupId)}>{t("tree.restore")}</Button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Modal({
  open,
  title,
  description,
  className,
  onOpenChange,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  className?: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  if (!open) return null;
  return (
    <div className="owb-modal" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onOpenChange(false);
    }}>
      <section
        className={["owb-modal__panel", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="owb-modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button type="button" className="owb-modal__close" aria-label={t("dlg.close")} onClick={() => onOpenChange(false)}>×</button>
        </header>
        {children}
      </section>
    </div>
  );
}
