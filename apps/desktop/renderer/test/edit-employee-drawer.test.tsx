import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.queryByDisplayValue("./knowledge/**")).not.toBeInTheDocument();
    const advanced = screen.getByRole("button", { name: /高级权限/ });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    // Opening the detailed controls must expose the full policy without
    // changing it or enabling a save.
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
    fireEvent.click(screen.getByRole("button", { name: /高级权限/ }));
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

  it("recognizes a restored tool allowlist as unchanged and omits it from a rename", async () => {
    const { onSave } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: /高级权限/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "文档工程师" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toEqual({ name: "文档工程师" });
  });

  it("a capability toggle preserves the tools, resource rules, and existing connector tools", async () => {
    const { onSave } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: /Issue 调研/ }));
    expect(screen.getByRole("button", { name: /高级权限/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0]![0] as { permissions: HirePermissions };
    expect(patch.permissions.tools).toEqual(POLICY.tools);
    expect(patch.permissions.rules.filter((rule) => !/^(skill|mcp):\/\//.test(rule.resource))).toEqual(POLICY.rules);
    expect(patch.permissions.skills).toEqual([...POLICY.skills!, { id: "issue-research" }]);
    expect(patch.permissions.mcpServers).toEqual(POLICY.mcpServers);
    expect(patch.permissions.rules).toContainEqual({ scope: "position", resource: "skill://issue-research", actions: ["execute"] });
  });

  it("keeps focus while editing a resource path", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: /高级权限/ }));
    const resource = screen.getByDisplayValue("./knowledge/**");
    resource.focus();
    fireEvent.change(resource, { target: { value: "./knowledge/team/**" } });
    expect(screen.getByDisplayValue("./knowledge/team/**")).toBe(resource);
    expect(resource).toHaveFocus();
    fireEvent.change(resource, { target: { value: "./knowledge/team/docs/**" } });
    expect(resource).toHaveFocus();
    expect(resource).toHaveValue("./knowledge/team/docs/**");
  });

  it("sends only execution mode when the mode changes", async () => {
    const { onSave } = renderDrawer();
    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("需批准"));
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toEqual({ mode: "approval_required" });
  });

  it("resets expanded permissions and unsaved edits when reopened for another employee", () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, name: "Another Employee" });
    const onClose = vi.fn();
    const drawer = (open: boolean, position: PositionCardData) => (
      <EditEmployeeDrawer open={open} position={position} busy={false} onClose={onClose} onSave={onSave} />
    );
    const view = render(drawer(true, POSITION));
    fireEvent.click(screen.getByRole("button", { name: /高级权限/ }));
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "Unsaved name" } });
    view.rerender(drawer(false, POSITION));
    const nextPosition = { ...POSITION, id: "another-employee", name: "Another Employee" };
    view.rerender(drawer(true, nextPosition));
    expect(screen.getByDisplayValue("Another Employee")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Unsaved name")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("./knowledge/**")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /高级权限/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
  });

  it("shows loading instead of an editable empty form while the employee record is unavailable", () => {
    renderDrawer({ position: null });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
  });

  it("locks the draft and close controls until a pending save finishes", async () => {
    let finishSave!: (outcome: { ok: false; code: string }) => void;
    const onSave = vi.fn(() => new Promise<{ ok: false; code: string }>((resolve) => { finishSave = resolve; }));
    const { onClose } = renderDrawer({ onSave });
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "文档工程师" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue("文档工程师")).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Issue 调研/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    expect(document.querySelector(".ant-drawer-close")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finishSave({ ok: false, code: "session_conflict" }));
    expect(screen.getByDisplayValue("文档工程师")).toBeEnabled();
    expect(screen.getByRole("button", { name: /取\s*消/ })).toBeEnabled();
    expect(document.querySelector(".ant-drawer-close")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
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
