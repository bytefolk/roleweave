/**
 * #519: where the first-run gate is mounted.
 *
 * Three boundaries to prove:
 *   1. an ordinary launch is wrapped by the gate (the splash comes first and the
 *      workspace does not race ahead);
 *   2. the packaged smoke entry bypasses it — that is a static marker the
 *      external staging tool scores, it must make zero bridge calls, and it must
 *      not turn into a timed startup-animation test;
 *   3. the layout harness bypasses it too, because it measures the real
 *      workspace on a machine that has no saved session.
 *   2 and 3 are the only places this change could quietly break packaging
 *   acceptance, so they are pinned here.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

describe("#519 renderer root entry", () => {
  let rendererRootElement: typeof import("../src/main").rendererRootElement;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      ({ rendererRootElement } = await import("../src/main"));
    });
    // main.tsx mounted its own tree during import; drop it so the assertions
    // below only see what this file renders.
    document.getElementById("root")?.remove();
  });

  it("wraps an ordinary launch in the first-run gate", () => {
    const App = vi.fn(() => <div>workspace body</div>);
    render(rendererRootElement({ protocol: "http:", search: "" }, App));
    expect(screen.getByRole("status", { name: "RoleWeave 正在启动" })).toBeInTheDocument();
    expect(screen.queryByText("workspace body")).toBeNull();
  });

  it("leaves the packaged smoke entry ungated and free of bridge calls", () => {
    const bridge = { status: vi.fn(), orgTree: vi.fn(), onEvent: vi.fn() };
    function BridgeUsingApp() {
      bridge.status();
      bridge.orgTree();
      bridge.onEvent();
      return <div>workspace body</div>;
    }
    render(rendererRootElement(
      { protocol: "file:", search: `?orgWorkbenchPackagedSmoke=${"a".repeat(64)}` },
      BridgeUsingApp,
    ));
    expect(screen.getByText("RoleWeave clean-staging renderer")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "RoleWeave 正在启动" })).toBeNull();
    for (const call of Object.values(bridge)) expect(call).not.toHaveBeenCalled();
  });

  it("leaves the layout harness ungated so it can measure a fresh install", () => {
    render(rendererRootElement({ protocol: "file:", search: "?orgWorkbenchLayoutSmoke=1" }, () => (
      <div>workspace body</div>
    )));
    expect(screen.getByText("workspace body")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "RoleWeave 正在启动" })).toBeNull();
  });

  it("ignores a look-alike layout parameter", () => {
    render(rendererRootElement({ protocol: "file:", search: "?orgWorkbenchLayoutSmoke=0" }, () => (
      <div>workspace body</div>
    )));
    expect(screen.getByRole("status", { name: "RoleWeave 正在启动" })).toBeInTheDocument();
    expect(screen.queryByText("workspace body")).toBeNull();
  });
});
