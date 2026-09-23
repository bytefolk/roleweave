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

    it("fetches cryptographic audit trail and renders verified tag for valid hash chain", async () => {
      const auditMock = vi.fn().mockResolvedValue({
        status: 200,
        body: {
          approvalId: "appr-1",
          events: [
            {
              seq: 1,
              type: "created",
              timestamp: "2026-09-23T10:00:00.000Z",
              actor: "qoder",
              hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            },
            {
              seq: 2,
              type: "decided",
              timestamp: "2026-09-23T10:05:00.000Z",
              actor: "operator",
              decision: "granted",
              scope: "once",
              previousHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
              hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
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
        expect(screen.getByTestId("audit-verified-tag")).toBeInTheDocument();
      });

      expect(screen.getByTestId("approval-audit-trail")).toBeInTheDocument();
      expect(document.querySelector('[data-audit-seq="1"]')).toBeInTheDocument();
      expect(document.querySelector('[data-audit-seq="2"]')).toBeInTheDocument();
    });
  });

  describe("ApprovalQueue enhancements", () => {
    it("supports select all tools from the same turn and batch deny", () => {
      const onDenyBatch = vi.fn();
      const onApproveBatch = vi.fn();

      const source = {
        kind: "session" as const,
        positionId: "engineer-1",
        conversationId: "sess-1",
        turnId: "turn-1",
        runId: "run-1",
        engine: "qoder" as const,
      };

      const item1 = makeItem({ approvalId: "appr-1", source });
      const item2 = makeItem({ approvalId: "appr-2", source });
      const item3 = makeItem({ approvalId: "appr-3", source });

      render(
        <ApprovalQueue
          items={[item1, item2, item3]}
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

      // "Select all in turn" button appears
      const selectAllBtn = screen.getByTestId("approval-batch-select-all-turn");
      expect(selectAllBtn).toBeInTheDocument();
      expect(selectAllBtn.textContent).toContain("3");

      // Click "Select all in turn"
      fireEvent.click(selectAllBtn);

      // Batch deny button is now enabled
      const denyBatchBtn = screen.getByTestId("approval-batch-deny-button");
      expect(denyBatchBtn).not.toBeDisabled();

      // Click Batch Deny
      fireEvent.click(denyBatchBtn);
      expect(onDenyBatch).toHaveBeenCalledWith(["appr-1", "appr-2", "appr-3"]);
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
          id: "req-1",
          category: "write",
          description: "Modify schema.sql",
          requestReason: "Adding audit column",
          context: {
            risk: "high",
            requestedCapability: "write",
            impact: "workspace_write",
            permissions: { mode: "approval_required", allowedTools: [], deniedTools: [] },
            preview: {
              status: "available",
              files: [{ path: "schema.sql", change: "modify" }],
            },
          },
          preview: {
            status: "available",
            files: [{ path: "schema.sql", change: "modify" }],
          },
        },
      };

      render(<TurnThread turns={[record]} onVerdict={() => {}} />);

      const previewElement = screen.getByTestId("in-thread-approval-preview");
      expect(previewElement).toBeInTheDocument();
      expect(previewElement.textContent).toContain("Adding audit column");
      expect(previewElement.textContent).toContain("[modify] schema.sql");
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
