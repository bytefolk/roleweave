import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HirePermissions } from "@roleweave/shared";
import type { PositionCardData } from "@roleweave/ui";
import { EditEmployeeDrawer } from "../src/org/EditEmployeeDrawer";

const POLICY: HirePermissions = {
  tools: ["Read", "Grep", "Glob"],
  rules: [
    { scope: "position", resource: "./knowledge/**", actions: ["read"] },
    { scope: "workspace", resource: "./reports/**", actions: ["read", "create"], approval: true },
  ],
  skills: [{ id: "docs-review" }],
  mcpServers: [{ id: "issue-tracker", tools: ["search"] }],
};

const POSITION: PositionCardData = {
  id: "docs-writer",
  name: "Docs Writer",
  description: "Keeps documentation current.",
  reportTo: "repo-owner",
  mode: "read_only",
  contextScope: "/",
  permissions: { toolAllow: ["Read", "Grep", "Glob"], toolDeny: [] },
  permissionPolicy: POLICY,
  budget: { perTask: { tokens: 20000 }, perDay: { tokens: 200000 } },
  metadata: {},
};

function renderDrawer(overrides: {
  position?: PositionCardData | null;
  onSave?: (patch: unknown) => Promise<{ ok: true; name: string } | { ok: false; code: string }>;
} = {}) {
  const onSave = overrides.onSave ?? vi.fn().mockResolvedValue({ ok: true, name: "文档工程师" });
  const onClose = vi.fn();
  render(
    <EditEmployeeDrawer
      open
      position={overrides.position === undefined ? POSITION : overrides.position}
      busy={false}
      onClose={onClose}
      onSave={onSave as never}
    />,
  );
  return { onSave, onClose };
}

describe("EditEmployeeDrawer", () => {
  it("prefills the record and keeps saving disabled until something changes", () => {
    const { onSave } = renderDrawer();
    expect(screen.getByDisplayValue("Docs Writer")).toBeInTheDocument();
    // Every rule and grant the drawer is about to replace must be on screen.
    expect(screen.getByDisplayValue("./knowledge/**")).toBeInTheDocument();
    expect(screen.getByDisplayValue("./reports/**")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "保存改动" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("sends only the fields that moved, and never the position id", async () => {
    const { onSave, onClose } = renderDrawer();
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "文档工程师" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // A rename must not carry an untouched permission projection: the patch is
    // what the server compares against, so a smuggled copy could overwrite a
    // grant the operator never saw.
    expect(onSave.mock.calls[0]![0]).toEqual({ name: "文档工程师" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("round-trips the full permission projection when a grant is toggled", async () => {
    const { onSave } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = (onSave.mock.calls[0]![0]) as { permissions?: HirePermissions; name?: string };
    expect(patch.name).toBeUndefined();
    expect(patch.permissions?.tools).toEqual(["Read", "Grep", "Glob", "Write"]);
    expect(patch.permissions?.rules).toEqual(POLICY.rules);
    expect(patch.permissions?.skills).toEqual(POLICY.skills);
    expect(patch.permissions?.mcpServers).toEqual(POLICY.mcpServers);
  });

  it("a rejected save explains itself, keeps the drawer open, and preserves the edit", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, code: "session_conflict" });
    const { onClose } = renderDrawer({ onSave });
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "文档工程师" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("回合正在执行");
    expect(onClose).not.toHaveBeenCalled();
    // The operator's edit survives the failure, so a retry costs nothing.
    expect(screen.getByDisplayValue("文档工程师")).toBeInTheDocument();
  });

  it("an unexplained failure code is surfaced rather than swallowed", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, code: "workspace_org_budget_not_allocated" });
    renderDrawer({ onSave });
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "文档工程师" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("workspace_org_budget_not_allocated"));
  });

  it("an imported employee without a permission projection still opens with its tool summary", () => {
    const legacy: PositionCardData = { ...POSITION, permissionPolicy: undefined, permissions: { toolAllow: ["Read"], toolDeny: ["Exec"] } };
    renderDrawer({ position: legacy });
    expect(screen.getByDisplayValue("Docs Writer")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("./knowledge/**")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
  });

  it("keeps its header close button (the #301 removal is scoped to the create drawer)", () => {
    renderDrawer();
    // This drawer shares owb-hire-drawer-shell with the create drawer; its
    // working close control must survive the #301 change untouched (issue AC-004).
    expect(document.querySelector(".ant-drawer-close")).not.toBeNull();
  });
});
