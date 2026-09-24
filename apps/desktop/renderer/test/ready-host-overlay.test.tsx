import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { presentReadyHostOverlay } from "../src/org/ready-host-overlay";
import { ReadyHostHint } from "../src/org/ReadyHostHint";
import type { TurnEngine } from "../src/turns/types";

const unready = { positionId: "codex-writer", engine: "codex" as TurnEngine, ready: false };
const readyQoder = { positionId: "qoder-owner", engine: "qoder" as TurnEngine, ready: true };

describe("ready-host overlay (#465)", () => {
  it("does not call Jev when zero or one ready candidate exists", () => {
    const none = presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready],
    });
    expect(none.callJev).toBe(false);

    const one = presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready, readyQoder],
    });
    expect(one.callJev).toBe(false);
  });

  it("does not call Jev when overlay is off or the selection is already ready", () => {
    const readyClaude = { positionId: "claude-reviewer", engine: "claude-code" as TurnEngine, ready: true };
    const many = [unready, readyQoder, readyClaude];
    expect(presentReadyHostOverlay({
      overlayEnabled: false,
      selected: unready,
      positions: many,
    }).callJev).toBe(false);
    expect(presentReadyHostOverlay({
      overlayEnabled: true,
      selected: readyQoder,
      positions: many,
    }).callJev).toBe(false);
  });

  it("allows Jev only when two or more ready candidates exist", () => {
    const readyClaude = { positionId: "claude-reviewer", engine: "claude-code" as TurnEngine, ready: true };
    const presented = presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready, readyQoder, readyClaude],
    });
    expect(presented.callJev).toBe(true);
    expect(presented.candidates.map((c) => c.positionId)).toEqual(["qoder-owner", "claude-reviewer"]);
  });

  it("clicking a suggestion only selects the position", () => {
    const onSelectPosition = vi.fn();
    const overlay = presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready, readyQoder],
    });
    render(
      <ReadyHostHint
        overlay={overlay}
        names={{ "qoder-owner": "Qoder Owner" }}
        onSelectPosition={onSelectPosition}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "切换到 Qoder Owner" }));
    expect(onSelectPosition).toHaveBeenCalledTimes(1);
    expect(onSelectPosition).toHaveBeenCalledWith("qoder-owner");
  });
});

