import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { presentReadyHostOverlay } from "../src/org/ready-host-overlay";
import { ReadyHostHint } from "../src/org/ReadyHostHint";
import { TurnPanel } from "../src/turns";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns/types";

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
    const onSelectEngine = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "切换到 Qoder Owner" }));
    expect(onSelectPosition).toHaveBeenCalledTimes(1);
    expect(onSelectPosition).toHaveBeenCalledWith("qoder-owner");
    expect(onSelectEngine).not.toHaveBeenCalled();
  });

  it("keeps locked Agent badge styling outside the overlay and does not rebind the engine", async () => {
    const ready: TurnEngineAvailability = { configured: true, ready: true };
    window.owb = {
      experiments: {
        get: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            schemaVersion: "experiments.v1",
            workspacePath: "/ws",
            workspaceSession: "session-1",
            revision: 1,
            enabled: true,
            availability: "ready",
            provider: {
              name: "Laya · local",
              endpointHost: "127.0.0.1",
              endpointUrl: "http://127.0.0.1/v1/systemone",
              configured: true,
            },
            sending: ["status", "errorCode", "budgetRelated"],
          },
        }),
      },
    } as unknown as Window["owb"];
    const onSelectEngine = vi.fn();
    const onSelectPosition = vi.fn();
    const { container } = render(
      <TurnPanel
        workspaceKey="/ws"
        workspaceOpen
        positions={[
          { id: "codex-writer", name: "Codex Writer" },
          { id: "qoder-owner", name: "Qoder Owner" },
        ]}
        selectedPositionId="codex-writer"
        engine="codex"
        engineLocked
        engineAvailability={{
          qoder: ready,
          "claude-code": ready,
          "claude-local": ready,
          codex: { configured: true, ready: false },
          "codex-local": ready,
          workbuddy: ready,
          gemini: ready,
        }}
        positionEngines={{ "codex-writer": "codex", "qoder-owner": "qoder" }}
        turns={[]}
        onSelectEngine={onSelectEngine}
        onSelectPosition={onSelectPosition}
        onCreateTurn={vi.fn()}
      />,
    );

    const badge = container.querySelector(".owb-engine-badge");
    expect(badge).toHaveTextContent("Codex");
    const badgeClass = badge?.className;
    const header = container.querySelector(".owb-conversation-header-actions");

    const overlay = await screen.findByRole("status", { name: "可用的 Agent 主机" });
    expect(header?.contains(overlay)).toBe(false);
    expect(badge?.className).toBe(badgeClass);
    expect(screen.queryByLabelText("选择 Agent Host")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换到 Qoder Owner" }));
    expect(onSelectPosition).toHaveBeenCalledWith("qoder-owner");
    expect(onSelectEngine).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("选择 Agent Host")).not.toBeInTheDocument();
    expect(container.querySelector(".owb-engine-badge")).toHaveTextContent("Codex");
  });
});

