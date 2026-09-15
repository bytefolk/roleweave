import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrgWorkspaceSplit } from "../src/org/OrgWorkspaceSplit";

function renderSplit() {
  return render(
    <OrgWorkspaceSplit
      ariaLabel="调整组织工作区面板宽度"
      left={<section aria-label="组织图和岗位档案">left</section>}
      resetTitle="拖拽调整宽度；双击或按 0 复位"
      right={<section aria-label="岗位对话">right</section>}
      valueText={(value) => `左侧面板 ${value}%`}
    />,
  );
}

describe("organization workspace splitter", () => {
  it("renders the existing panels around an accessible vertical separator", () => {
    renderSplit();
    expect(screen.getByLabelText("组织图和岗位档案")).toBeInTheDocument();
    expect(screen.getByLabelText("岗位对话")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整组织工作区面板宽度" })).toHaveAttribute("aria-valuenow", "50");
  });

  it("supports keyboard resize, bounds and reset", () => {
    renderSplit();
    const splitter = screen.getByRole("separator", { name: "调整组织工作区面板宽度" });

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter).toHaveAttribute("aria-valuenow", "52");

    fireEvent.keyDown(splitter, { key: "End" });
    expect(splitter).toHaveAttribute("aria-valuenow", "72");

    fireEvent.keyDown(splitter, { key: "0" });
    expect(splitter).toHaveAttribute("aria-valuenow", "50");

    fireEvent.doubleClick(splitter);
    expect(splitter).toHaveAttribute("aria-valuenow", "50");
  });

  it("uses pointer movement only while the separator is being dragged", () => {
    const { container } = renderSplit();
    const host = container.querySelector(".owb-org-module") as HTMLDivElement;
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 100, width: 1000 }),
    });
    const splitter = screen.getByRole("separator", { name: "调整组织工作区面板宽度" });

    fireEvent(splitter, new MouseEvent("pointermove", { clientX: 800, bubbles: true }));
    expect(splitter).toHaveAttribute("aria-valuenow", "50");

    fireEvent(splitter, new MouseEvent("pointerdown", { button: 0, clientX: 600, bubbles: true }));
    fireEvent(splitter, new MouseEvent("pointermove", { clientX: 800, bubbles: true }));
    expect(splitter).toHaveAttribute("aria-valuenow", "70");
    fireEvent(splitter, new MouseEvent("pointerup", { bubbles: true }));
  });
});
