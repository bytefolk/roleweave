import { act, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/App", () => ({ App: () => <div>default app</div> }));

describe("packaged-only static renderer entry", () => {
  let rendererEntryElement: typeof import("../src/main").rendererEntryElement;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      ({ rendererEntryElement } = await import("../src/main"));
    });
  });

  it("mounts a stable marker without status, workspace, event, or business calls", () => {
    const bridge = {
      status: vi.fn(),
      openWorkspace: vi.fn(),
      onEvent: vi.fn(),
      createTurn: vi.fn(),
    };
    function BridgeUsingApp() {
      bridge.status();
      bridge.openWorkspace();
      bridge.onEvent();
      bridge.createTurn();
      return <div>business app</div>;
    }

    render(rendererEntryElement({
      protocol: "file:",
      search: `?orgWorkbenchPackagedSmoke=${"a".repeat(64)}`,
    }, BridgeUsingApp));

    expect(screen.getByText("RoleWeave clean-staging renderer")).toHaveAttribute(
      "data-org-workbench-packaged-smoke-entry",
      "true",
    );
    for (const call of Object.values(bridge)) expect(call).not.toHaveBeenCalled();
  });

  it("keeps the ordinary development/default entry on App", () => {
    const App = vi.fn(() => <div>ordinary app</div>);
    render(rendererEntryElement({ protocol: "http:", search: "" }, App));
    expect(screen.getByText("ordinary app")).toBeInTheDocument();
    expect(App).toHaveBeenCalled();
  });
});
