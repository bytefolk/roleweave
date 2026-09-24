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
    expect(within(card).getByText("汇报给 首席执行官")).toBeInTheDocument();
    expect(within(card).getByText("0 个下属")).toBeInTheDocument();
    expect(within(card).getByText("单任务预算: 声明期")).toBeInTheDocument();
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
});
