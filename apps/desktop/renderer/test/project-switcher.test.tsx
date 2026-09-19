import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInfoResponse } from "@roleweave/shared";
import { ProjectSwitcher } from "../src/project/ProjectSwitcher";

describe("ProjectSwitcher", () => {
  const workspace: WorkspaceInfoResponse = {
    open: true,
    path: "/tmp/oss-maintainer",
    business: "oss-maintainer",
  };

  it("carries the opened project's brand mark as its face — the tree below leads with people", () => {
    const { container } = render(<ProjectSwitcher workspace={workspace} dialogOpen={false} onOpen={vi.fn()} />);
    const icon = container.querySelector(".owb-project-switcher__icon");
    expect(icon?.querySelector('[data-brand="bytefolk-open-herd"]')).toBeTruthy();
    expect(screen.getByText("oss-maintainer")).toBeInTheDocument();
  });

  it("keeps the plain folder icon until a project is actually open", () => {
    const { container } = render(<ProjectSwitcher workspace={null} dialogOpen={false} onOpen={vi.fn()} />);
    const icon = container.querySelector(".owb-project-switcher__icon");
    expect(icon?.querySelector('[data-brand="bytefolk-open-herd"]')).toBeNull();
    expect(icon?.querySelector("svg")).toBeTruthy();
    const closed = render(<ProjectSwitcher workspace={{ open: false, path: "/tmp/x" }} dialogOpen={false} onOpen={vi.fn()} />);
    expect(closed.container.querySelector('[data-brand="bytefolk-open-herd"]')).toBeNull();
  });

  it("opens the workspace hub from the trigger", () => {
    const onOpen = vi.fn();
    render(<ProjectSwitcher workspace={workspace} dialogOpen={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
