import { redactApprovalSecrets } from "@roleweave/shared";

/** Presentation guard for records from an older control plane. */
export const safeApprovalText = redactApprovalSecrets;
