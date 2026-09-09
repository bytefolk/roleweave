import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrgChart, centerOrgChartView, fitOrgChartView } from "../src/org/OrgChart";
import type { OrgTreeSnapshot } from "@roleweave/shared";

const snapshot: OrgTreeSnapshot = {
  schemaVersion: "org-tree.v1",
  business: "开源业务",
  owner: "repo-owner",
  updatedAt: "2026-08-24T04:00:00.000Z",
  positionCount: 3,
  depth: 2,
  tree: [{
    id: "repo-owner",
    reportTo: null,
    budget: { perTask: { tokens: 40000 }, perDay: { tokens: 800000 } },
    children: [
      { id: "docs-writer", reportTo: "repo-owner", budget: { perTask: { iterations: 10 }, perDay: {} }, children: [] },
      { id: "release-engineer", reportTo: "repo-owner", budget: { perTask: {}, perDay: {} }, children: [] },
    ],
  }],
};

describe("P0 组织图可视化（纯展示：节点 + 汇报线 + 空态/加载态）", () => {
  it("加载态渲染骨架屏而不是节点", () => {
    render(<OrgChart snapshot={snapshot} loading />);
    expect(screen.getByLabelText("组织图加载中")).toBeInTheDocument();
    expect(screen.queryByText("代码库负责人")).not.toBeInTheDocument();
  });

  it("快照缺失或空树渲染空态", () => {
    const { unmount } = render(<OrgChart snapshot={null} />);
    expect(screen.getByText("暂无组织数据")).toBeInTheDocument();
    unmount();
    render(<OrgChart snapshot={{ ...snapshot, tree: [] }} />);
    expect(screen.getByText("暂无组织数据")).toBeInTheDocument();
  });

  it("渲染汇报树：只展示角色名与层级关系", () => {
    const { container } = render(
      <OrgChart
        snapshot={snapshot}
        displayNames={{ "repo-owner": "代码库负责人", "docs-writer": "文档负责人", "release-engineer": "发布工程师" }}
      />,
    );
    // 头部位面：岗位数与深度来自应用态快照。
    // #167：描述语精简——头部只留标题，count·depth meta 已移除。
    expect(screen.queryByText("3 岗位 · 深度 2")).toBeNull();
    // 角色名来自展示面；组织图不重复渲染 title、预算和模式。
    expect(screen.getByText("代码库负责人")).toBeInTheDocument();
    expect(screen.getByText("发布工程师")).toBeInTheDocument();
    expect(screen.queryByText("release-engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("40k/task")).not.toBeInTheDocument();
    expect(screen.queryByText("需审批")).not.toBeInTheDocument();
    // 汇报线走线：3 个节点 → 3 个分支容器（伪元素连接线挂在其上）。
    expect(container.querySelectorAll(".owb-org-chart__branch")).toHaveLength(3);
    expect(container.querySelector(".owb-org-chart__children")).not.toBeNull();
  });

  it("点击节点触发 onSelect；选中节点带高亮态与按压语义", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <OrgChart snapshot={snapshot} selectedId="repo-owner" onSelect={onSelect} />,
    );
    const owner = container.querySelector('[data-org-chart-node="repo-owner"]')!;
    const docs = container.querySelector('[data-org-chart-node="docs-writer"]')!;
    expect(owner).toHaveClass("is-selected");
    expect(owner).toHaveAttribute("aria-pressed", "true");
    expect(docs).not.toHaveClass("is-selected");
    fireEvent.click(docs);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("docs-writer");
  });

  it("展示面缺条目时回退岗位 id，不编造语义", () => {
    const { container } = render(<OrgChart snapshot={snapshot} />);
    // 无 displayNames：节点主行回退到岗位 id。
    expect(screen.getAllByText("repo-owner").length).toBeGreaterThan(0);
    // 组织图不承载预算和模式字段。
    expect(screen.queryByText("40k/task")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".owb-org-chart__budget")).toHaveLength(0);
  });
  it("画布平移：光标按住拖拽即平移组织图，松手退出 pan 态 (#137 review)", () => {
    const { container } = render(<OrgChart snapshot={snapshot} />);
    const body = container.querySelector("#owb-org-chart-body") as HTMLElement;
    expect(body).not.toBeNull();
    // #167：画布是 transform 平移，直接断言 stage 的 translate。
    const stage = () => body.querySelector(".owb-org-chart__stage") as HTMLElement;
    Object.defineProperty(body, "scrollTop", { writable: true, value: 0 });

    // jsdom 没有 PointerEvent 构造器，fireEvent.pointerDown 会落成字段全
    // undefined 的裸事件；用 MouseEvent 携带 button/clientX 才能驱动 pan。
    fireEvent(body, new MouseEvent("pointerdown", { button: 0, clientX: 120, clientY: 80, bubbles: true }));
    fireEvent(body, new MouseEvent("pointermove", { button: 0, clientX: 80, clientY: 80, bubbles: true }));
    expect(stage().style.transform).toContain("translate(-40px");
    expect(body.className).toContain("is-panning");
    fireEvent(body, new MouseEvent("pointerup", { button: 0, bubbles: true }));
    expect(body.className).not.toContain("is-panning");
  });

  it("点击阈值：小于 4px 的移动不进入 pan，节点点击不受拖拽影响 (#137 review)", () => {
    const { container } = render(<OrgChart snapshot={snapshot} />);
    const body = container.querySelector("#owb-org-chart-body") as HTMLElement;
    const stage = () => body.querySelector(".owb-org-chart__stage") as HTMLElement;
    fireEvent(body, new MouseEvent("pointerdown", { button: 0, clientX: 120, clientY: 80, bubbles: true }));
    fireEvent(body, new MouseEvent("pointermove", { button: 0, clientX: 118, clientY: 80, bubbles: true }));
    expect(stage().style.transform).toContain("translate(0px");
    expect(body.className).not.toContain("is-panning");
    fireEvent(body, new MouseEvent("pointerup", { button: 0, bubbles: true }));
  });

  it("捏合缩放：ctrl+wheel 缩放且头部百分比同步，普通 wheel 不触发 (#137 review)", () => {
    const { container } = render(<OrgChart snapshot={snapshot} />);
    const body = container.querySelector("#owb-org-chart-body") as HTMLElement;
    expect(screen.getByRole("button", { name: "重置缩放到 100%" }).textContent).toBe("100%");

    fireEvent.wheel(body, { ctrlKey: true, deltaY: -100, clientX: 10, clientY: 10 });
    expect(screen.getByRole("button", { name: "重置缩放到 100%" }).textContent).toBe("110%");

    fireEvent.wheel(body, { deltaY: -100 });
    expect(screen.getByRole("button", { name: "重置缩放到 100%" }).textContent).toBe("110%");

    fireEvent.click(screen.getByRole("button", { name: "重置缩放到 100%" }));
    expect(screen.getByRole("button", { name: "重置缩放到 100%" }).textContent).toBe("100%");
  });

  it("缩放边界：连续捏合封顶 200%，连续捏开封底 50% (#137 review)", () => {
    const { container } = render(<OrgChart snapshot={snapshot} />);
    const body = container.querySelector("#owb-org-chart-body") as HTMLElement;
    for (let i = 0; i < 12; i += 1) fireEvent.wheel(body, { ctrlKey: true, deltaY: -100 });
    expect(screen.getByRole("button", { name: "重置缩放到 100%" }).textContent).toBe("200%");
    for (let i = 0; i < 20; i += 1) fireEvent.wheel(body, { ctrlKey: true, deltaY: 100 });
    expect(screen.getByRole("button", { name: "重置缩放到 100%" }).textContent).toBe("50%");
  });
});

describe("组织图画布定位", () => {
  it("默认先把超宽组织图缩放到可见范围并整体居中", () => {
    const view = fitOrgChartView(
      { width: 640, height: 360 },
      900,
      { x: 0, y: 0, scale: 1 },
    );
    expect(view.x).toBeCloseTo(14);
    expect(view.y).toBe(0);
    expect(view.scale).toBeCloseTo(0.68);
  });

  it("组织图过高时同时按画布高度缩放，不能把节点带出画布", () => {
    const view = fitOrgChartView(
      { width: 640, height: 360 },
      900,
      { x: 0, y: 0, scale: 1 },
      600,
    );
    expect(view.scale).toBeCloseTo((360 - 16) / 600);
    expect(view.x).toBeCloseTo((640 - 900 * view.scale) / 2);
    expect(view.y).toBe(0);
  });

  it("默认以根节点为横向基准居中，不改变组织树的纵向起点", () => {
    expect(
      centerOrgChartView(
        { width: 640, height: 360 },
        { x: 420, y: 18 },
        { x: 0, y: 0, scale: 1 },
        false,
      ),
    ).toEqual({ x: -100, y: 0, scale: 1 });
  });

  it("选中节点时可同时把节点带到可视区中心", () => {
    const view = centerOrgChartView(
      { width: 640, height: 360 },
      { x: 420, y: 220 },
      { x: 12, y: 4, scale: 1.1 },
      true,
    );
    expect(view.x).toBeCloseTo(-142);
    expect(view.y).toBe(8);
    expect(view.scale).toBe(1.1);
  });
});
