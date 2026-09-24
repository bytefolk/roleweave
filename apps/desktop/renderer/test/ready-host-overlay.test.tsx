import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExperimentsResponse, ReadyHostChoiceResponse } from "@roleweave/shared";
import { presentReadyHostOverlay } from "../src/org/ready-host-overlay";
import { ReadyHostHint } from "../src/org/ReadyHostHint";
import { EXPERIMENTS_CHANGED } from "../src/experiments/useWorkspaceExperiments";
import { TurnPanel } from "../src/turns";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns/types";

const unready = { positionId: "codex-writer", engine: "codex" as TurnEngine, ready: false };
const readyQoder = { positionId: "qoder-owner", engine: "qoder" as TurnEngine, ready: true };
const readyClaude = { positionId: "claude-reviewer", engine: "claude-code" as TurnEngine, ready: true };
const ready: TurnEngineAvailability = { configured: true, ready: true };

const experiment = (overrides: Partial<ExperimentsResponse> = {}): ExperimentsResponse => ({
  schemaVersion: "experiments.v1",
  workspacePath: "/ws",
  workspaceSession: "session-a",
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
  ...overrides,
});

function install(settings = experiment()) {
  const get = vi.fn(async () => ({ status: 200, body: settings }));
  const readyHostChoice = vi.fn(async (): Promise<{ status: number; body: ReadyHostChoiceResponse }> => ({
    status: 200,
    body: {
      workspacePath: settings.workspacePath,
      workspaceSession: settings.workspaceSession,
      revision: settings.revision,
      status: "ready",
      positionId: "qoder-owner",
    },
  }));
  Object.defineProperty(window, "owb", { configurable: true, value: { experiments: { get }, readyHostChoice } });
  return { get, readyHostChoice };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function panel(extra: Record<string, unknown> = {}) {
  return (
    <TurnPanel
      workspaceKey="/ws"
      workspaceOpen
      positions={[
        { id: "codex-writer", name: "Codex Writer" },
        { id: "qoder-owner", name: "Qoder Owner" },
        { id: "claude-reviewer", name: "Claude Reviewer" },
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
      readyHostFacts={[unready, readyQoder, readyClaude]}
      turns={[]}
      onCreateTurn={vi.fn()}
      {...extra}
    />
  );
}

describe("ready-host overlay (#465)", () => {
  it("does not call Jev when zero or one ready candidate exists", () => {
    expect(presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready],
    }).callJev).toBe(false);
    expect(presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready, readyQoder],
    }).callJev).toBe(false);
  });

  it("does not call the provider for zero ready candidates", async () => {
    const api = install();
    render(panel({ readyHostFacts: [unready] }));
    await screen.findByText("Codex Writer");
    expect(api.readyHostChoice).not.toHaveBeenCalled();
  });

  it("does not call the provider for a single ready candidate", async () => {
    const api = install();
    render(panel({ readyHostFacts: [unready, readyQoder] }));
    await screen.findByRole("button", { name: "切换到 Qoder Owner" });
    expect(api.readyHostChoice).not.toHaveBeenCalled();
  });

  it("asks Choice with only positionId/engine/ready and shows the returned host", async () => {
    const api = install();
    render(panel());
    await waitFor(() => expect(api.readyHostChoice).toHaveBeenCalled());
    expect(api.readyHostChoice).toHaveBeenCalledWith({
      workspacePath: "/ws",
      workspaceSession: "session-a",
      revision: 1,
      candidates: [
        { positionId: "qoder-owner", engine: "qoder", ready: true },
        { positionId: "claude-reviewer", engine: "claude-code", ready: true },
      ],
    });
    expect(screen.getByRole("button", { name: "切换到 Qoder Owner" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换到 Claude Reviewer" })).not.toBeInTheDocument();
  });

  it("does not display an invalid Choice option", async () => {
    const api = install();
    api.readyHostChoice.mockImplementation(async () => ({
      status: 200,
      body: {
        workspacePath: "/ws",
        workspaceSession: "session-a",
        revision: 1,
        status: "ready",
        positionId: "stranger",
      },
    }));
    render(panel());
    await waitFor(() => expect(api.readyHostChoice).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "切换到 Qoder Owner" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换到 Claude Reviewer" })).not.toBeInTheDocument();
  });

  it("discards an in-flight Choice after workspace/session change", async () => {
    const api = install();
    const pending = deferred<{ status: number; body: ReadyHostChoiceResponse }>();
    api.readyHostChoice.mockImplementation(() => pending.promise);
    const { rerender } = render(panel());
    await screen.findByText("Codex Writer");
    await waitFor(() => expect(api.readyHostChoice).toHaveBeenCalled());
    api.readyHostChoice.mockImplementation(() => new Promise(() => {}));
    api.get.mockImplementation(async (workspacePath: string) => ({
      status: 200,
      body: experiment({
        workspacePath,
        workspaceSession: workspacePath === "/other" ? "session-b" : "session-a",
        revision: workspacePath === "/other" ? 3 : 1,
      }),
    }));
    rerender(panel({ workspaceKey: "/other" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/other"));
    await act(async () => pending.resolve({
      status: 200,
      body: {
        workspacePath: "/ws",
        workspaceSession: "session-a",
        revision: 1,
        status: "ready",
        positionId: "qoder-owner",
      },
    }));
    expect(screen.queryByRole("button", { name: "切换到 Qoder Owner" })).not.toBeInTheDocument();
  });

  it("drops in-flight Choice when experiments turn off", async () => {
    const api = install();
    const pending = deferred<{ status: number; body: ReadyHostChoiceResponse }>();
    api.readyHostChoice.mockReturnValueOnce(pending.promise);
    render(panel());
    await waitFor(() => expect(api.readyHostChoice).toHaveBeenCalled());
    api.get.mockResolvedValue({ status: 200, body: experiment({ enabled: false, availability: "disabled", revision: 2 }) });
    act(() => window.dispatchEvent(new CustomEvent(EXPERIMENTS_CHANGED, { detail: { workspacePath: "/ws" } })));
    await act(async () => pending.resolve({
      status: 200,
      body: {
        workspacePath: "/ws",
        workspaceSession: "session-a",
        revision: 1,
        status: "ready",
        positionId: "qoder-owner",
      },
    }));
    expect(screen.queryByRole("button", { name: "切换到 Qoder Owner" })).not.toBeInTheDocument();
  });

  it("clicking a suggestion only selects the position", () => {
    const onSelectPosition = vi.fn();
    const onSelectEngine = vi.fn();
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
    expect(onSelectPosition).toHaveBeenCalledWith("qoder-owner");
    expect(onSelectEngine).not.toHaveBeenCalled();
  });

  it("keeps locked Agent badge styling outside the overlay and does not rebind the engine", async () => {
    install();
    const onSelectEngine = vi.fn();
    const onSelectPosition = vi.fn();
    const { container } = render(panel({
      readyHostFacts: [unready, readyQoder],
      onSelectEngine,
      onSelectPosition,
    }));
    const badge = container.querySelector(".owb-engine-badge");
    expect(badge).toHaveTextContent("Codex");
    const badgeClass = badge?.className;
    const header = container.querySelector(".owb-conversation-header-actions");
    const overlay = await screen.findByRole("status", { name: "可用的 Agent 主机" });
    expect(header?.contains(overlay)).toBe(false);
    expect(badge?.className).toBe(badgeClass);
    fireEvent.click(screen.getByRole("button", { name: "切换到 Qoder Owner" }));
    expect(onSelectPosition).toHaveBeenCalledWith("qoder-owner");
    expect(onSelectEngine).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("选择 Agent Host")).not.toBeInTheDocument();
  });
});
