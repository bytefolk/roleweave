import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OrgStarMap from "../src/org/OrgStarMap";
import type { OrgTreeSnapshot, RelationshipGraphResponse } from "@roleweave/shared";

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

  it("dock 快捷操作：新增下属依赖选中、撤销与裁撤槽位直通调用方", () => {
    const onHireEntry = vi.fn();
    const onUndo = vi.fn();
    const { rerender } = render(
      <OrgStarMap snapshot={snapshot} onHireEntry={onHireEntry} onUndo={onUndo} dismissSlot={<button type="button">裁撤槽位</button>} />,
    );
    const hire = screen.getByRole("button", { name: "新增下属" });
    expect(hire).toBeDisabled();
    expect(screen.getByRole("button", { name: "裁撤槽位" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    rerender(
      <OrgStarMap snapshot={snapshot} selectedId="frontend" onHireEntry={onHireEntry} onUndo={onUndo} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新增下属" }));
    expect(onHireEntry).toHaveBeenCalledWith("frontend");
  });

  it("重置视角在无 WebGL 时也不崩", () => {
    render(<OrgStarMap snapshot={snapshot} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "重置视角" }))).not.toThrow();
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

  it("选中后聚焦卡给出概括信息，拉远与关闭可用", () => {
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
    expect(within(card).getByText("首席执行官")).toBeInTheDocument();
    expect(within(card).getByText("0 个下属")).toBeInTheDocument();
    expect(within(card).getByText("声明期")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "拉远" }));
    fireEvent.click(within(card).getByRole("button", { name: "关闭" }));
    expect(screen.queryByLabelText("员工概览")).not.toBeInTheDocument();
  });

  it("素雅极简顶栏支持轨道星图与拓扑星网切换，特性开关与主题切换可用", () => {
    render(
      <OrgStarMap
        snapshot={snapshot}
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
      />,
    );

    // 布局模式切换
    const celestialBtn = screen.getByRole("button", { name: /立体轨道星图/ });
    const networkBtn = screen.getByRole("button", { name: /3D 拓扑星网/ });
    expect(celestialBtn).toHaveClass("is-active");
    expect(networkBtn).not.toHaveClass("is-active");

    fireEvent.click(networkBtn);
    expect(networkBtn).toHaveClass("is-active");
    expect(celestialBtn).not.toHaveClass("is-active");

    // 特性开关
    const orbitsBtn = screen.getByRole("button", { name: /轨道参考线/ });
    const crossLinksBtn = screen.getByRole("button", { name: /知识协同链/ });
    const autoRotateBtn = screen.getByRole("button", { name: /自转巡航/ });

    expect(orbitsBtn).toHaveClass("is-active");
    fireEvent.click(orbitsBtn);
    expect(orbitsBtn).not.toHaveClass("is-active");

    expect(crossLinksBtn).toHaveClass("is-active");
    fireEvent.click(crossLinksBtn);
    expect(crossLinksBtn).not.toHaveClass("is-active");

    expect(autoRotateBtn).not.toHaveClass("is-active");
    fireEvent.click(autoRotateBtn);
    expect(autoRotateBtn).toHaveClass("is-active");

    // 主题切换（黑夜极简 <-> 素雅白纸）
    const themeBtn = screen.getByRole("button", { name: /素雅白纸|极简黑夜/ });
    expect(themeBtn).toHaveTextContent("素雅白纸");
    fireEvent.click(themeBtn);
    expect(themeBtn).toHaveTextContent("极简黑夜");

    // 视角复位按钮
    const resetCamBtn = screen.getByRole("button", { name: /视角复位/ });
    expect(() => fireEvent.click(resetCamBtn)).not.toThrow();
  });

  it("顶栏控制组使用当前语言的可访问名称", () => {
    render(<OrgStarMap snapshot={snapshot} />);

    expect(screen.getByRole("group", { name: "3D 布局模式" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "功能开关" })).toBeInTheDocument();
  });

  it("底部素雅微雕图谱展示节点统计与图例", () => {
    render(
      <OrgStarMap
        snapshot={snapshot}
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
      />,
    );

    // 统计指标
    expect(screen.getByText("组织节点:")).toBeInTheDocument();
    expect(screen.getByText("层级深度:")).toBeInTheDocument();
    expect(screen.getByText("层级汇报:")).toBeInTheDocument();

    // 素雅图例
    expect(screen.getByText(/组织决策根/)).toBeInTheDocument();
    expect(screen.getByText(/项目负责人/)).toBeInTheDocument();
    expect(screen.getByText(/专职职能岗/)).toBeInTheDocument();
    expect(screen.getByText("管理汇报")).toBeInTheDocument();
    expect(screen.getByText("知识依赖")).toBeInTheDocument();
  });

  it("知识协同跨链在底部统计与选中卡片中正确呈现并可跳转", () => {
    const onSelect = vi.fn();
    render(
      <OrgStarMap
        snapshot={snapshot}
        selectedId="docs-lead"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        knowledgeLinks={[
          { source: "docs-lead", target: "frontend", label: "接口规范", desc: "文档对齐前端组件规范" },
        ]}
        onSelect={onSelect}
      />,
    );

    // 底部统计包含跨链
    expect(screen.getByText("协同跨链:")).toBeInTheDocument();

    // 选中卡片中展示知识协同链
    const card = screen.getByLabelText("员工概览");
    expect(within(card).getByText("知识协同链路")).toBeInTheDocument();
    const linkBtn = within(card).getByRole("button", { name: /接口规范/ });
    expect(linkBtn).toBeInTheDocument();
    fireEvent.click(linkBtn);
    expect(onSelect).toHaveBeenCalledWith("frontend");
  });

  it("动态数字人组织架构：新增（Hire）、裁撤（Dismiss）、调整汇报线（Move）均能实时响应", () => {
    const onSelect = vi.fn();
    const onMove = vi.fn();
    const displayNames: Record<string, string> = {
      ceo: "首席执行官",
      "docs-lead": "文档负责人",
      frontend: "前端工程师",
      "backend-dev": "后端工程师",
    };

    // 初始 3 人架构
    const { rerender } = render(
      <OrgStarMap
        snapshot={snapshot}
        displayNames={displayNames}
        selectedId="frontend"
        onSelect={onSelect}
        onMove={onMove}
      />,
    );

    // 初始状态包含 3 个岗位
    expect(screen.getByRole("button", { name: "首席执行官" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文档负责人" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前端工程师" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "后端工程师" })).not.toBeInTheDocument();

    // 1. 新增数字人（Hire）：在文档负责人下新增「后端工程师」
    const hiredSnapshot: OrgTreeSnapshot = {
      ...snapshot,
      positionCount: 4,
      depth: 3,
      tree: [
        {
          id: "ceo",
          reportTo: null,
          budget: { perTask: { tokens: 40000 }, perDay: {} },
          children: [
            {
              id: "docs-lead",
              reportTo: "ceo",
              budget: { perTask: {}, perDay: {} },
              children: [
                { id: "backend-dev", reportTo: "docs-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
            { id: "frontend", reportTo: "ceo", budget: { perTask: {}, perDay: {} }, children: [] },
          ],
        },
      ],
    };

    rerender(
      <OrgStarMap
        snapshot={hiredSnapshot}
        displayNames={displayNames}
        selectedId="backend-dev"
        onSelect={onSelect}
        onMove={onMove}
      />,
    );

    // 验证新数字人出现在列表中并可查看卡片
    expect(screen.getByRole("button", { name: "后端工程师" })).toBeInTheDocument();
    const hiredCard = screen.getByLabelText("员工概览");
    expect(within(hiredCard).getByText("文档负责人")).toBeInTheDocument();

    // 2. 调整汇报线（Move）：将 frontend 汇报线从 ceo 改为 docs-lead
    const movedSnapshot: OrgTreeSnapshot = {
      ...hiredSnapshot,
      tree: [
        {
          id: "ceo",
          reportTo: null,
          budget: { perTask: { tokens: 40000 }, perDay: {} },
          children: [
            {
              id: "docs-lead",
              reportTo: "ceo",
              budget: { perTask: {}, perDay: {} },
              children: [
                { id: "backend-dev", reportTo: "docs-lead", budget: { perTask: {}, perDay: {} }, children: [] },
                { id: "frontend", reportTo: "docs-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
          ],
        },
      ],
    };

    rerender(
      <OrgStarMap
        snapshot={movedSnapshot}
        displayNames={displayNames}
        selectedId="frontend"
        onSelect={onSelect}
        onMove={onMove}
      />,
    );

    // 验证前端工程师的汇报线变更为文档负责人
    const movedCard = screen.getByLabelText("员工概览");
    expect(within(movedCard).getByText("文档负责人")).toBeInTheDocument();

    // 3. 裁撤数字人（Dismiss）：删除 backend-dev
    const dismissedSnapshot: OrgTreeSnapshot = {
      ...movedSnapshot,
      positionCount: 3,
      tree: [
        {
          id: "ceo",
          reportTo: null,
          budget: { perTask: { tokens: 40000 }, perDay: {} },
          children: [
            {
              id: "docs-lead",
              reportTo: "ceo",
              budget: { perTask: {}, perDay: {} },
              children: [
                { id: "frontend", reportTo: "docs-lead", budget: { perTask: {}, perDay: {} }, children: [] },
              ],
            },
          ],
        },
      ],
    };

    rerender(
      <OrgStarMap
        snapshot={dismissedSnapshot}
        displayNames={displayNames}
        selectedId="backend-dev" // 已被裁撤的数字人 ID
        onSelect={onSelect}
        onMove={onMove}
      />,
    );

    // 验证已裁撤的后端工程师不复存在，且概览卡片干净关闭，无残留
    expect(screen.queryByRole("button", { name: "后端工程师" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("员工概览")).not.toBeInTheDocument();
  });

  it("relationshipGraph 动态计算知识跨链与协同关系，自动过滤已裁撤岗位", () => {
    const onSelect = vi.fn();
    const mockGraph: RelationshipGraphResponse = {
      schemaVersion: "relationship-graph.v1",
      workspaceId: "test-ws",
      revision: "rev-1",
      generatedAt: "2026-09-24T00:00:00Z",
      truncated: false,
      limits: { nodes: 400, edges: 800 },
      coverage: [],
      nodes: [
        {
          id: "agent:1",
          kind: "agent",
          label: "CEO",
          state: "ready",
          positionId: "ceo",
          evidence: { source: "org", locator: "pos:ceo", basis: "declared", observedAt: "now" },
        },
        {
          id: "agent:2",
          kind: "agent",
          label: "文档负责人",
          state: "ready",
          positionId: "docs-lead",
          evidence: { source: "org", locator: "pos:docs-lead", basis: "declared", observedAt: "now" },
        },
        {
          id: "agent:3",
          kind: "agent",
          label: "前端工程师",
          state: "ready",
          positionId: "frontend",
          evidence: { source: "org", locator: "pos:frontend", basis: "declared", observedAt: "now" },
        },
        {
          id: "task:release-docs",
          kind: "task",
          label: "发布文档与UI对齐",
          state: "ready",
          evidence: { source: "tasks", locator: "task:release-docs", basis: "observed", observedAt: "now" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "task:release-docs",
          target: "agent:2",
          kind: "requested_by",
          evidence: { source: "tasks", locator: "t", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
        {
          id: "e2",
          source: "task:release-docs",
          target: "agent:3",
          kind: "assigned_to",
          evidence: { source: "tasks", locator: "t", basis: "declared", observedAt: "now" },
          permission: "not_applicable",
        },
      ],
    };

    render(
      <OrgStarMap
        snapshot={snapshot}
        selectedId="docs-lead"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        relationshipGraph={mockGraph}
        onSelect={onSelect}
      />,
    );

    // 动态发现 docs-lead 和 frontend 之间的任务协同跨链
    expect(screen.getByText("协同跨链:")).toBeInTheDocument();
    const card = screen.getByLabelText("员工概览");
    expect(within(card).getByText("知识协同链路")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /任务协同/ })).toBeInTheDocument();
  });

  it("员工卡片提供「进入对话」直达按钮，点击调用 onOpenConversation", () => {
    const onSelect = vi.fn();
    const onOpenConversation = vi.fn();
    render(
      <OrgStarMap
        snapshot={snapshot}
        selectedId="docs-lead"
        displayNames={{ ceo: "首席执行官", "docs-lead": "文档负责人", frontend: "前端工程师" }}
        onSelect={onSelect}
        onOpenConversation={onOpenConversation}
      />,
    );

    const card = screen.getByLabelText("员工概览");
    const chatBtn = within(card).getByRole("button", { name: "进入对话" });
    expect(chatBtn).toBeInTheDocument();
    fireEvent.click(chatBtn);
    expect(onOpenConversation).toHaveBeenCalledWith("docs-lead");
  });
});
