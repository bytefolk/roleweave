import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals/ApprovalQueue";
import { ApprovalDetailDrawer } from "../src/approvals/ApprovalDetailDrawer";
import { DiffViewer } from "../src/approvals/DiffViewer";
import { TurnThread } from "../src/turns/TurnThread";
import type { ApprovalQueueItem } from "../src/approvals/types";
import type { TurnRecord } from "../src/turns/types";

function makeItem(overrides: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    approvalId: "appr-1",
    positionId: "engineer-1",
    positionName: "Software Engineer",
    category: "write",
    description: "Write database schema",
    target: "db/schema.sql",
    expiresAt: "2099-01-01T00:00:00.000Z",
    toolDeny: ["fs.write"],
    decision: { kind: "pending" },
    batchMaxItems: 10,
    canDecide: true,
    source: {
      kind: "session",
      positionId: "engineer-1",
      conversationId: "sess-1",
      turnId: "turn-1",
      runId: "run-1",
      engine: "qoder",
    },
    ...overrides,
  };
}

describe("Approval Center Enhancements (#456)", () => {
  const originalOwb = window.owb;

  afterEach(() => {
    window.owb = originalOwb;
    vi.clearAllMocks();
  });

  describe("DiffViewer component", () => {
    it("renders line numbers and addition/deletion diff lines", () => {
      const before = "const x = 1;\nconst y = 2;";
      const after = "const x = 1;\nconst y = 3;\nconst z = 4;";

      const { container } = render(<DiffViewer before={before} after={after} change="modify" />);

      const diffTable = container.querySelector(".owb-diff-table");
      expect(diffTable).toBeInTheDocument();

      const deleteRows = container.querySelectorAll(".owb-diff-row.is-delete");
      const addRows = container.querySelectorAll(".owb-diff-row.is-add");
      expect(deleteRows.length).toBe(1);
      expect(addRows.length).toBe(2);

      expect(container.textContent).toContain("const y = 2;");
      expect(container.textContent).toContain("const y = 3;");
      expect(container.textContent).toContain("const z = 4;");
    });

    it("renders pure additions when before is undefined", () => {
      const { container } = render(<DiffViewer after={"hello world\nsecond line"} change="add" />);
      const addRows = container.querySelectorAll(".owb-diff-row.is-add");
      expect(addRows.length).toBe(2);
      expect(container.querySelectorAll(".owb-diff-row.is-delete").length).toBe(0);
    });

    it("renders pure deletions when after is undefined", () => {
      const { container } = render(<DiffViewer before="removed content" change="delete" />);
      const deleteRows = container.querySelectorAll(".owb-diff-row.is-delete");
      expect(deleteRows.length).toBe(1);
      expect(container.querySelectorAll(".owb-diff-row.is-add").length).toBe(0);
    });

    it("safely handles edge cases like empty strings and undefined delete before", () => {
      // Undefined before on delete should not throw
      const { container: c1 } = render(<DiffViewer change="delete" />);
      expect(c1.querySelectorAll(".owb-diff-row").length).toBe(0);

      // Empty before with content after should add lines without ghost deletion
      const { container: c2 } = render(<DiffViewer before="" after={"first line\nsecond line"} />);
      expect(c2.querySelectorAll(".owb-diff-row.is-add").length).toBe(2);
      expect(c2.querySelectorAll(".owb-diff-row.is-delete").length).toBe(0);

      // Content before with empty after should delete lines without ghost addition
      const { container: c3 } = render(<DiffViewer before={"first line\nsecond line"} after="" />);
      expect(c3.querySelectorAll(".owb-diff-row.is-delete").length).toBe(2);
      expect(c3.querySelectorAll(".owb-diff-row.is-add").length).toBe(0);

      // Both empty strings should render no rows
      const { container: c4 } = render(<DiffViewer before="" after="" />);
      expect(c4.querySelectorAll(".owb-diff-row").length).toBe(0);
    });
  });

  describe("ApprovalDetailDrawer enhancements", () => {
    it("renders multi-party progress bar and my decision status tag", () => {
      const item = makeItem({
        policyProgress: {
          granted: 1,
          required: 2,
          escalated: false,
        },
      });

      render(
        <ApprovalDetailDrawer
          item={item}
          open={true}
          onClose={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );

      expect(screen.getByTestId("approval-policy-progress")).toBeInTheDocument();
      const decisionTag = screen.getByTestId("approval-my-decision-status");
      expect(decisionTag).toBeInTheDocument();
    });

    it("renders DiffViewer inside change preview section", () => {
      const item = makeItem({
        context: {
          risk: "medium",
          requestedCapability: "write",
          impact: "workspace_write",
          permissions: { mode: "approval_required", allowedTools: [], deniedTools: [] },
          preview: {
            status: "available",
            files: [
              {
                path: "src/main.ts",
                change: "modify",
                before: "line1\nline2",
                after: "line1\nline2_modified",
              },
            ],
          },
          scope: { allowed: ["once", "run"] },
        },
      });

      const { container } = render(
        <ApprovalDetailDrawer
          item={item}
          open={true}
          onClose={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );

      expect(screen.getByTestId("approval-change-preview")).toBeInTheDocument();
      expect(screen.getByTestId("approval-diff-viewer")).toBeInTheDocument();
    });

    it("fetches audit trail and renders server-validated tag with real event types", async () => {
      const auditMock = vi.fn().mockResolvedValue({
        status: 200,
        body: {
          approvalId: "appr-1",
          events: [
            {
              seq: 1,
              type: "requested",
              timestamp: "2026-09-23T10:00:00.000Z",
              actor: "qoder",
              hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            },
            {
              seq: 2,
              type: "decision",
              timestamp: "2026-09-23T10:05:00.000Z",
              actor: "operator",
              decision: "granted",
              scope: "once",
              previousHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
              hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            },
            {
              seq: 3,
              type: "escalated",
              timestamp: "2026-09-23T10:06:00.000Z",
              actor: "lead",
              hash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            },
            {
              seq: 4,
              type: "decision_reverted",
              timestamp: "2026-09-23T10:07:00.000Z",
              actor: "operator",
              hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            },
          ],
        },
      });

      window.owb = {
        ...window.owb,
        approvalAudit: auditMock,
      } as unknown as typeof window.owb;

      render(
        <ApprovalDetailDrawer
          item={makeItem()}
          open={true}
          onClose={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );

      await waitFor(() => {
        expect(auditMock).toHaveBeenCalledWith({ id: "appr-1" });
      });

      await waitFor(() => {
        expect(screen.getByTestId("audit-server-validated-tag")).toBeInTheDocument();
      });

      expect(screen.getByTestId("approval-audit-trail")).toBeInTheDocument();
      expect(document.querySelector('[data-audit-seq="1"]')).toBeInTheDocument();
      expect(document.querySelector('[data-audit-seq="2"]')).toBeInTheDocument();
      expect(document.querySelector('[data-audit-seq="3"]')).toBeInTheDocument();
      expect(document.querySelector('[data-audit-seq="4"]')).toBeInTheDocument();
      expect(screen.getByText("requested")).toBeInTheDocument();
      expect(screen.getByText("decision")).toBeInTheDocument();
      expect(screen.getByText("escalated")).toBeInTheDocument();
      expect(screen.getByText("decision_reverted")).toBeInTheDocument();
    });

    it("displays warning alert when server returns audit verification failure", async () => {
      const auditMock = vi.fn().mockResolvedValue({
        status: 500,
        body: {
          code: "approval_storage_failed",
          message: "Approval audit ledger verification failed",
        },
      });

      window.owb = {
        ...window.owb,
        approvalAudit: auditMock,
      } as unknown as typeof window.owb;

      render(
        <ApprovalDetailDrawer
          item={makeItem()}
          open={true}
          onClose={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );

      await waitFor(() => {
        expect(auditMock).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByText("Approval audit ledger verification failed")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("audit-server-validated-tag")).not.toBeInTheDocument();
    });
  });

  describe("ApprovalQueue enhancements", () => {
    it("pins select-all source boundary adversarially across turnId, runId, conversationId, positionId, and engine", async () => {
      const onDenyBatch = vi.fn().mockResolvedValue({ succeeded: ["appr-1", "appr-2"], failed: [] });
      const onApproveBatch = vi.fn();

      const baseSource = {
        kind: "session" as const,
        positionId: "engineer-1",
        conversationId: "sess-1",
        turnId: "turn-1",
        runId: "run-1",
        engine: "qoder" as const,
      };

      const item1 = makeItem({ approvalId: "appr-1", source: baseSource, batchMaxItems: 3 });
      const item2 = makeItem({ approvalId: "appr-2", source: baseSource, batchMaxItems: 3 });
      // Adversarial negative cases
      const itemDiffTurn = makeItem({ approvalId: "appr-diff-turn", source: { ...baseSource, turnId: "turn-2" }, batchMaxItems: 3 });
      const itemDiffRun = makeItem({ approvalId: "appr-diff-run", source: { ...baseSource, runId: "run-2" }, batchMaxItems: 3 });
      const itemDiffConv = makeItem({ approvalId: "appr-diff-conv", source: { ...baseSource, conversationId: "sess-2" }, batchMaxItems: 3 });
      const itemDiffPos = makeItem({ approvalId: "appr-diff-pos", source: { ...baseSource, positionId: "engineer-2" }, batchMaxItems: 3 });
      const itemDiffEngine = makeItem({ approvalId: "appr-diff-engine", source: { ...baseSource, engine: "codex" as any }, batchMaxItems: 3 });

      render(
        <ApprovalQueue
          items={[item1, item2, itemDiffTurn, itemDiffRun, itemDiffConv, itemDiffPos, itemDiffEngine]}
          onApprove={() => {}}
          onDeny={() => {}}
          onApproveBatch={onApproveBatch}
          onDenyBatch={onDenyBatch}
        />,
      );

      // Select first item checkbox
      const card1 = screen.getByTestId("approval-card-appr-1");
      const checkbox1 = within(card1).getByRole("checkbox");
      fireEvent.click(checkbox1);

      // "Select all in turn" button appears and count is ONLY 2 (item1 and item2)
      const selectAllBtn = screen.getByTestId("approval-batch-select-all-turn");
      expect(selectAllBtn).toBeInTheDocument();
      expect(selectAllBtn.textContent).toContain("2");

      // Click "Select all in turn"
      fireEvent.click(selectAllBtn);

      // Verify adversarial items remain UNSELECTED
      for (const id of ["appr-diff-turn", "appr-diff-run", "appr-diff-conv", "appr-diff-pos", "appr-diff-engine"]) {
        const card = screen.getByTestId(`approval-card-${id}`);
        const checkbox = within(card).getByRole("checkbox");
        expect(checkbox).not.toBeChecked();
      }

      // Bulk deny button is now enabled
      const denyBatchBtn = screen.getByTestId("approval-batch-deny-button");
      expect(denyBatchBtn).not.toBeDisabled();

      // Click Bulk Deny
      await act(async () => {
        fireEvent.click(denyBatchBtn);
      });
      expect(onDenyBatch).toHaveBeenCalledWith(["appr-1", "appr-2"]);
    });

    it("retains failed checkboxes selected when onDenyBatch returns partial failure for retry", async () => {
      const onDenyBatch = vi.fn().mockResolvedValue({ succeeded: ["appr-1"], failed: ["appr-2"] });
      const baseSource = {
        kind: "session" as const,
        positionId: "engineer-1",
        conversationId: "sess-1",
        turnId: "turn-1",
        runId: "run-1",
        engine: "qoder" as const,
      };

      const item1 = makeItem({ approvalId: "appr-1", source: baseSource, batchMaxItems: 3 });
      const item2 = makeItem({ approvalId: "appr-2", source: baseSource, batchMaxItems: 3 });

      render(
        <ApprovalQueue
          items={[item1, item2]}
          onApprove={() => {}}
          onDeny={() => {}}
          onApproveBatch={() => {}}
          onDenyBatch={onDenyBatch}
        />,
      );

      const checkbox1 = within(screen.getByTestId("approval-card-appr-1")).getByRole("checkbox");
      const checkbox2 = within(screen.getByTestId("approval-card-appr-2")).getByRole("checkbox");
      fireEvent.click(checkbox1);
      fireEvent.click(checkbox2);

      const denyBatchBtn = screen.getByTestId("approval-batch-deny-button");
      await act(async () => {
        fireEvent.click(denyBatchBtn);
      });

      expect(onDenyBatch).toHaveBeenCalledWith(["appr-1", "appr-2"]);
      expect(checkbox1).not.toBeChecked();
      expect(checkbox2).toBeChecked();
    });

    it("enforces batch-limit boundary when selecting all items in turn", () => {
      const baseSource = {
        kind: "session" as const,
        positionId: "engineer-1",
        conversationId: "sess-1",
        turnId: "turn-1",
        runId: "run-1",
        engine: "qoder" as const,
      };

      // 4 items available with batchMaxItems: 2
      const item1 = makeItem({ approvalId: "limit-1", source: baseSource, batchMaxItems: 2 });
      const item2 = makeItem({ approvalId: "limit-2", source: baseSource, batchMaxItems: 2 });
      const item3 = makeItem({ approvalId: "limit-3", source: baseSource, batchMaxItems: 2 });
      const item4 = makeItem({ approvalId: "limit-4", source: baseSource, batchMaxItems: 2 });

      render(
        <ApprovalQueue
          items={[item1, item2, item3, item4]}
          onApprove={() => {}}
          onDeny={() => {}}
          onApproveBatch={() => {}}
          onDenyBatch={() => {}}
        />,
      );

      // Select first item checkbox
      const card1 = screen.getByTestId("approval-card-limit-1");
      fireEvent.click(within(card1).getByRole("checkbox"));

      // Click "Select all in turn"
      const selectAllBtn = screen.getByTestId("approval-batch-select-all-turn");
      fireEvent.click(selectAllBtn);

      // Should only select up to batchMaxItems (2 items)
      expect(within(screen.getByTestId("approval-card-limit-1")).getByRole("checkbox")).toBeChecked();
      expect(within(screen.getByTestId("approval-card-limit-2")).getByRole("checkbox")).toBeChecked();
      expect(within(screen.getByTestId("approval-card-limit-3")).getByRole("checkbox")).not.toBeChecked();
      expect(within(screen.getByTestId("approval-card-limit-4")).getByRole("checkbox")).not.toBeChecked();
    });

    it("renders pagination controls when visible items exceed 20", () => {
      const items = Array.from({ length: 25 }, (_, i) =>
        makeItem({ approvalId: `appr-${i}`, description: `Action ${i}` }),
      );

      const { container } = render(
        <ApprovalQueue
          items={items}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );

      expect(container.querySelector(".ant-pagination")).toBeInTheDocument();
    });
  });

  describe("TurnThread enhancements", () => {
    it("renders in-thread approval card context and diff preview details", () => {
      const record: TurnRecord = {
        id: "turn-thread-1",
        positionId: "engineer-1",
        positionName: "Software Engineer",
        engine: "qoder",
        input: "Run migration",
        status: "running",
        createdAt: "2026-09-23T10:00:00.000Z",
        approvalRequest: {
          approvalId: "req-1",
          kind: "write",
          description: "Modify schema.sql",
          requestReason: "Adding audit column",
          context: {
            risk: "high",
            requestedCapability: "write",
            impact: "workspace_write",
            permissions: { mode: "approval_required", allowedTools: [], deniedTools: [] },
            preview: {
              status: "available",
              files: [{ path: "schema.sql", change: "modify", before: "col1 INT", after: "col1 INT\ncol2 TEXT" }],
            },
          },
          preview: {
            status: "available",
            files: [{ path: "schema.sql", change: "modify", before: "col1 INT", after: "col1 INT\ncol2 TEXT" }],
          },
        },
      };

      render(<TurnThread turns={[record]} onVerdict={() => {}} />);

      const previewElement = screen.getByTestId("in-thread-approval-preview");
      expect(previewElement).toBeInTheDocument();
      expect(previewElement.textContent).toContain("Adding audit column");
      expect(previewElement.textContent).toContain("[modify] schema.sql");
      expect(screen.getByTestId("approval-diff-viewer")).toBeInTheDocument();
    });

    it("applies is-focused-turn class and calls scrollIntoView when focusTurnId matches", () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;

      const record: TurnRecord = {
        id: "target-turn-123",
        positionId: "engineer-1",
        positionName: "Software Engineer",
        engine: "qoder",
        input: "Investigate log",
        status: "completed",
        createdAt: "2026-09-23T10:00:00.000Z",
      };

      const { container } = render(
        <TurnThread turns={[record]} focusTurnId="target-turn-123" />,
      );

      const turnItem = container.querySelector('[data-turn-id="target-turn-123"]');
      expect(turnItem).toBeInTheDocument();
      expect(turnItem?.classList.contains("is-focused-turn")).toBe(true);
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });
});
