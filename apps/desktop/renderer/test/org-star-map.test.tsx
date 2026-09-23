import { fireEvent, render, screen } from "@testing-library/react";
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
});
