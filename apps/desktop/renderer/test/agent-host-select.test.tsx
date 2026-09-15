import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { visibleSelectOptions } from "./select-helper";
import { EngineSelect } from "../src/turns";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns";

/** Runtime credentials and local-login transports are deliberately collapsed
 * into the four agent products operators understand. */

const availability: Record<TurnEngine, TurnEngineAvailability> = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
  workbuddy: { configured: true, ready: true },
};

const ENGINES: TurnEngine[] = ["qoder", "claude-code", "claude-local", "codex", "codex-local", "workbuddy"];

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
  it("collapses a local runtime into its one agent name", () => {
    render(<Picker initial="claude-local" />);

    expect(triggerText()).toBe("Claude Code");
    expect(triggerText()).not.toContain("Idle");
    expect(triggerText()).not.toContain("本地登录");
  });

  it("shows one option for each agent product without transport status", () => {
    render(<Picker initial="claude-local" />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "选择 Agent Host" }));

    expect(visibleSelectOptions().map((option) => option.textContent)).toEqual([
      "Qoder",
      "Claude Code",
      "Codex",
      "WorkBuddy",
    ]);
  });

  it.each(["Claude Code", "WorkBuddy"])("selects %s and the trigger follows the new host", (label) => {
    render(<Picker initial="qoder" />);
    expect(triggerText()).toBe("Qoder");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "选择 Agent Host" }));
    const target = visibleSelectOptions().find(
      (option) => option.textContent === label,
    );
    if (target === undefined) throw new Error(`${label} option missing`);
    fireEvent.click(target);

    expect(triggerText()).toBe(label);
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
