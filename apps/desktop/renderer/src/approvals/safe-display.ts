import { redactApprovalSecrets } from "@roleweave/shared/approval-redaction";

/** Presentation guard for records from an older control plane. */
export const safeApprovalText = redactApprovalSecrets;
