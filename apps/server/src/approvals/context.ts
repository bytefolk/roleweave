import { redactApprovalSecrets } from "@roleweave/shared/approval-redaction";
import type { ApprovalChangePreview, ApprovalContext, ApprovalRequestedEvent, OrgRole } from "@roleweave/shared";

const MAX_SUMMARY_BYTES = 2048;

/** Keep secrets out of the human-facing approval projection. The durable turn
 * and approval records retain the engine contract for source validation, but
 * the approval view only exposes this bounded presentation summary. */
export function redactApprovalText(value: string): string {
  const result = redactApprovalSecrets(value);
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes <= MAX_SUMMARY_BYTES) return result;
  return `${Buffer.from(result, "utf8").subarray(0, MAX_SUMMARY_BYTES - 3).toString("utf8")}...`;
}

function capabilityContext(kind: ApprovalRequestedEvent["action"]["kind"]): Pick<ApprovalContext, "risk" | "impact"> {
  switch (kind) {
    case "write": return { risk: "high", impact: "workspace_write" };
    case "exec": return { risk: "high", impact: "command_execution" };
    case "network": return { risk: "high", impact: "external_network" };
    case "tool": return { risk: "medium", impact: "restricted_tool" };
  }
}

export function projectApprovalPreview(preview: ApprovalChangePreview): Extract<ApprovalContext["preview"], { status: "available" }> {
  return {
    status: "available",
    ...preview,
    files: preview.files.map(file => ({
      ...file,
      path: redactApprovalText(file.path),
      ...(file.before === undefined ? {} : { before: redactApprovalText(file.before) }),
      ...(file.after === undefined ? {} : { after: redactApprovalText(file.after) }),
    })),
  };
}

export function buildApprovalContext(
  action: ApprovalRequestedEvent["action"],
  role: Pick<OrgRole, "mode" | "toolAllow" | "toolDeny">,
): ApprovalContext {
  return {
    ...capabilityContext(action.kind),
    requestedCapability: action.kind,
    ...(action.target ? { parameterSummary: redactApprovalText(action.target) } : {}),
    permissions: {
      mode: role.mode,
      allowedTools: role.toolAllow.slice(0, 128),
      deniedTools: role.toolDeny.slice(0, 128),
    },
    preview: action.preview
      ? projectApprovalPreview(action.preview)
      : { status: "unavailable", reason: "engine_preview_not_supplied" },
  };
}
