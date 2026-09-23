import {
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
    expect(dialog.getByLabelText("标题")).toBeInTheDocument();
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
});
