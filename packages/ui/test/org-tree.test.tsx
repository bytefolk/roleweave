import { act, fireEvent, render, screen } from "@testing-library/react";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import { describe, expect, it, vi } from "vitest";
import { OrgTree } from "../src/org-tree";
import { SNAPSHOT } from "./fixtures";

describe("OrgTree (D1 spec §2, frozen org-tree.v1)", () => {
  it("renders enterprise root + nested positions: root=企业, owner beneath, children by reportTo", () => {
    render(<OrgTree snapshot={SNAPSHOT} />);
    const tree = screen.getByRole("tree");
    expect(tree).toBeInTheDocument();

    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(5); // enterprise + repo-owner + 3 positions

    expect(screen.getByText("oss-maintainer")).toBeInTheDocument();
    const enterprise = screen.getByText("oss-maintainer").closest('[role="treeitem"]');
    expect(enterprise).toHaveAttribute("aria-level", "1");
    expect(enterprise).toHaveAttribute("aria-expanded", "true");

    const owner = screen.getByText("repo-owner").closest('[role="treeitem"]');
    expect(owner).toHaveAttribute("aria-level", "2");
    expect(owner).toHaveAttribute("aria-selected", "false");

    const child = screen.getByText("issue-researcher").closest('[role="treeitem"]');
    expect(child).toHaveAttribute("aria-level", "3");
  });

  it("falls back to the engine tree as top level when business is missing", () => {
    render(<OrgTree snapshot={{ ...SNAPSHOT, business: "" }} />);
    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(4);
    expect(screen.queryByText("oss-maintainer")).not.toBeInTheDocument();
    const owner = screen.getByText("repo-owner").closest('[role="treeitem"]');
    expect(owner).toHaveAttribute("aria-level", "1");
  });

  it("selects a position on click and reports it", () => {
    const onSelect = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("issue-researcher"));
    expect(onSelect).toHaveBeenCalledWith("issue-researcher");
  });

  it("toggles expansion with the arrow buttons (enterprise and owner)", () => {
    const onExpand = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onExpand={onExpand} />);
    const toggles = screen.getAllByRole("button", { name: "收起" });
    expect(toggles).toHaveLength(2); // enterprise + repo-owner

    fireEvent.click(toggles[1]!); // collapse repo-owner
    expect(onExpand).toHaveBeenCalledWith("repo-owner", false);
    expect(screen.queryByText("issue-researcher")).not.toBeInTheDocument();
    expect(screen.getByText("repo-owner")).toBeInTheDocument();

    fireEvent.click(toggles[0]!); // collapse enterprise
    expect(onExpand).toHaveBeenCalledWith("__enterprise__", false);
    expect(screen.queryByText("repo-owner")).not.toBeInTheDocument();
  });

  it("supports keyboard navigation (ModuleRail arrow pattern)", () => {
    render(<OrgTree snapshot={SNAPSHOT} />);
    const tree = screen.getByRole("tree");
    const items = screen.getAllByRole("treeitem");
    act(() => {
      (items[0] as HTMLElement).focus();
    });
    expect(items[0]).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(tree, { key: "End" });
    expect(document.activeElement).toBe(items[4]);

    fireEvent.keyDown(tree, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);

    // Enter collapses the focused enterprise root.
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(screen.queryByText("repo-owner")).not.toBeInTheDocument();
  });

  // The directory row is intentionally only status + folder + human name. The
  // internal position id is kept for routing, not repeated in the UI.
  it("renders human display names and the folder/status-light identity block", () => {
    const { container } = render(
      <OrgTree
        snapshot={SNAPSHOT}
        displayNames={{ "issue-researcher": "议题研究员" }}
        avatarColors={{ "issue-researcher": "#c96a12" }}
      />,
    );
    expect(screen.getByText("议题研究员")).toBeInTheDocument();

    const row = screen.getByText("议题研究员").closest('[role="treeitem"]')!;
    expect(row.querySelector(".ui-org-tree__id")).toBeNull();
    const icon = row.querySelector<HTMLElement>(".ui-org-tree__icon")!;
    expect(icon.style.color).toContain("rgb(201, 106, 18)");

    // Idle rows carry a non-running status light; no live run was declared.
    const led = row.querySelector(".ui-org-tree__led")!;
    expect(led).toBeTruthy();
    expect(led.className).not.toContain("is-running");

    // Positions without a declared color keep the default icon tint.
    const ownerRow = screen.getByText("repo-owner").closest('[role="treeitem"]')!;
    expect(ownerRow.querySelector<HTMLElement>(".ui-org-tree__icon")!.style.color).toBe("");
    expect(container.querySelector('[role="treeitem"] .ui-org-tree__name')).toBeTruthy();

    const enterpriseIcon = container.querySelector('[data-brand="bytefolk-open-herd"]');
    expect(enterpriseIcon).toBeInTheDocument();
    expect(enterpriseIcon?.closest(".ui-org-tree__row--enterprise")).toBeTruthy();
  });

  it("breathes the status light only for positions with a live run (#73)", () => {
    render(<OrgTree snapshot={SNAPSHOT} runningIds={new Set(["issue-researcher"])} />);
    const running = screen.getByText("issue-researcher").closest('[role="treeitem"]')!;
    expect(running.querySelector(".ui-org-tree__led")!.className).toContain("is-running");
    const idle = screen.getByText("release-engineer").closest('[role="treeitem"]')!;
    expect(idle.querySelector(".ui-org-tree__led")!.className).not.toContain("is-running");
  });

  it("renders the empty state when the tree has no positions", () => {
    render(<OrgTree snapshot={{ ...SNAPSHOT, tree: [], positionCount: 0, depth: 0 }} />);
    expect(screen.getByText("尚无岗位，点击招聘")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "招聘岗位" })).toBeDisabled();
  });

  it("emits a move proposal when a movable position is dropped on a manager or enterprise root", () => {
    const onMove = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onMove={onMove} />);
    const source = screen.getByText("issue-researcher").closest('[role="treeitem"]')!;
    const manager = screen.getByText("release-engineer").closest('[role="treeitem"]')!;
    const enterprise = screen.getByText("oss-maintainer").closest('[role="treeitem"]')!;
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(manager, { dataTransfer });
    fireEvent.drop(manager, { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("issue-researcher", "release-engineer");

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(enterprise, { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("issue-researcher", null);
    expect(screen.getByText("repo-owner").closest('[role="treeitem"]')).toHaveAttribute("draggable", "false");
  });
});

describe("OrgTree (#32 §1 insertion lines, invalid-drop rejection, ⌘ reorder)", () => {
  const NESTED: OrgTreeSnapshot = {
    ...SNAPSHOT,
    positionCount: 5,
    depth: 3,
    tree: [
      {
        ...SNAPSHOT.tree[0]!,
        children: [
          SNAPSHOT.tree[0]!.children[0]!,
          {
            ...SNAPSHOT.tree[0]!.children[1]!,
            children: [
              {
                id: "research-intern",
                reportTo: "issue-researcher",
                budget: { perTask: { tokens: 10000 }, perDay: { tokens: 100000 } },
                children: [],
              },
            ],
          },
          SNAPSHOT.tree[0]!.children[2]!,
        ],
      },
    ],
  };

  const makeDataTransfer = () => {
    const data = new Map<string, string>();
    return {
      effectAllowed: "move",
      dropEffect: "move",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
  };

  const withRowRect = (row: Element, height: number): void => {
    (row as HTMLElement).getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 200, bottom: height, width: 200, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  };

  /** jsdom's DragEvent drops MouseEventInit coordinates, so drive dragover
   * with a MouseEvent carrying clientY (plus the dataTransfer shim). */
  const dragOverAt = (row: Element, dataTransfer: unknown, clientY: number): void => {
    const event = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    fireEvent(row, event);
  };

  it("edge drops emit an ordered same-level insertion instead of a reparent", () => {
    const onMove = vi.fn();
    const onDropPosition = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onMove={onMove} onDropPosition={onDropPosition} />);
    const source = screen.getByText("release-engineer").closest('[role="treeitem"]')!;
    const anchor = screen.getByText("community-operator").closest('[role="treeitem"]')!;
    withRowRect(anchor, 40);
    const dataTransfer = makeDataTransfer();

    // Lower quarter of the anchor row → insert after it.
    fireEvent.dragStart(source, { dataTransfer });
    dragOverAt(anchor, dataTransfer, 35);
    expect(dataTransfer.dropEffect).toBe("move");
    fireEvent.drop(anchor, { dataTransfer });
    expect(onDropPosition).toHaveBeenCalledWith({
      id: "release-engineer",
      parentId: "repo-owner",
      order: ["community-operator", "release-engineer", "issue-researcher"],
    });
    expect(onMove).not.toHaveBeenCalled();

    // Upper quarter → insert before it (source moved back in).
    onDropPosition.mockClear();
    fireEvent.dragStart(source, { dataTransfer });
    dragOverAt(anchor, dataTransfer, 5);
    fireEvent.drop(anchor, { dataTransfer });
    expect(onDropPosition).toHaveBeenCalledWith({
      id: "release-engineer",
      parentId: "repo-owner",
      order: ["release-engineer", "community-operator", "issue-researcher"],
    });
  });

  it("refuses drops onto self or own descendants: dropEffect=none, row greyed, light toast on release", () => {
    const onMove = vi.fn();
    const onDropPosition = vi.fn();
    render(<OrgTree snapshot={NESTED} onMove={onMove} onDropPosition={onDropPosition} />);
    const source = screen.getByText("issue-researcher").closest('[role="treeitem"]')!;
    const descendant = screen.getByText("research-intern").closest('[role="treeitem"]')!;
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(descendant, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    expect(descendant.className).toContain("is-drop-denied");

    // Browser refuses the drop; the source's dragend surfaces the toast.
    fireEvent.dragEnd(source);
    expect(screen.getByRole("status")).toHaveTextContent("不能移动到自身或自己的下属");
    expect(onMove).not.toHaveBeenCalled();
    expect(onDropPosition).not.toHaveBeenCalled();
  });

  it("⌘↑/⌘↓ reorder within the same level; ⌘←/⌘→ change levels via move proposals", () => {
    const onMove = vi.fn();
    const onDropPosition = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onMove={onMove} onDropPosition={onDropPosition} />);
    const tree = screen.getByRole("tree");

    fireEvent.click(screen.getByText("issue-researcher"));
    fireEvent.keyDown(tree, { key: "ArrowUp", metaKey: true });
    expect(onDropPosition).toHaveBeenLastCalledWith({
      id: "issue-researcher",
      parentId: "repo-owner",
      order: ["issue-researcher", "community-operator", "release-engineer"],
    });

    fireEvent.keyDown(tree, { key: "ArrowDown", metaKey: true });
    expect(onDropPosition).toHaveBeenLastCalledWith({
      id: "issue-researcher",
      parentId: "repo-owner",
      order: ["community-operator", "release-engineer", "issue-researcher"],
    });

    // ⌘→ demotes under the previous sibling (release-engineer's previous
    // sibling is issue-researcher) — a level change, so it goes through move.
    fireEvent.click(screen.getByText("release-engineer"));
    fireEvent.keyDown(tree, { key: "ArrowRight", metaKey: true });
    expect(onMove).toHaveBeenLastCalledWith("release-engineer", "issue-researcher");

    // ⌘← lifts a child back to the parent's own report line (repo-owner → null).
    fireEvent.click(screen.getByText("issue-researcher"));
    fireEvent.keyDown(tree, { key: "ArrowLeft", metaKey: true });
    expect(onMove).toHaveBeenLastCalledWith("issue-researcher", null);
  });

  it("blocks ⌘ adjustments on the enterprise owner with a toast and no callback", () => {
    const onMove = vi.fn();
    const onDropPosition = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onMove={onMove} onDropPosition={onDropPosition} />);
    const tree = screen.getByRole("tree");

    fireEvent.click(screen.getByText("repo-owner"));
    fireEvent.keyDown(tree, { key: "ArrowUp", metaKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("企业负责人不能调整汇报关系");
    expect(onMove).not.toHaveBeenCalled();
    expect(onDropPosition).not.toHaveBeenCalled();
  });

  it("⌘Z / Ctrl+Z requests single-step undo while the tree has focus", () => {
    const onUndo = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onUndo={onUndo} />);
    const tree = screen.getByRole("tree");

    fireEvent.keyDown(tree, { key: "z", metaKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tree, { key: "Z", ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it("hover '+' recruits under the hovered position", () => {
    const onHireEntry = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onHireEntry={onHireEntry} />);
    fireEvent.click(screen.getByRole("button", { name: "在 community-operator 下招聘下属" }));
    expect(onHireEntry).toHaveBeenCalledWith("community-operator");
  });

  it("empty state recruits at the enterprise root", () => {
    const onHireEntry = vi.fn();
    render(<OrgTree snapshot={{ ...SNAPSHOT, positionCount: 0, tree: [] }} onHireEntry={onHireEntry} />);
    fireEvent.click(screen.getByRole("button", { name: "招聘岗位" }));
    expect(onHireEntry).toHaveBeenCalledWith(null);
  });

  it("hides the '+' entry without onHireEntry or while moves are disabled", () => {
    const onHireEntry = vi.fn();
    const first = render(<OrgTree snapshot={SNAPSHOT} />);
    expect(first.container.querySelector(".ui-org-tree__add")).toBeNull();
    const second = render(<OrgTree snapshot={SNAPSHOT} onHireEntry={onHireEntry} moveDisabled />);
    expect(second.container.querySelectorAll(".ui-org-tree__add")).toHaveLength(0);
  });

  it("'+' does not select the row and stops propagation", () => {
    const onSelect = vi.fn();
    const onHireEntry = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onSelect={onSelect} onHireEntry={onHireEntry} />);
    fireEvent.click(screen.getByRole("button", { name: "在 release-engineer 下招聘下属" }));
    expect(onHireEntry).toHaveBeenCalledWith("release-engineer");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hover group entry starts a prefilled group draft for the row (#53)", () => {
    const onGroupEntry = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onGroupEntry={onGroupEntry} />);
    fireEvent.click(screen.getByRole("button", { name: "与 community-operator 发起群聊" }));
    expect(onGroupEntry).toHaveBeenCalledWith("community-operator");
  });

  it("group entry is absent without onGroupEntry and independent of moveDisabled (#53)", () => {
    const onGroupEntry = vi.fn();
    const first = render(<OrgTree snapshot={SNAPSHOT} />);
    expect(first.container.querySelectorAll(".ui-org-tree__group")).toHaveLength(0);
    const second = render(<OrgTree snapshot={SNAPSHOT} onGroupEntry={onGroupEntry} moveDisabled />);
    expect(second.container.querySelectorAll(".ui-org-tree__group").length).toBeGreaterThan(0);
  });

  it("group entry does not select the row and stops propagation (#53)", () => {
    const onSelect = vi.fn();
    const onGroupEntry = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onSelect={onSelect} onGroupEntry={onGroupEntry} />);
    fireEvent.click(screen.getByRole("button", { name: "与 release-engineer 发起群聊" }));
    expect(onGroupEntry).toHaveBeenCalledWith("release-engineer");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
