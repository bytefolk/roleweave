import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { visibleSelectOptions } from "./select-helper";
import { EngineSelect } from "../src/turns";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns";

/** #94 defect 2: the Agent Host picker was narrower than its own longest
 * option, so the trigger *and* the dropdown (which inherited the trigger width)
 * both ellipsised `Claude Code · 本地登录 · Configured`. The split fixed here is
 * the invariant worth pinning: the trigger carries a label that fits its real
 * width, and the dropdown carries the full text including the readiness suffix.
 * The column widths themselves are guarded in apps/desktop/test/agent-host-width. */

const availability: Record<TurnEngine, TurnEngineAvailability> = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: false, ready: false },
  codex: { configured: false, ready: false },
  "codex-local": { configured: false, ready: false },
};

const ENGINES: TurnEngine[] = ["qoder", "claude-code", "claude-local"];

function Picker({ initial }: { initial: TurnEngine }) {
  const [engine, setEngine] = useState<TurnEngine>(initial);
  return (
    <EngineSelect
      engines={ENGINES}
      engineAvailability={availability}
      value={engine}
      onChange={setEngine}
    />
  );
}

/** The trigger's rendered content. antd 6 puts it in `.ant-select-content`. */
function triggerText(): string {
  const content = document.querySelector(".ant-select-content");
  if (content === null) throw new Error("Agent Host trigger rendered no content");
  return content.textContent ?? "";
}

describe("Agent Host picker (#94)", () => {
  // The longest label is the one that used to be cut mid-CJK.
  it("shows the selected host in full in the trigger, without the readiness suffix", () => {
    render(<Picker initial="claude-local" />);

    expect(triggerText()).toBe("Claude Code · 本地登录");
    expect(triggerText()).not.toContain("Idle");
  });

  it("keeps the readiness suffix in the dropdown, where there is room for it", () => {
    render(<Picker initial="claude-local" />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "选择 Agent Host" }));

    expect(visibleSelectOptions().map((option) => option.textContent)).toEqual([
      "Qoder · Configured",
      "Claude Code · Configured",
      "Claude Code · 本地登录 · Idle",
    ]);
  });

  it("still selects, and the trigger follows the new host", () => {
    render(<Picker initial="qoder" />);
    expect(triggerText()).toBe("Qoder");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "选择 Agent Host" }));
    const target = visibleSelectOptions().find(
      (option) => option.textContent === "Claude Code · 本地登录 · Idle",
    );
    if (target === undefined) throw new Error("claude-local option missing");
    fireEvent.click(target);

    expect(triggerText()).toBe("Claude Code · 本地登录");
  });

  // Every host keeps its brand mark in the trigger, not just in the list (#57).
  it("keeps the brand mark alongside the compact label", () => {
    for (const engine of ENGINES) {
      const { unmount } = render(<Picker initial={engine} />);
      const content = document.querySelector(".ant-select-content");
      expect(content?.querySelector("img.owb-engine-icon")).not.toBeNull();
      unmount();
    }
  });
});
