import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssetRecord, ExperimentsResponse } from "@roleweave/shared";
import { DeliveryPreflightPanel } from "../src/goals/DeliveryPreflightPanel";
import { GoalsModule } from "../src/goals/GoalsModule";
import type { OwbBridge } from "../src/owb";

const experiment = (enabled: boolean): ExperimentsResponse => ({
  schemaVersion: "experiments.v1",
  workspacePath: "/ws",
  workspaceSession: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  enabled,
  availability: enabled ? "ready" : "disabled",
  provider: {
    name: "Laya · local",
    endpointHost: "127.0.0.1",
    endpointUrl: "http://127.0.0.1:18081/v1/systemone",
    configured: true,
  },
  sending: ["status", "errorCode", "budgetRelated"],
});

const doc: AssetRecord = {
  schemaVersion: "asset-record.v1",
  assetId: "asset-release",
  kind: "doc",
  title: "Release evidence",
  createdAt: "2026-09-24T00:00:00.000Z",
  sourceRef: { positionId: "owner" },
  docRef: {
    uri: "owb-doc://owner/release.md",
    version: "2026-09-24T00:00:00.000Z",
  },
};

function install(enabled: boolean, assets: AssetRecord[] = [doc]) {
  const experiments = {
    get: vi.fn().mockResolvedValue({ status: 200, body: experiment(enabled) }),
  };
  const assetsList = vi.fn().mockResolvedValue({
    status: 200,
    body: { schemaVersion: "assets-list.v1", assets },
  });
  const resolveDocRef = vi.fn().mockResolvedValue({
    status: 200,
    body: {
      schemaVersion: "docs-resolve.v1",
      ref: doc.docRef,
      resolved: {
        positionId: "owner",
        path: "release.md",
        size: 42,
        modifiedAt: doc.docRef!.version,
      },
    },
  });
  const assetsRead = vi.fn();
  const positionDocFile = vi.fn();
  const reportAdvice = vi.fn();
  const updateGoal = vi.fn();
  window.owb = {
    experiments,
    assetsList,
    resolveDocRef,
    assetsRead,
    positionDocFile,
    reportAdvice,
    updateGoal,
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OwbBridge;
  return { experiments, assetsList, resolveDocRef, assetsRead, positionDocFile, reportAdvice, updateGoal };
}

describe("DeliveryPreflightPanel (#467)", () => {
  it("leaves Goals detail unchanged and makes no material request while experiments are off", async () => {
    const api = install(false);
    render(
      <DeliveryPreflightPanel
        workspacePath="/ws"
        workspaceScope={Symbol("workspace")}
        goalId="goal-one"
        acceptanceCriteria={["Windows acceptance receipt exists"]}
      />,
    );

    await waitFor(() => expect(api.experiments.get).toHaveBeenCalledWith("/ws"));
    expect(screen.queryByTestId("delivery-preflight-panel")).not.toBeInTheDocument();
    expect(api.assetsList).not.toHaveBeenCalled();
    expect(api.resolveDocRef).not.toHaveBeenCalled();
  });

  it("checks only explicitly selected DocRef metadata and never reads bodies or writes the goal", async () => {
    const api = install(true);
    render(
      <DeliveryPreflightPanel
        workspacePath="/ws"
        workspaceScope={Symbol("workspace")}
        goalId="goal-one"
        acceptanceCriteria={["Windows acceptance receipt exists"]}
      />,
    );

    expect(await screen.findByTestId("delivery-preflight-panel")).toBeInTheDocument();
    expect(await screen.findByText("criterion-1")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Release evidence.*asset-release/ }));
    fireEvent.click(screen.getByTestId("delivery-preflight-run"));

    await waitFor(() => expect(api.resolveDocRef).toHaveBeenCalledWith(doc.docRef));
    expect(await screen.findByTestId("delivery-preflight-status-criterion-1")).toHaveTextContent("无法判断");
    expect(screen.getByTestId("delivery-preflight-status-criterion-1")).toHaveTextContent("asset-release");
    expect(api.assetsRead).not.toHaveBeenCalled();
    expect(api.positionDocFile).not.toHaveBeenCalled();
    expect(api.reportAdvice).not.toHaveBeenCalled();
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it("rejects a structurally invalid DocRef without sending it to the resolver", async () => {
    const invalid = {
      ...doc,
      assetId: "asset-invalid",
      title: "Invalid evidence",
      docRef: { uri: "file:///private/evidence.md", version: "v1" },
    } as AssetRecord;
    const api = install(true, [invalid]);
    render(
      <DeliveryPreflightPanel
        workspacePath="/ws"
        workspaceScope={Symbol("workspace")}
        goalId="goal-one"
        acceptanceCriteria={["Windows acceptance receipt exists"]}
      />,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: /Invalid evidence.*asset-invalid/ }));
    fireEvent.click(screen.getByTestId("delivery-preflight-run"));

    expect(await screen.findByTestId("delivery-preflight-status-criterion-1")).toHaveTextContent("材料引用已失效");
    expect(api.resolveDocRef).not.toHaveBeenCalled();
  });

  it("locks material choices while a preflight snapshot is being resolved", async () => {
    let finish!: (value: Awaited<ReturnType<OwbBridge["resolveDocRef"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<OwbBridge["resolveDocRef"]>>>((resolve) => { finish = resolve; });
    const api = install(true);
    api.resolveDocRef.mockReturnValue(pending);
    render(
      <DeliveryPreflightPanel
        workspacePath="/ws"
        workspaceScope={Symbol("workspace")}
        goalId="goal-one"
        acceptanceCriteria={["Windows acceptance receipt exists"]}
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /Release evidence.*asset-release/ });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("delivery-preflight-run"));

    await waitFor(() => expect(api.resolveDocRef).toHaveBeenCalled());
    expect(checkbox).toBeDisabled();
    finish({
      status: 200,
      body: {
        schemaVersion: "docs-resolve.v1",
        ref: doc.docRef!,
        resolved: { positionId: "owner", path: "release.md", size: 42, modifiedAt: doc.docRef!.version! },
      },
    });
    await waitFor(() => expect(screen.getByTestId("delivery-preflight-run")).not.toBeDisabled());
  });

  it("is wired into the live Goals detail when the experiment is enabled", async () => {
    install(true);
    Object.assign(window.owb, {
      goals: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          goals: [{
            schemaVersion: "goal.v1",
            goalId: "goal-one",
            title: "Ship safely",
            description: "Release with evidence",
            acceptanceCriteria: ["Windows acceptance receipt exists"],
            status: "open",
            health: "unknown",
            branchCount: 0,
            createdAt: "2026-09-24T00:00:00.000Z",
            updatedAt: "2026-09-24T00:00:00.000Z",
          }],
        },
      }),
      goal: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          goal: {
            schemaVersion: "goal.v1",
            goalId: "goal-one",
            title: "Ship safely",
            description: "Release with evidence",
            acceptanceCriteria: ["Windows acceptance receipt exists"],
            status: "open",
            health: "unknown",
            branches: [],
            createdAt: "2026-09-24T00:00:00.000Z",
            updatedAt: "2026-09-24T00:00:00.000Z",
          },
          activity: [],
        },
      }),
    });

    render(<GoalsModule workspaceOpen workspaceKey="/ws" workspaceScope={Symbol("workspace")} />);

    expect(await screen.findByText("Ship safely")).toBeInTheDocument();
    expect(await screen.findByTestId("delivery-preflight-panel")).toBeInTheDocument();
  });
});
