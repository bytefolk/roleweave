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
  mcpServers: [],
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
  it("keeps Office tools and modes in the client while allowing a name-only edit", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, name: "Office reviewer" });
    render(<EditEmployeeDrawer open position={POSITION} engine="qwen-office-local" busy={false} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByText(/工具与审批由千问办公管理/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("./knowledge/**")).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Docs Writer"), { target: { value: "Office reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: "Office reviewer" }));
  });
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

  it("a capability toggle preserves the tools and resource rules", async () => {
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
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "工作方式" }));
    fireEvent.click(await screen.findByText("按文件夹授权操作"));
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
    expect(screen.getByRole("combobox", { name: "工作方式" })).toBeDisabled();
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

  it("explains an incompatible binding before saving and lets the user remove it", async () => {
    const position = { ...POSITION, permissionPolicy: {
      ...POLICY,
      mcpServers: [{ id: "repository" as const, tools: ["read"] }],
      rules: [...POLICY.rules, { scope: "workspace" as const, resource: "mcp://repository", actions: ["execute" as const] }],
    } };
    const { onSave } = renderDrawer({ position });
    fireEvent.click(screen.getByRole("button", { name: /Issue 调研/ }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("请先移除不可用的外部服务");
    fireEvent.click(screen.getByRole("button", { name: "移除不可用的连接器" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].permissions.mcpServers).toEqual([]);
    expect(onSave.mock.calls[0]![0].permissions.rules.some((rule: { resource: string }) => rule.resource.startsWith("mcp://"))).toBe(false);
  });

  it("configures editing tools and execution mode from a folder choice", async () => {
    const { onSave } = renderDrawer();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "./knowledge 的访问权限" }));
    fireEvent.click(await screen.findByText("查看和编辑"));
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0]![0] as { mode: string; permissions: HirePermissions };
    expect(patch.mode).toBe("approval_required");
    expect(patch.permissions.tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit"]);
    expect(patch.permissions.rules[0]).toEqual({ ...POLICY.rules[0], actions: ["read", "create", "update"], approval: true });
    expect(patch.permissions.rules[1]).toEqual(POLICY.rules[1]);
  });

  it("keeps a new folder editable while empty and explains why saving is disabled", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("路径为空");
    const folder = screen.getAllByPlaceholderText("例如 ./repos/my-project").at(-1)!;
    fireEvent.change(folder, { target: { value: "./" } });
    expect(folder).toHaveValue("./");
    fireEvent.change(folder, { target: { value: "./reports/" } });
    expect(folder).toHaveValue("./reports/");
    fireEvent.change(folder, { target: { value: "./reports" } });
    expect(folder).toHaveValue("./reports");
    expect(screen.getByRole("button", { name: "保存改动" })).toBeEnabled();
    fireEvent.change(folder, { target: { value: "" } });
    expect(folder).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
  });

  it("recognizes an internet-only change and saves the consent", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, name: POSITION.name });
    render(<EditEmployeeDrawer open position={POSITION} engine="codex-local" busy={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "允许连接互联网" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toEqual({ permissions: { ...POLICY, network: "host_policy" } });
  });

  it("recognizes native execution consent changed in the advanced controls", async () => {
    const { onSave } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: /高级权限/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "允许本机终端执行" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toEqual({ permissions: { ...POLICY, nativeExecution: true } });
  });

  it("builds the supported native policy from one explicit autonomous-work choice", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, name: POSITION.name });
    const position = { ...POSITION, permissionPolicy: {
      tools: ["Read", "Grep", "Glob"],
      rules: [{ scope: "workspace" as const, resource: "./reports/**", actions: ["read" as const] }],
      skills: [], mcpServers: [],
    } };
    render(<EditEmployeeDrawer open position={position} engine="codex-local" busy={false} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByText(/终端可读取本机文件/)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "./reports 的访问权限" }));
    fireEvent.click(await screen.findByText("自主工作"));
    expect(screen.getByText("可编辑、删除文件和运行命令，操作自动执行。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文档审校" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: "每次操作前让我确认" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const patch = onSave.mock.calls[0]![0];
    expect(patch.mode).toBe("approval_required");
    expect(patch.permissions.nativeExecution).toBe(true);
    expect(patch.permissions.network).toBeUndefined();
    expect(patch.permissions.tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "Delete", "Exec"]);
    expect(patch.permissions.rules).toEqual([{ scope: "workspace", resource: "./reports/**", actions: ["read", "create", "update", "delete", "execute"], approval: false }]);
  });

  it("allows revoking the last autonomous folder without leaving an invalid native policy", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, name: POSITION.name });
    const position: PositionCardData = { ...POSITION, mode: "approval_required", permissionPolicy: {
      tools: ["Read", "Write", "Edit", "Delete", "Exec"],
      nativeExecution: true,
      rules: [{ scope: "workspace", resource: "./reports/**", actions: ["read", "create", "update", "delete", "execute"], approval: false }],
      skills: [], mcpServers: [],
    } };
    render(<EditEmployeeDrawer open position={position} engine="codex-local" busy={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "移除文件夹 ./reports" }));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].permissions).toMatchObject({ nativeExecution: false, rules: [] });
  });

  it("checks inherited native permissions before activating them through the working mode", async () => {
    const onSave = vi.fn();
    const position = { ...POSITION, permissionPolicy: { ...POLICY, nativeExecution: true } };
    render(<EditEmployeeDrawer open position={position} engine="codex-local" busy={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "工作方式" }));
    fireEvent.click(await screen.findByText("按文件夹授权操作"));
    expect(screen.getByRole("button", { name: "保存改动" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("自主工作所需的工具尚未配齐");
    expect(onSave).not.toHaveBeenCalled();
  });
});
