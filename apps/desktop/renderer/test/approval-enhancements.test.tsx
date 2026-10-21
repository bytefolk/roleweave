import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals/ApprovalQueue";
import { ApprovalDetail } from "../src/approvals/ApprovalDetail";
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

  describe("ApprovalDetail enhancements", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z");
    const noop = () => {};
    const detail = (item: ApprovalQueueItem | null, props: Partial<Parameters<typeof ApprovalDetail>[0]> = {}) => (
      <ApprovalDetail item={item} now={now} onApprove={noop} onDeny={noop} {...props} />
    );
    const openDisclosure = (testId: string) => {
      const disclosure = screen.getByTestId(testId);
      expect(disclosure.tagName).toBe("DETAILS");
      if (!disclosure.hasAttribute("open")) fireEvent.click(disclosure.querySelector("summary")!);
      expect(disclosure).toHaveAttribute("open");
      return disclosure;
    };
    const auditResponse = (approvalId: string, actor: string) => ({
      status: 200,
      body: {
        approvalId,
        events: [{
          approvalId, seq: 1, type: "requested", actor,
          timestamp: "2026-09-26T10:00:00.000Z",
          policyVersion: "1", policyDigest: "policy-digest", hash: `sha256:${actor}`,
        }],
      },
    });
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }
    const installAudit = (approvalAudit: ReturnType<typeof vi.fn>) => {
      window.owb = { ...window.owb, approvalAudit } as unknown as typeof window.owb;
    };

    it("renders multi-party progress bar and my decision status tag", () => {
      const item = makeItem({
        policyProgress: {
          granted: 1,
          required: 2,
          pending: 1,
          escalated: false,
        },
      });

      render(detail(item));

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

      const { container } = render(detail(item));

      const preview = within(container).getByTestId("approval-change-preview");
      expect(preview).toBeVisible();
      expect(preview.closest("details")).toBeNull();
      expect(within(preview).getByTestId("approval-diff-viewer")).toBeVisible();
      expect(preview.querySelector(".is-delete")).toHaveTextContent("line2");
      expect(preview.querySelector(".is-add")).toHaveTextContent("line2_modified");
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

      render(detail(makeItem()));
      openDisclosure("approval-audit-trail");

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

      render(detail(makeItem()));
      openDisclosure("approval-audit-trail");

      await waitFor(() => {
        expect(auditMock).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByText("Approval audit ledger verification failed")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("audit-server-validated-tag")).not.toBeInTheDocument();
    });

    it("renders in its container without a dialog, with visible risk and footer actions outside the scrolling body", () => {
      const onApprove = vi.fn();
      const onDeny = vi.fn();
      const onNext = vi.fn();
      const item = makeItem({
        positionMode: "read_only",
        requestReason: "A schema migration is required",
        context: {
          risk: "high", riskOverlay: "medium", requestedCapability: "write", impact: "workspace_write",
          parameterSummary: "Update audit column",
          permissions: { mode: "read_only", allowedTools: ["fs.read"], deniedTools: ["fs.write"] },
          preview: { status: "unavailable", reason: "engine_preview_not_supplied" },
          scope: { allowed: ["once"] },
        },
      });
      const { container } = render(detail(item, { onApprove, onDeny, onNext }));
      const root = within(container).getByTestId("approval-detail");
      expect(root.tagName).toBe("SECTION");
      expect(root).toHaveClass("owb-approval-detail");
      expect(root).not.toHaveClass("owb-approval-drawer");
      expect(root).toHaveAttribute("aria-label");
      expect(root).toHaveAttribute("data-approval-id", "appr-1");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const header = root.querySelector<HTMLElement>(".owb-approval-detail__header")!;
      expect(within(header).getByRole("heading", { level: 2, name: "Write database schema" })).toBeVisible();
      expect(within(header).getByTestId("approval-rule-risk")).toBeVisible();
      expect(within(header).getByTestId("approval-risk-overlay")).toBeVisible();
      const body = root.querySelector<HTMLElement>(".owb-approval-detail__body")!;
      expect(within(body).getByText("Write database schema")).toBeVisible();
      expect(within(body).getByText("db/schema.sql")).toBeVisible();
      expect(within(body).getByText("A schema migration is required")).toBeVisible();
      expect(within(body).getByText("Update audit column")).toBeVisible();
      expect(within(body).queryByTestId("approval-change-preview")).not.toBeInTheDocument();
      const footer = root.querySelector<HTMLElement>(".owb-approval-detail__footer")!;
      expect(body.contains(footer)).toBe(false);
      expect(within(footer).getByTestId("approval-reason-input")).toBeVisible();
      expect(within(footer).getByTestId("approval-approve-button")).toBeVisible();
      expect(within(footer).getByTestId("approval-deny-button")).toBeVisible();
      fireEvent.click(within(footer).getByRole("button", { name: "下一条" }));
      expect(onNext).toHaveBeenCalledOnce();
      expect(onApprove).not.toHaveBeenCalled();
      expect(onDeny).not.toHaveBeenCalled();
    });

    it("shows only a simple inline prompt when no request is selected", () => {
      const audit = vi.fn();
      installAudit(audit);
      const { container } = render(detail(null));
      const root = within(container).getByTestId("approval-detail");
      expect(root).not.toHaveAttribute("data-approval-id");
      expect(root.textContent?.trim()).not.toBe("");
      expect(within(root).queryByRole("heading")).not.toBeInTheDocument();
      expect(within(root).queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(audit).not.toHaveBeenCalled();
    });

    it("keeps permissions and source references in disclosures with working navigation callbacks", () => {
      const onOpenSource = vi.fn();
      const onOpenEvidence = vi.fn();
      const item = makeItem({
        executionTurnId: "recovery-1",
        context: {
          risk: "medium", requestedCapability: "write", impact: "workspace_write",
          permissions: { mode: "approval_required", allowedTools: ["fs.read"], deniedTools: ["fs.write"] },
          preview: { status: "unavailable", reason: "engine_preview_not_supplied" }, scope: { allowed: ["once"] },
        },
      });
      const { rerender } = render(detail(item, { onOpenSource, onOpenEvidence }));
      const permissions = openDisclosure("approval-permissions");
      expect(within(permissions).getByText("fs.read")).toBeVisible();
      expect(within(permissions).getByText("fs.write")).toBeVisible();
      const source = openDisclosure("approval-source-references");
      for (const value of ["sess-1", "turn-1", "run-1", "recovery-1"]) {
        expect(within(source).getByText(value)).toBeVisible();
      }
      const buttons = within(source).getAllByRole("button");
      fireEvent.click(buttons[0]!);
      fireEvent.click(buttons[1]!);
      expect(onOpenSource).toHaveBeenCalledWith(item);
      expect(onOpenEvidence).toHaveBeenCalledWith(item);
      rerender(detail({ ...item, source: { ...item.source!, kind: "group" } }, { onOpenSource }));
      expect(within(source).getAllByRole("button").every((button) => button.hasAttribute("disabled"))).toBe(true);
    });

    it("defaults to once implicitly and only sends run scope after an explicit eligible selection", () => {
      const onApprove = vi.fn();
      const onDeny = vi.fn();
      const item = makeItem();
      const { rerender } = render(detail(item, { onApprove, onDeny }));
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      expect(onApprove).toHaveBeenLastCalledWith("appr-1", undefined);
      rerender(detail({ ...item, scopeAllowed: ["once", "run"] }, { onApprove, onDeny }));
      const radios = screen.getAllByRole("radio");
      expect(radios[0]).toBeChecked();
      fireEvent.click(radios[1]!);
      fireEvent.change(screen.getByTestId("approval-reason-input"), { target: { value: "  checked migration  " } });
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      expect(onApprove).toHaveBeenLastCalledWith("appr-1", "checked migration", "run");
      fireEvent.click(screen.getByTestId("approval-deny-button"));
      expect(onDeny).toHaveBeenLastCalledWith("appr-1", "checked migration");
      rerender(detail({ ...item, scopeAllowed: ["once"] }, { onApprove, onDeny }));
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      expect(onApprove).toHaveBeenLastCalledWith("appr-1", "checked migration");
    });

    it("resets reason and run scope before a newly selected request can submit", () => {
      const onApprove = vi.fn();
      const first = makeItem({ scopeAllowed: ["once", "run"] });
      // The callback ref observes commit-time state, before passive reset effects.
      function Selection({ item }: { item: ApprovalQueueItem }) {
        return <div ref={(node) => {
          if (node && item.approvalId === "appr-2") {
            screen.getByTestId("approval-approve-button").click();
          }
        }}>{detail(item, { onApprove })}</div>;
      }
      const { rerender } = render(<Selection item={first} />);
      fireEvent.change(screen.getByTestId("approval-reason-input"), { target: { value: "first request only" } });
      fireEvent.click(screen.getAllByRole("radio")[1]!);
      rerender(<Selection item={{ ...first, approvalId: "appr-2" }} />);
      expect(onApprove).toHaveBeenCalledOnce();
      expect(onApprove).toHaveBeenCalledWith("appr-2", undefined);
      expect(screen.getByTestId("approval-reason-input")).toHaveValue("");
      expect(screen.getAllByRole("radio")[0]).toBeChecked();
    });

    it("retains reason and selected scope on the same request after a failed submission", () => {
      const onApprove = vi.fn();
      const item = makeItem({ scopeAllowed: ["once", "run"] });
      const { rerender } = render(detail(item, { onApprove }));
      fireEvent.change(screen.getByTestId("approval-reason-input"), { target: { value: "retry unchanged" } });
      fireEvent.click(screen.getAllByRole("radio")[1]!);
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      rerender(detail({ ...item, busy: true }, { onApprove }));
      expect(screen.getByTestId("approval-approve-button")).toBeDisabled();
      rerender(detail({ ...item, error: "Submission unconfirmed" }, { onApprove }));
      expect(screen.getByTestId("approval-reason-input")).toHaveValue("retry unchanged");
      expect(screen.getAllByRole("radio")[1]).toBeChecked();
      const footer = screen.getByTestId("approval-detail").querySelector<HTMLElement>(".owb-approval-detail__footer")!;
      expect(within(footer).getByText("Submission unconfirmed")).toBeVisible();
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      expect(onApprove).toHaveBeenCalledTimes(2);
      expect(onApprove).toHaveBeenLastCalledWith("appr-1", "retry unchanged", "run");
    });

    it.each([
      ["decided", { decision: { kind: "denied" } }],
      ["cancelled", { decision: { kind: "cancelled" } }],
      ["indeterminate", { decision: { kind: "indeterminate" } }],
      ["expired", { expiresAt: "2026-09-26T12:00:00.000Z" }],
      ["invalid expiry", { expiresAt: "invalid" }],
      ["busy", { busy: true }],
      ["unavailable", { canDecide: false, unavailableReason: "session_missing" }],
    ] satisfies [string, Partial<ApprovalQueueItem>][])("blocks both verdict callbacks for %s requests", (_name, overrides) => {
      const onApprove = vi.fn();
      const onDeny = vi.fn();
      render(detail(makeItem(overrides), { onApprove, onDeny }));
      for (const id of ["approval-approve-button", "approval-deny-button"]) {
        expect(screen.getByTestId(id)).toBeDisabled();
        fireEvent.click(screen.getByTestId(id));
      }
      expect(onApprove).not.toHaveBeenCalled();
      expect(onDeny).not.toHaveBeenCalled();
    });

    it("enforces 1024 trimmed UTF-8 bytes without preventing reason correction", () => {
      const onApprove = vi.fn();
      render(detail(makeItem(), { onApprove }));
      const input = screen.getByTestId("approval-reason-input");
      fireEvent.change(input, { target: { value: "界".repeat(342) } });
      expect(input).not.toBeDisabled();
      expect(screen.getByTestId("approval-approve-button")).toBeDisabled();
      expect(screen.getByTestId("approval-deny-button")).toBeDisabled();
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      expect(onApprove).not.toHaveBeenCalled();
      const boundary = `${"界".repeat(341)}x`;
      fireEvent.change(input, { target: { value: ` ${boundary} ` } });
      expect(screen.getByTestId("approval-approve-button")).not.toBeDisabled();
      fireEvent.click(screen.getByTestId("approval-approve-button"));
      expect(onApprove).toHaveBeenCalledWith("appr-1", boundary);
    });

    it("redacts sensitive summaries and real diff content rather than inventing a preview", () => {
      const { container } = render(detail(makeItem({
        description: "token=description-secret", target: "https://example.com/?token=target-secret",
        requestReason: "password=request-secret",
        context: {
          risk: "high", requestedCapability: "write", impact: "workspace_write",
          parameterSummary: "api_key=parameter-secret",
          permissions: { mode: "approval_required", allowedTools: [], deniedTools: [] },
          preview: { status: "available", files: [{
            path: "config.txt", change: "modify", before: "token=before-secret", after: "token=after-secret",
          }] },
          scope: { allowed: ["once", "run"] },
        },
      })));
      for (const secret of ["description-secret", "target-secret", "request-secret", "parameter-secret", "before-secret", "after-secret"]) {
        expect(container.textContent).not.toContain(secret);
      }
      expect(container.textContent).toContain("[redacted]");
      expect(within(container).getByTestId("approval-diff-viewer")).toBeVisible();
      // Context scope is descriptive; only scopeAllowed authorizes run grants.
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    });

    it("distinguishes a saved decision from failed execution and keeps feedback in the footer", () => {
      render(detail(makeItem({
        decision: { kind: "granted", scope: "run", decidedAt: "2026-09-26T11:00:00Z", decidedBy: "reviewer" },
        executionPhase: "failed", executionErrorCode: "execution_fixture_failed",
      })));
      const lifecycle = screen.getByTestId("approval-lifecycle");
      expect(lifecycle.querySelector(".is-granted")).toBeInTheDocument();
      expect(lifecycle.querySelector(".is-failed")).toHaveTextContent("execution_fixture_failed");
      expect(lifecycle).toHaveTextContent("reviewer");
      const footer = screen.getByTestId("approval-detail").querySelector<HTMLElement>(".owb-approval-detail__footer")!;
      expect(within(footer).getAllByRole("alert").length).toBeGreaterThanOrEqual(2);
      expect(within(footer).getByTestId("approval-approve-button")).toBeDisabled();
    });

    it("refreshes audit when the verdict and execution phase change without refetching on clock ticks", async () => {
      const audit = vi.fn()
        .mockResolvedValueOnce(auditResponse("appr-1", "requested-actor"))
        .mockResolvedValueOnce(auditResponse("appr-1", "decided-actor"))
        .mockResolvedValueOnce(auditResponse("appr-1", "completed-actor"));
      installAudit(audit);
      const item = makeItem({ executionPhase: "not_started" });
      const { rerender } = render(detail(item));
      openDisclosure("approval-audit-trail");
      expect(await screen.findByText("requested-actor")).toBeVisible();
      rerender(detail(item, { now: now + 60_000 }));
      expect(audit).toHaveBeenCalledTimes(1);
      const decided = { ...item, decision: { kind: "granted" as const, scope: "once" as const } };
      rerender(detail(decided));
      expect(await screen.findByText("decided-actor")).toBeVisible();
      rerender(detail({ ...decided, executionPhase: "completed" }));
      expect(await screen.findByText("completed-actor")).toBeVisible();
      expect(screen.queryByText("requested-actor")).not.toBeInTheDocument();
      expect(screen.queryByText("decided-actor")).not.toBeInTheDocument();
      expect(audit).toHaveBeenCalledTimes(3);
      expect(audit).toHaveBeenLastCalledWith({ id: "appr-1" });
    });

    it("clears previous audit data synchronously on identity change", async () => {
      const pending = deferred<ReturnType<typeof auditResponse>>();
      installAudit(vi.fn().mockResolvedValueOnce(auditResponse("appr-1", "old-actor")).mockReturnValueOnce(pending.promise));
      const snapshots: string[] = [];
      function Selection({ item }: { item: ApprovalQueueItem }) {
        return <div ref={(node) => {
          if (node && item.approvalId === "appr-2") snapshots.push(document.body.textContent ?? "");
        }}>{detail(item)}</div>;
      }
      const { rerender } = render(<Selection item={makeItem()} />);
      openDisclosure("approval-audit-trail");
      expect(await screen.findByText("old-actor")).toBeVisible();
      rerender(<Selection item={makeItem({ approvalId: "appr-2" })} />);
      openDisclosure("approval-audit-trail");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).not.toContain("old-actor");
      expect(screen.queryByTestId("audit-server-validated-tag")).not.toBeInTheDocument();
      await act(async () => pending.resolve(auditResponse("appr-2", "new-actor")));
      expect(screen.getByText("new-actor")).toBeInTheDocument();
    });

    it.each(["resolve", "reject"] as const)("ignores an old request's late audit %s after selection changes", async (outcome) => {
      const old = deferred<ReturnType<typeof auditResponse>>();
      const current = deferred<ReturnType<typeof auditResponse>>();
      installAudit(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
      const { rerender } = render(detail(makeItem()));
      rerender(detail(makeItem({ approvalId: "appr-2" })));
      openDisclosure("approval-audit-trail");
      await act(async () => current.resolve(auditResponse("appr-2", "current-actor")));
      await act(async () => {
        if (outcome === "resolve") old.resolve(auditResponse("appr-1", "stale-actor"));
        else old.reject(new Error("stale-audit-error"));
      });
      expect(screen.getByText("current-actor")).toBeInTheDocument();
      expect(screen.queryByText("stale-actor")).not.toBeInTheDocument();
      expect(screen.queryByText("stale-audit-error")).not.toBeInTheDocument();
    });

    it("ignores an out-of-order audit refresh for an earlier phase of the same request", async () => {
      const earlier = deferred<ReturnType<typeof auditResponse>>();
      const later = deferred<ReturnType<typeof auditResponse>>();
      const audit = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
      installAudit(audit);
      const item = makeItem({ decision: { kind: "granted", scope: "once" }, executionPhase: "starting" });
      const { rerender } = render(detail(item));
      openDisclosure("approval-audit-trail");
      rerender(detail({ ...item, executionPhase: "completed" }));
      await act(async () => later.resolve(auditResponse("appr-1", "latest-phase-actor")));
      await act(async () => earlier.resolve(auditResponse("appr-1", "stale-phase-actor")));
      expect(screen.getByText("latest-phase-actor")).toBeInTheDocument();
      expect(screen.queryByText("stale-phase-actor")).not.toBeInTheDocument();
      expect(audit).toHaveBeenCalledTimes(2);
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
