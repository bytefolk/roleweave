import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Tag } from "antd";
import type {
  ExperimentsResponse,
  PositionMode,
  SendGateAdviceChoice,
  SendGateAdviceResponse,
} from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import "./send-gate-overlay.css";

export interface SendGateOverlayProps {
  experiment: ExperimentsResponse;
  positionId: string;
  mode: PositionMode;
}

export function SendGateOverlay({ experiment, positionId, mode }: SendGateOverlayProps) {
  const t = useT();
  const requestVersion = useRef(0);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SendGateAdviceResponse | null>(null);
  const [selected, setSelected] = useState<SendGateAdviceChoice>("keep");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    requestVersion.current += 1;
    setOpen(false);
    setSummary("");
    setLoading(false);
    setResult(null);
    setSelected("keep");
    setFailed(false);
  }, [experiment.workspacePath, experiment.workspaceSession, experiment.revision, positionId, mode]);

  const ask = async () => {
    const taskSummary = summary.trim();
    const bridge = window.owb?.sendGateAdvice;
    if (!taskSummary || !bridge || loading) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setFailed(false);
    setResult(null);
    setSelected("keep");
    try {
      const response = await bridge({
        workspacePath: experiment.workspacePath,
        workspaceSession: experiment.workspaceSession,
        revision: experiment.revision,
        positionId,
        taskSummary: { value: taskSummary, confirmed: true },
      });
      if (requestVersion.current !== version) return;
      const body = response.body;
      if (response.status !== 200 || body.workspacePath !== experiment.workspacePath ||
        body.workspaceSession !== experiment.workspaceSession || body.revision !== experiment.revision ||
        body.rule.positionId !== positionId || body.rule.mode !== mode) throw new Error("stale advice");
      setResult(body);
      if (body.status === "ready" && body.suggestion !== null) setOpen(false);
      else setFailed(true);
    } catch {
      if (requestVersion.current === version) setFailed(true);
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  };

  const suggestion = result?.status === "ready" ? result.suggestion : null;
  const notAdopted = suggestion !== null && suggestion !== selected;
  const modeLabel = t(mode === "read_only" ? "turn.sendGateModeReadOnly" : "turn.sendGateModeApproval");
  const suggestionLabel = suggestion === "approval_required"
    ? t("turn.sendGateSuggestionApproval")
    : t("turn.sendGateSuggestionKeep");

  return <section className="owb-send-gate" role="region" aria-label={t("turn.sendGateTitle")}>
    <div className="owb-send-gate__facts">
      <span>{t("turn.sendGateRule", { mode: modeLabel })}</span>
      {suggestion ? <span>{t("turn.sendGateSuggestion", { suggestion: suggestionLabel })}</span> : null}
      {notAdopted ? <Tag color="gold">{t("turn.sendGateNotAdopted")}</Tag> : null}
      {!notAdopted && selected === "approval_required" ? <span>{t("turn.sendGatePrefilled")}</span> : null}
    </div>
    <div className="owb-send-gate__actions">
      {suggestion && notAdopted ? <Button size="small" onClick={() => setSelected(suggestion)}>{t("turn.sendGateApply")}</Button> : null}
      <Button size="small" type="text" onClick={() => { setFailed(false); setOpen(true); }}>
        {t("turn.sendGateGet")}
      </Button>
    </div>
    <Modal
      open={open}
      title={t("turn.sendGateDialogTitle")}
      okText={t("turn.sendGateConfirm")}
      cancelText={t("turn.sendGateCancel")}
      okButtonProps={{ disabled: summary.trim().length === 0, loading }}
      onOk={() => void ask()}
      onCancel={() => { if (!loading) setOpen(false); }}
    >
      <label className="owb-send-gate__summary-label" htmlFor="owb-send-gate-summary">{t("turn.sendGateSummary")}</label>
      <Input.TextArea
        id="owb-send-gate-summary"
        value={summary}
        maxLength={512}
        autoSize={{ minRows: 3, maxRows: 6 }}
        onChange={event => { setSummary(event.target.value); setResult(null); setSelected("keep"); setFailed(false); }}
      />
      <p className="owb-send-gate__disclosure">{t("turn.sendGateDisclosure", { positionId, mode: modeLabel })}</p>
      {failed ? <p role="status" className="owb-send-gate__failed">{t("turn.sendGateAbstained")}</p> : null}
    </Modal>
  </section>;
}
