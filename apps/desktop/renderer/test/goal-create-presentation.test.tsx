import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { GoalCreateDialog } from "../src/goals/GoalCreateDialog";
import type { OwbBridge } from "../src/owb";

function bridge(
  createGoal = vi
    .fn()
    .mockResolvedValue({ status: 201, body: { goalId: "project-one" } }),
) {
  window.owb = { createGoal } as unknown as OwbBridge;
  return createGoal;
}

describe("GoalCreateDialog presentation", () => {
  it("keeps the existing goal presentation by default", () => {
    bridge();
    render(<GoalCreateDialog open onClose={vi.fn()} />);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "创建目标" })).toBeDisabled();
    expect(dialog.getByLabelText("标题")).toBeVisible();
    expect(dialog.getByLabelText("描述")).toBeInTheDocument();
    expect(
      dialog.queryByRole("button", { name: "创建项目" }),
    ).not.toBeInTheDocument();
  });

  it("creates a project through the same durable container using project terms", async () => {
    const createGoal = bridge();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <GoalCreateDialog
        open
        presentation="projects"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("新建项目")).toBeInTheDocument();
    expect(dialog.queryByText("新建目标")).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("项目名称"), {
      target: { value: "  Agent delivery  " },
    });
    fireEvent.change(dialog.getByLabelText("项目说明"), {
      target: { value: "Visible work and schedules" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "添加验收标准" }));
    fireEvent.change(dialog.getByPlaceholderText("添加验收标准"), {
      target: { value: "Tasks survive a refresh" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("project-one"));
    expect(createGoal).toHaveBeenCalledWith({
      title: "Agent delivery",
      description: "Visible work and schedules",
      acceptanceCriteria: ["Tasks survive a refresh"],
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retains project input and uses project error text on failure", async () => {
    bridge(vi.fn().mockRejectedValue(new Error("offline")));
    const onClose = vi.fn();
    render(<GoalCreateDialog open presentation="projects" onClose={onClose} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("项目名称"), {
      target: { value: "Keep this project" },
    });
    fireEvent.change(dialog.getByLabelText("项目说明"), {
      target: { value: "Keep this description" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "创建项目" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "创建项目失败，请重试。",
    );
    expect(dialog.getByLabelText("项目名称")).toHaveValue("Keep this project");
    expect(dialog.getByLabelText("项目说明")).toHaveValue(
      "Keep this description",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses the English project catalog without goal terminology", () => {
    bridge();
    render(
      <OwbI18nProvider locale="en">
        <GoalCreateDialog open presentation="projects" onClose={vi.fn()} />
      </OwbI18nProvider>,
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByRole("button", { name: "Create project" }),
    ).toBeInTheDocument();
    expect(dialog.getByLabelText("Project name")).toBeInTheDocument();
    expect(dialog.getByLabelText("Project description")).toBeInTheDocument();
    expect(dialog.queryByText(/goal/i)).not.toBeInTheDocument();
  });

  it.each([
    ["功能交付", "交付一个新功能"],
    ["调研", "调研一个问题"],
    ["内容发布", "发布一份内容"],
  ])("creates an editable project draft from %s only after confirmation", async (name, title) => {
    const createGoal = bridge();
    render(<GoalCreateDialog open presentation="projects" onClose={vi.fn()} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name }));
    expect(dialog.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    expect(dialog.getByLabelText("项目名称")).toHaveValue(title);
    expect(dialog.getByLabelText("项目名称")).not.toBeVisible();
    const preview = within(dialog.getByRole("region", { name: "项目草稿" }));
    expect(preview.getByText(title)).toBeVisible();
    expect(preview.getByRole("list")).toBeVisible();
    expect(dialog.getByLabelText("项目说明")).not.toHaveValue("");
    expect(dialog.getAllByPlaceholderText("添加验收标准")).toHaveLength(3);
    expect(createGoal).not.toHaveBeenCalled();
    expect(dialog.getByRole("button", { name: "创建项目" })).toBeEnabled();
    fireEvent.click(dialog.getByText("调整内容"));
    expect(dialog.getByLabelText("项目名称")).toBeVisible();
    fireEvent.change(dialog.getAllByPlaceholderText("添加验收标准")[0]!, { target: { value: "Edited acceptance criterion" } });
    expect(preview.getByText("Edited acceptance criterion")).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledOnce());
    expect(createGoal.mock.calls[0]![0]).toEqual({ title, description: expect.any(String),
      acceptanceCriteria: ["Edited acceptance criterion", expect.any(String), expect.any(String)] });
    expect(Object.keys(createGoal.mock.calls[0]![0]).sort()).toEqual(["acceptanceCriteria", "description", "title"]);
  });

  it("preserves every preset's edits and the original custom draft when switching", () => {
    const createGoal = bridge();
    render(<GoalCreateDialog open onClose={vi.fn()} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("标题"), { target: { value: "My existing context" } });
    fireEvent.change(dialog.getByLabelText("描述"), { target: { value: "My own description" } });
    fireEvent.click(dialog.getByRole("button", { name: "添加标准" }));
    fireEvent.change(dialog.getByPlaceholderText("添加标准"), { target: { value: "My own criterion" } });
    fireEvent.click(dialog.getByRole("button", { name: "功能交付" }));
    fireEvent.click(dialog.getByText("调整内容"));
    fireEvent.change(dialog.getByLabelText("标题"), { target: { value: "Feature draft edits" } });
    fireEvent.change(dialog.getAllByPlaceholderText("添加标准")[1]!, { target: { value: "Feature criterion edits" } });
    fireEvent.click(dialog.getByRole("button", { name: "调研" }));
    expect(dialog.getByText("调研一个问题")).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "功能交付" }));
    fireEvent.click(dialog.getByText("调整内容"));
    expect(dialog.getByLabelText("标题")).toHaveValue("Feature draft edits");
    expect(dialog.getAllByPlaceholderText("添加标准")[1]!).toHaveValue("Feature criterion edits");
    fireEvent.click(dialog.getByRole("button", { name: "空白自定义" }));
    expect(dialog.getByLabelText("标题")).toHaveValue("My existing context");
    expect(dialog.getByLabelText("标题")).toBeVisible();
    expect(dialog.getByLabelText("描述")).toHaveValue("My own description");
    expect(dialog.getByPlaceholderText("添加标准")).toHaveValue("My own criterion");
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("uses English preset drafts for goals while preserving the goal confirmation action", async () => {
    const createGoal = bridge();
    render(<OwbI18nProvider locale="en"><GoalCreateDialog open onClose={vi.fn()} /></OwbI18nProvider>);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Research" }));
    expect(dialog.getByLabelText("Title")).toHaveValue("Research a question");
    expect(dialog.getByLabelText("Title")).not.toBeVisible();
    expect(dialog.getByRole("region", { name: "Plan draft" })).toHaveTextContent("Research a question");
    expect(dialog.getByText("Create directly from a template or adjust its draft first.")).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Create goal" }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ title: "Research a question" })));
  });

  it("retains template edits on API rejection and blocks duplicate confirmations", async () => {
    let finish!: (value: unknown) => void;
    const createGoal = bridge(vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    render(<GoalCreateDialog open presentation="projects" onClose={vi.fn()} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "功能交付" }));
    fireEvent.click(dialog.getByText("调整内容"));
    fireEvent.change(dialog.getByLabelText("项目名称"), { target: { value: "Keep this edited feature" } });
    const create = dialog.getByRole("button", { name: "创建项目" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(createGoal).toHaveBeenCalledOnce();
    expect(dialog.getByRole("button", { name: "调研" })).toBeDisabled();
    await act(async () => finish({ status: 503, body: { message: "Service unavailable" } }));
    expect(dialog.getByRole("alert")).toHaveTextContent("Service unavailable");
    expect(dialog.getByLabelText("项目名称")).toHaveValue("Keep this edited feature");
    expect(dialog.getByRole("button", { name: "功能交付" })).toHaveAttribute("aria-pressed", "true");
    expect(create).toBeEnabled();
  });

  it("discards an old pending result after close and reopen without unlocking a new request", async () => {
    const finishes: Array<(value: unknown) => void> = [];
    const createGoal = bridge(vi.fn().mockImplementation(() => new Promise(resolve => { finishes.push(resolve); })));
    const onClose = vi.fn(), onCreated = vi.fn();
    const props = { onClose, onCreated, presentation: "projects" as const };
    const view = render(<GoalCreateDialog open {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "功能交付" }));
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    view.rerender(<GoalCreateDialog open={false} {...props} />);
    view.rerender(<GoalCreateDialog open {...props} />);
    expect(screen.getByLabelText("项目名称")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "调研" }));
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await act(async () => finishes[0]!({ status: 201, body: { goalId: "old-project" } }));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /创建项目$/ }));
    expect(createGoal).toHaveBeenCalledTimes(2);
    await act(async () => finishes[1]!({ status: 201, body: { goalId: "new-project" } }));
    expect(onCreated).toHaveBeenCalledExactlyOnceWith("new-project");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("discards late callbacks after the create dialog unmounts", async () => {
    let finish!: (value: unknown) => void;
    bridge(vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    const onClose = vi.fn(), onCreated = vi.fn();
    const view = render(<GoalCreateDialog open onClose={onClose} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "功能交付" }));
    fireEvent.click(screen.getByRole("button", { name: "创建目标" }));
    view.unmount();
    await act(async () => finish({ status: 201, body: { goalId: "late-goal" } }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("does not apply a pending goal result to a newly opened project presentation", async () => {
    let finish!: (value: unknown) => void;
    bridge(vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    const onClose = vi.fn(), onCreated = vi.fn();
    const view = render(<GoalCreateDialog open onClose={onClose} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "功能交付" }));
    fireEvent.click(screen.getByRole("button", { name: "创建目标" }));
    view.rerender(<GoalCreateDialog open presentation="projects" onClose={onClose} onCreated={onCreated} />);
    expect(screen.getByLabelText("项目名称")).toHaveValue("");
    await act(async () => finish({ status: 503, body: { message: "Old goal error" } }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "调研" })).toBeEnabled();
  });

  it("confirms a project template directly from its preview without opening the editing fields", async () => {
    const createGoal = bridge();
    render(<GoalCreateDialog open presentation="projects" onClose={vi.fn()} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "功能交付" }));
    expect(dialog.getByLabelText("项目名称")).not.toBeVisible();
    expect(dialog.getByText("调整内容").closest("details")).not.toHaveAttribute("open");
    expect(dialog.getByRole("region", { name: "项目草稿" })).toHaveTextContent("交付一个新功能");
    expect(createGoal).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledOnce());
    expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ title: "交付一个新功能", acceptanceCriteria: expect.any(Array) }));
  });
});
