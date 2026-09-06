import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectCreateDrawer } from "../src/project/ProjectCreateDrawer";
import type { OwbBridge } from "../src/owb";

describe("ProjectCreateDrawer", () => {
  it("generates a safe project id and submits the project contract", async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      status: 201,
      body: {
        open: true,
        created: true,
        next: "create_employee",
        path: "/tmp/content-ops",
        business: "内容运营",
        owner: "project-owner",
      },
    });
    window.owb = { createWorkspace } as unknown as OwbBridge;
    const onCreated = vi.fn();

    render(<ProjectCreateDrawer open onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), {
      target: { value: "内容运营" },
    });

    expect(screen.queryByRole("textbox", { name: /项目 ID/ })).not.toBeInTheDocument();
    expect(screen.getByText("项目标识由平台根据名称自动生成，无需手动填写。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择位置并创建" }));

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        projectId: expect.stringMatching(/^project-[a-z0-9]+$/),
        business: "内容运营",
        description: "",
      });
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
