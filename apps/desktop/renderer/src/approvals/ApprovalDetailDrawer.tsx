/**
 * ApprovalDetailDrawer (design spec §5.1 · verdict panel)
 *
 * Right-side drawer that lets the operator inspect one approval and
 * approve / deny it. Interaction is deliberately dumb: it forwards the
 * verdict up via callbacks; the server owns the source-bound resume turn.
 * Once an item is
 * decided (or expired), inputs and action buttons are locked so nothing can
 * be re-judged.
 *
 * DATA GAP (TODO, v0):
 *   Raw evidence records are intentionally kept out of this human-facing
 *   drawer for now. The approval decision only needs the request summary and
 *   the operator's verdict; audit details remain in the run history.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Input, Radio, Space, Tag } from "antd";
import { useT } from "@roleweave/ui";
import {
  approvalExpiryState,
  isDecided,
  isPermissionOverreach,
  type ApprovalQueueCallbacks,
  type ApprovalQueueItem,
} from "./types";
import { safeApprovalText } from "./safe-display";
import { decodeEscapedUnicode } from "../display-text";
// Mirrors packages/shared/pending-approval.cjs MAX_APPROVAL_REASON_BYTES.
// Inlined here because the shared module transitively uses `node:module`
// createRequire and cannot be bundled for the renderer.
const MAX_APPROVAL_REASON_BYTES = 1024;

export interface ApprovalDetailDrawerProps extends ApprovalQueueCallbacks {
  open: boolean;
  item: ApprovalQueueItem | null;
  /** The queue-owned clock, refreshed once a minute. */
  now: number;
  onClose: () => void;
}

export function ApprovalDetailDrawer({
  open,
  item,
  now,
  onClose,
  onApprove,
  onDeny,
  onOpenSource,
  onOpenEvidence,
}: ApprovalDetailDrawerProps) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"once" | "run">("once");

  useEffect(() => {
    // Reset the reason field whenever the drawer switches to a different
    // approval or closes; do not leak reasons across items.
    setReason("");
    setScope("once");
  }, [item?.approvalId, open]);

  if (!item) {
    return (
      <Drawer
        open={open}
        onClose={onClose}
        width={420}
        title={t("apr.detailTitle")}
        destroyOnClose
      />
    );
  }

  const decided = isDecided(item);
  const overreach = isPermissionOverreach(item);
  const expired = approvalExpiryState(item, now) === "expired";
  const disabled = decided || expired || item.busy === true || item.canDecide === false || new TextEncoder().encode(reason.trim()).length > MAX_APPROVAL_REASON_BYTES;
  const positionName = decodeEscapedUnicode(item.positionName ?? t("apr.unknownPosition"));
  const description = safeApprovalText(decodeEscapedUnicode(item.description));
  const target = item.target ? safeApprovalText(decodeEscapedUnicode(item.target)) : undefined;
  const trimmedReason = reason.trim();
  const reasonForCallback = trimmedReason.length === 0 ? undefined : trimmedReason;
  const source = item.source;
  const decidedAt = item.decision.kind === "granted" || item.decision.kind === "denied"
    ? item.decision.decidedAt
    : undefined;
  const decidedBy = item.decision.kind === "granted" || item.decision.kind === "denied"
    ? item.decision.decidedBy
    : undefined;

  const handleApprove = () => {
    if (disabled) return;
    if (scope === "run") onApprove(item.approvalId, reasonForCallback, scope);
    else onApprove(item.approvalId, reasonForCallback);
  };
  const handleDeny = () => {
    if (disabled) return;
    onDeny(item.approvalId, reasonForCallback);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={420}
      title={t("apr.detailTitleCategory", { category: t(`apr.kind.${item.category}`) })}
      destroyOnClose
      data-testid="approval-detail-drawer"
    >
      <div className="owb-approval-drawer" data-approval-id={item.approvalId}>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div className="owb-approval-drawer__meta">
            <Tag color="purple">{t(`apr.kind.${item.category}`)}</Tag>
            {overreach ? <Tag color="red">{t("apr.overreach")}</Tag> : null}
            {item.positionMode ? (
              <Tag color={item.positionMode === "read_only" ? "default" : "purple"}>
                {t("apr.modeTag", { mode: item.positionMode === "read_only" ? t("pos.readOnly") : t("pos.approval") })}
              </Tag>
            ) : null}
          </div>

          <section>
            <h3 className="owb-approval-drawer__section-title">{t("apr.requestingPosition")}</h3>
            <p className="owb-approval-drawer__position">
              <strong>{positionName}</strong>
            </p>
          </section>

          <section>
            <h3 className="owb-approval-drawer__section-title">{t("apr.actionDescription")}</h3>
            <p className="owb-approval-drawer__description">{description}</p>
            {target ? (
              <p className="owb-approval-drawer__target">
                {t("apr.targetPrefix")}<code>{target}</code>
              </p>
            ) : null}
          </section>

          <section>
            <h3 className="owb-approval-drawer__section-title">{t("apr.deadline")}</h3>
            <p className="owb-approval-drawer__meta-line">
              {item.expiresAt ? (
                <span>{t("apr.expiresPrefix")}{formatApprovalExpiry(item.expiresAt)}</span>
              ) : (
                <span className="owb-muted">{t("apr.noExpiry")}</span>
              )}
            </p>
          </section>

          {item.requestReason ? (
            <section>
              <h3 className="owb-approval-drawer__section-title">{t("apr.requestReason")}</h3>
              <p className="owb-approval-drawer__description">{safeApprovalText(decodeEscapedUnicode(item.requestReason))}</p>
            </section>
          ) : null}

          <section data-testid="approval-context">
            <h3 className="owb-approval-drawer__section-title">{t("apr.context")}</h3>
            {item.context ? (
              <>
                <div className="owb-approval-drawer__meta">
                  <Tag color={item.context.risk === "high" ? "red" : "orange"}>
                    {t(`apr.risk.${item.context.risk}`)}
                  </Tag>
                </div>
                <dl className="owb-approval-drawer__references">
                  <div><dt>{t("apr.requestedCapability")}</dt><dd>{t(`apr.kind.${item.context.requestedCapability}`)}</dd></div>
                  <div><dt>{t("apr.impact")}</dt><dd>{t(`apr.impact.${item.context.impact}`)}</dd></div>
                  <div><dt>{t("apr.parameterSummary")}</dt><dd>{item.context.parameterSummary ? safeApprovalText(item.context.parameterSummary) : <span className="owb-muted">{t("apr.contextUnavailable")}</span>}</dd></div>
                  <div><dt>{t("apr.permissionMode")}</dt><dd>{t(`apr.mode.${item.context.permissions.mode}`)}</dd></div>
                  <div><dt>{t("apr.allowedTools")}</dt><dd>{item.context.permissions.allowedTools.length > 0 ? item.context.permissions.allowedTools.join(", ") : t("apr.noneDeclared")}</dd></div>
                  <div><dt>{t("apr.deniedTools")}</dt><dd>{item.context.permissions.deniedTools.length > 0 ? item.context.permissions.deniedTools.join(", ") : t("apr.noneDeclared")}</dd></div>
                  <div>
                    <dt>{t("apr.changePreview")}</dt>
                    <dd>
                      {item.context.preview.status === "unavailable" ? t(`apr.preview.${item.context.preview.status}`) : (
                        <div data-testid="approval-change-preview">
                          {item.context.preview.files.map((file) => (
                            <details key={`${file.change}:${file.path}`}>
                              <summary><Tag color="blue">{t(`apr.preview.change.${file.change}`)}</Tag><code>{safeApprovalText(file.path)}</code></summary>
                              {file.before !== undefined ? <pre>{safeApprovalText(file.before)}</pre> : null}
                              {file.after !== undefined ? <pre>{safeApprovalText(file.after)}</pre> : null}
                            </details>
                          ))}
                        </div>
                      )}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="owb-muted">{t("apr.contextUnavailable")}</p>
            )}
          </section>

          <section data-testid="approval-lifecycle">
            <h3 className="owb-approval-drawer__section-title">{t("apr.lifecycle")}</h3>
            <ol className="owb-approval-drawer__lifecycle">
              <li className={`is-${item.decision.kind}`}>
                <strong>{t("apr.lifecycleApproval")}</strong>
                <span>{t(`apr.status.${item.decision.kind}`)}</span>
                {decidedAt ? <time>{formatApprovalTimestamp(decidedAt)}</time> : null}
                {decidedBy ? <small>{t("apr.decidedBy", { actor: decidedBy })}</small> : null}
              </li>
              <li className={`is-${item.executionPhase ?? "not_started"}`}>
                <strong>{t("apr.lifecycleExecution")}</strong>
                <span>{t(`apr.phase.${item.executionPhase ?? "not_started"}`)}</span>
                {item.executionErrorCode ? <code>{item.executionErrorCode}</code> : null}
              </li>
            </ol>
          </section>

          <section>
            <h3 className="owb-approval-drawer__section-title">{t("apr.traceability")}</h3>
            {source ? (
              <dl className="owb-approval-drawer__references">
                <div><dt>{t("apr.sourceType")}</dt><dd>{t(`apr.source.${source.kind}`)}</dd></div>
                <div><dt>{t("apr.sourceConversation")}</dt><dd><code>{source.conversationId}</code></dd></div>
                <div><dt>{t("apr.sourceTurn")}</dt><dd><code>{source.turnId}</code></dd></div>
                <div><dt>{t("apr.sourceRun")}</dt><dd><code>{source.runId}</code></dd></div>
                {item.executionTurnId ? <div><dt>{t("apr.executionTurn")}</dt><dd><code>{item.executionTurnId}</code></dd></div> : null}
              </dl>
            ) : (
              <p className="owb-muted">{t("apr.referencesUnavailable")}</p>
            )}
            <Space wrap>
              <Button
                type="link"
                disabled={!source || source.kind !== "session" || !onOpenSource}
                onClick={() => source && onOpenSource?.(item)}
              >
                {t("apr.openSource")}
              </Button>
              <Button
                type="link"
                disabled={!onOpenEvidence}
                onClick={() => onOpenEvidence?.(item)}
              >
                {t("apr.openEvidence")}
              </Button>
            </Space>
            {source && source.kind !== "session" ? <p className="owb-muted">{t("apr.sourceUnavailable")}</p> : null}
          </section>

          {decided ? (
            <Alert
              type={item.decision.kind === "granted" ? "success" : item.decision.kind === "denied" ? "error" : "info"}
              message={
                item.decision.kind === "granted"
                  ? t("apr.alertGranted")
                  : item.decision.kind === "denied"
                    ? t("apr.alertDenied")
                    : t(`apr.status.${item.decision.kind}`)
              }
              description={item.decision.kind === "granted"
                ? t("apr.effectiveScope", { scope: t(`apr.scope.${item.decision.scope}`) })
                : item.decision.kind === "denied" && item.decision.reason
                  ? t("apr.reasonPrefix", { reason: safeApprovalText(item.decision.reason) })
                  : undefined}
              showIcon
            />
          ) : expired ? (
            <Alert type="warning" showIcon message={t("apr.alertExpired")} />
          ) : (
            <>
              {item.scopeAllowed?.includes("run") ? <section data-testid="approval-scope-choice">
                <h3 className="owb-approval-drawer__section-title">{t("apr.scopeTitle")}</h3>
                <Radio.Group value={scope} onChange={(event) => setScope(event.target.value)} disabled={disabled}>
                  <Radio value="once">{t("apr.scope.once")}</Radio>
                  <Radio value="run">{t("apr.scope.run")}</Radio>
                </Radio.Group>
                <p className="owb-muted">{t("apr.scopeRunHint")}</p>
              </section> : null}
              <section>
                <h3 className="owb-approval-drawer__section-title">{t("apr.reasonOptional")}</h3>
                <Input.TextArea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("apr.reasonPh")}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  maxLength={MAX_APPROVAL_REASON_BYTES}
                  showCount
                  data-testid="approval-reason-input"
                  disabled={disabled}
                />
              </section>
            </>
          )}

          <div className="owb-approval-drawer__actions">
            <Button
              type="primary"
              onClick={handleApprove}
              disabled={disabled}
              loading={item.busy}
              data-testid="approval-approve-button"
            >
              {t("apr.grant")}
            </Button>
            <Button
              danger
              onClick={handleDeny}
              disabled={disabled}
              data-testid="approval-deny-button"
            >
              {t("apr.deny")}
            </Button>
          </div>
          {item.executionPhase && item.executionPhase !== "not_started" ? <Alert type="info" showIcon message={t(`apr.phase.${item.executionPhase}`)} /> : null}
          {item.canDecide === false && !decided ? <Alert type="warning" message={t(`apr.unavailable.${item.unavailableReason ?? "unknown"}`)} /> : null}
          {new TextEncoder().encode(reason.trim()).length > MAX_APPROVAL_REASON_BYTES ? <Alert type="warning" message={t("apr.reasonTooLong")} /> : null}
          {item.error ? <Alert type="error" showIcon message={item.error} /> : null}

        </Space>
      </div>
    </Drawer>
  );
}

function formatApprovalExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { hour12: false });
}

function formatApprovalTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { hour12: false });
}
