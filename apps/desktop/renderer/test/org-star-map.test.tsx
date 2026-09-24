import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OrgStarMap from "../src/org/OrgStarMap";
import type { OrgTreeSnapshot } from "@roleweave/shared";

const snapshot: OrgTreeSnapshot = {
  schemaVersion: "org-tree.v1",
  business: "开源业务",
  owner: "ceo",
  updatedAt: "2026-09-23T04:00:00.000Z",
  positionCount: 3,
  depth: 2,
  tree: [
    {
      id: "ceo",
      reportTo: null,
      budget: { perTask: { tokens: 40000 }, perDay: {} },
      children: [
        { id: "docs-lead", reportTo: "ceo", budget: { perTask: {}, perDay: {} }, children: [] },
        { id: "frontend", reportTo: "ceo", budget: { perTask: {}, perDay: {} }, children: [] },
      ],
    },
  ],
};

/** jsdom has no WebGL context, so the component must degrade to the
 *  accessible list fallback — which also makes the dock fully testable. */
describe("3D 组织星图（#472）：无 WebGL 环境退化为清单 + 操作 dock 保持可用", () => {
  it("加载态与空态诚实呈现", () => {
    const { unmount, container } = render(<OrgStarMap snapshot={snapshot} loading />);
    expect(container.querySelector(".owb-star-map__loading")).toBeInTheDocument();
    unmount();
    render(<OrgStarMap snapshot={null} />);
    expect(screen.getByText("暂无组织数据")).toBeInTheDocument();
  });

  it("fallback 清单列出全部天体并可点选", () => {
    const onSelect = vi.fn();
    render(
      <OrgStarMap
        snapshot={snapshot}
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("当前环境不支持 WebGL，星图以清单视图呈现")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文档负责人" }));
    expect(onSelect).toHaveBeenCalledWith("docs-lead");
  });

  it("搜索框给出候选，点选与回车都定位到岗位", () => {
    const onSelect = vi.fn();
    render(
      <OrgStarMap
        snapshot={snapshot}
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        onSelect={onSelect}
      />,
    );
    const input = screen.getByLabelText("定位员工：姓名或岗位 id");
    fireEvent.change(input, { target: { value: "doc" } });
    const candidate = screen.getByRole("option", { name: /文档负责人/ });
    fireEvent.click(candidate);
    expect(onSelect).toHaveBeenCalledWith("docs-lead");
    fireEvent.change(input, { target: { value: "front" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("frontend");
  });

  it("人员卡提供进入对话与新增下属", () => {
    const onSelect = vi.fn();
    const onHireEntry = vi.fn();
    render(
      <OrgStarMap
        snapshot={snapshot}
        selectedId="frontend"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        displayEngines={{ frontend: "qoder" }}
        runningIds={new Set(["frontend"])}
        onSelect={onSelect}
        onHireEntry={onHireEntry}
        dismissSlot={<button type="button">裁撤槽位</button>}
      />,
    );
    const card = screen.getByLabelText("员工概览");
    expect(within(card).getByText(/执行中/)).toBeInTheDocument();
    expect(within(card).getByText(/qoder/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入对话" }));
    expect(onSelect).toHaveBeenCalledWith("frontend");
    fireEvent.click(screen.getByRole("button", { name: "新增下属" }));
    expect(onHireEntry).toHaveBeenCalledWith("frontend");
    expect(screen.getByRole("button", { name: "裁撤槽位" })).toBeInTheDocument();
  });

  it("帮助入口收纳操作说明，主界面只留搜索与自转状态", () => {
    const onUndo = vi.fn();
    render(<OrgStarMap snapshot={snapshot} onUndo={onUndo} />);
    expect(screen.queryByText(/左键拖动旋转视角/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "操作说明" }));
    expect(screen.getByText(/OrbitControls 默认手势/)).toBeInTheDocument();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "重置视角" }))).not.toThrow();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "自转已停" })).toBeInTheDocument();
  });

  it("搜索支持 Esc、方向键与无结果状态", () => {
    const onSelect = vi.fn();
    render(
      <OrgStarMap
        snapshot={snapshot}
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        onSelect={onSelect}
      />,
    );
    const input = screen.getByLabelText("定位员工：姓名或岗位 id");
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.getByText("没有匹配的员工")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("没有匹配的员工")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "doc" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("docs-lead");
  });

  it("合成企业恒星只是布景：不进清单也不进搜索候选", () => {
    render(
      <OrgStarMap
        snapshot={{ ...snapshot, owner: "ghost" }}
        enterpriseName="开源业务"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "开源业务" })).not.toBeInTheDocument();
    const input = screen.getByLabelText("定位员工：姓名或岗位 id");
    fireEvent.change(input, { target: { value: "开源业务" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("关闭人员卡不影响自转状态", () => {
    render(
      <OrgStarMap
        snapshot={snapshot}
        selectedId="frontend"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
      />,
    );
    expect(screen.getByRole("button", { name: "自转已停" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByLabelText("员工概览")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "自转已停" })).toBeInTheDocument();
  });

  it("选中后聚焦卡给出概括信息，关闭只关卡片", () => {
    render(
      <OrgStarMap
        snapshot={snapshot}
        selectedId="docs-lead"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        displayTitles={{ "docs-lead": "公开文档与发布说明" }}
        displayModes={{ "docs-lead": "read_only" }}
      />,
    );
    const card = screen.getByLabelText("员工概览");
    expect(within(card).getByText("文档负责人")).toBeInTheDocument();
    expect(within(card).getByText("公开文档与发布说明")).toBeInTheDocument();
    expect(within(card).getByText("只读")).toBeInTheDocument();
    expect(within(card).getByText("汇报给 首席执行官")).toBeInTheDocument();
    expect(within(card).getByText("0 个下属")).toBeInTheDocument();
    expect(within(card).getByText("单任务预算: 声明期")).toBeInTheDocument();
    expect(within(card).getByText("空闲")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "关闭" }));
    expect(screen.queryByLabelText("员工概览")).not.toBeInTheDocument();
  });
});
