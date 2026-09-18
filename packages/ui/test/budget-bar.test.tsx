import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BudgetBar } from "../src/budget-bar";

const DECLARED = {
  taskLimit: { tokens: 40000, iterations: 12 },
  dailyLimit: { tokens: 400000, iterations: 96 },
};

describe("BudgetBar (D1 spec §4 dual-phase contract)", () => {
  it("declaration mode renders two lanes with caps and no percentage", () => {
    render(<BudgetBar declared={DECLARED} format="full" />);
    const task = screen.getByRole("meter", { name: "单任务声明" });
    const daily = screen.getByRole("meter", { name: "单日声明" });
    expect(task).toHaveClass("is-declared");
    expect(daily).toHaveClass("is-declared");
    // #73: the primary cap is emphasised in its own <b> (设计稿 .val b), so the
    // lane value reads as one string only after normalising across elements.
    const values = Array.from(document.querySelectorAll(".ui-org-budget__value")).map(
      (node) => node.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(values).toContain("40,000 tokens · 12 iterations");
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("budget-not-allocated renders warning soft badge", () => {
    render(<BudgetBar declared={null} />);
    expect(screen.getByRole("status")).toHaveClass("ui-org-budget--missing");
    expect(screen.getByText("预算未配齐")).toBeInTheDocument();
  });

  it("consumption phase tiers: ok <80%, warning 80–100%, over >100%", () => {
    const { rerender } = render(
      <BudgetBar declared={DECLARED} consumption={0.5} dailyConsumption={0.5} format="full" />,
    );
    expect(screen.getByRole("meter", { name: "单任务消耗" })).toHaveClass("is-ok");
    expect(screen.getAllByText("50%")).toHaveLength(2);

    rerender(<BudgetBar declared={DECLARED} consumption={0.9} dailyConsumption={0.9} format="full" />);
    expect(screen.getByRole("meter", { name: "单任务消耗" })).toHaveClass("is-warning");
    expect(screen.getAllByText("90%")).toHaveLength(2);

    rerender(<BudgetBar declared={DECLARED} consumption={1.2} dailyConsumption={1.2} format="full" />);
    const overMeter = screen.getByRole("meter", { name: "单任务消耗" });
    expect(overMeter).toHaveClass("is-over");
    expect(screen.getAllByText("120%")).toHaveLength(2);
  });

  it("keeps a 309% over-budget fill inside its track while exposing the actual percentage", () => {
    render(<BudgetBar declared={DECLARED} consumption={3.09} format="full" />);
    const overMeter = screen.getByRole("meter", { name: "单任务消耗" });
    expect(overMeter).toHaveAttribute("aria-valuenow", "100");
    expect(overMeter).toHaveAttribute("aria-valuemax", "100");
    expect(overMeter).toHaveAttribute("aria-valuetext", "309%");
    expect(screen.getByText("309%")).toBeInTheDocument();
    const fill = overMeter.querySelector(".ui-org-budget__fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("compact format renders a single lane (label/value hidden via CSS, one meter)", () => {
    const { container } = render(<BudgetBar declared={DECLARED} format="compact" />);
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(container.querySelector(".ui-org-budget.is-compact")).not.toBeNull();
  });
});
