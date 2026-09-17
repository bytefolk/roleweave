import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HireDrawer } from "../src/org/HireDrawer";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";

// #301: the create drawer's header close button looked actionable, but its
// handler was phase-gated, so in the in-flight phases it silently swallowed
// the click while the same pane showed a disabled 执行中不可取消 button. The
// control is removed outright (the issue's Option A); these tests pin the
// markup contract so a header × cannot quietly reappear on the create drawer.

const AVAILABILITY: Record<TurnEngine, TurnEngineAvailability> = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
  workbuddy: { configured: true, ready: true },
};

function renderCreateDrawer() {
  const onClose = vi.fn();
  render(
    <HireDrawer
      open
      positions={[]}
      presetReportTo={null}
      engine="qoder"
      engineAvailability={AVAILABILITY}
      conversationHostId={null}
      onClose={onClose}
      onHired={vi.fn()}
    />,
  );
  return { onClose };
}

describe("HireDrawer header close control (#301)", () => {
  it("renders the create drawer without a header close button", () => {
    renderCreateDrawer();
    // The drawer must actually be on screen for the absence to mean anything.
    expect(screen.getByText("创建数字员工")).toBeInTheDocument();
    // Markup-level contract (issue AC-001): nothing matching the drawer-shell
    // close selector may exist. closable={false} is static, so the button is
    // absent in every phase, not just the editable pane mounted here.
    expect(document.querySelector(".owb-hire-drawer-shell .ant-drawer-close")).toBeNull();
  });

  it("the editable pane still closes through the footer 取消", () => {
    const { onClose } = renderCreateDrawer();
    // Issue AC-002: with the header × gone, the explicit footer 取消 remains
    // the pane's visible close affordance and must still reach onClose.
    // antd inserts a space between two-CJK-character button labels (取 消),
    // so the name is matched with a whitespace-tolerant regex.
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
