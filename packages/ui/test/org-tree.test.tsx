import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import { describe, expect, it, vi } from "vitest";
import { OrgTree } from "../src/org-tree";
import { SNAPSHOT } from "./fixtures";

describe("OrgTree (D1 spec §2, frozen org-tree.v1)", () => {
  it("keeps row highlights inset from both sidebar edges", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.ui-org-tree\s*\{[^}]*padding:\s*6px 8px 12px/s);
    expect(css).toMatch(/\.ui-org-tree__row\s*\{[^}]*box-sizing:\s*border-box/s);
  });

  it("#413 does not crossfade selected-row fill so two employees cannot glow at once", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    expect(css).not.toMatch(/\.ui-org-tree__row\s*\{[^}]*transition:\s*background/s);
  });
  it("leads with people: owner at the top level, children by reportTo, no project pseudo-row", () => {
    render(<OrgTree snapshot={SNAPSHOT} />);
    const tree = screen.getByRole("tree");
    expect(tree).toBeInTheDocument();

    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(4); // repo-owner + 3 positions

    // The project name is the switcher's job; the directory lists people only.
    expect(screen.queryByText("oss-maintainer")).not.toBeInTheDocument();

    const owner = screen.getByText("repo-owner").closest('[role="treeitem"]');
    expect(owner).toHaveAttribute("aria-level", "1");
    expect(owner).toHaveAttribute("aria-expanded", "true");
    expect(owner).toHaveAttribute("aria-selected", "false");

    const child = screen.getByText("issue-researcher").closest('[role="treeitem"]');
    expect(child).toHaveAttribute("aria-level", "2");
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

  it("keeps optional row metadata inside the selectable position without adding another action", () => {
    const onSelect = vi.fn();
    const manage = vi.fn();
    const metadata = vi.fn((id: string) => id === "issue-researcher" ? <span>Codex</span> : null);
    render(<OrgTree snapshot={SNAPSHOT} rowMetadata={metadata} onSelect={onSelect}
      rowActions={id => id === "issue-researcher" ? <button onClick={event => { event.stopPropagation(); manage(id); }}>Manage employee</button> : null} />);
    const row = screen.getByText("issue-researcher").closest('[role="treeitem"]')!;
    expect(within(row as HTMLElement).getByText("Codex")).toBeVisible();
    fireEvent.click(screen.getByText("Codex"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("issue-researcher");
    fireEvent.click(screen.getByRole("button", { name: "Manage employee" }));
    expect(manage).toHaveBeenCalledExactlyOnceWith("issue-researcher");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(metadata.mock.calls.flat()).not.toContain("__enterprise__");
  });

  it("toggles expansion with the arrow buttons", () => {
    const onExpand = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onExpand={onExpand} />);
    const toggles = screen.getAllByRole("button", { name: "收起" });
    expect(toggles).toHaveLength(1); // repo-owner only

    fireEvent.click(toggles[0]!); // collapse repo-owner
    expect(onExpand).toHaveBeenCalledWith("repo-owner", false);
    expect(screen.queryByText("issue-researcher")).not.toBeInTheDocument();
    expect(screen.getByText("repo-owner")).toBeInTheDocument();
  });

  it("supports keyboard navigation (ModuleRail arrow pattern)", () => {
    render(<OrgTree snapshot={SNAPSHOT} rowMetadata={() => <span>Agent</span>} />);
    const tree = screen.getByRole("tree");
    const items = screen.getAllByRole("treeitem");
    act(() => {
      (items[0] as HTMLElement).focus();
    });
    expect(items[0]).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(tree, { key: "End" });
    expect(document.activeElement).toBe(items[3]);

    fireEvent.keyDown(tree, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);

    // Enter collapses the focused owner (the top-level row).
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(screen.queryByText("issue-researcher")).not.toBeInTheDocument();
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

    // The brand mark lives in the project switcher, never inside the tree.
    expect(container.querySelector('[data-brand="bytefolk-open-herd"]')).toBeNull();
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

  it("emits a move proposal when a movable position is dropped on a manager or the tree background", () => {
    const onMove = vi.fn();
    render(<OrgTree snapshot={SNAPSHOT} onMove={onMove} rowMetadata={() => <span>Agent</span>} />);
    const tree = screen.getByRole("tree");
    const source = screen.getByText("issue-researcher").closest('[role="treeitem"]')!;
    const manager = screen.getByText("release-engineer").closest('[role="treeitem"]')!;
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

    // The tree background owns the top-level drop (reportTo null) now that
    // the project pseudo-row is gone.
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(tree, { dataTransfer });
    fireEvent.drop(tree, { dataTransfer });
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

  it.each([4, 30])("pointer movement only renders involved rows in a %i-position tree", (size) => {
    const tree = {
      ...SNAPSHOT,
      positionCount: size,
      tree: [{ ...SNAPSHOT.tree[0]!, children: [
        ...SNAPSHOT.tree[0]!.children,
        ...Array.from({ length: size - 4 }, (_, i) => ({
          ...SNAPSHOT.tree[0]!.children[0]!, id: `extra-${i}`,
        })),
      ] }],
    };
    // decorateRow runs inside the real row render. This catches fresh
    // callbacks defeating React.memo as well as root state updates traversing
    // the entire tree.
    const decorate = vi.fn((_id, row) => row);
    render(<OrgTree snapshot={tree} decorateRow={decorate} />);
    const treeEl = screen.getByRole("tree");
    const source = screen.getByText("release-engineer").closest('[role="treeitem"]')!;
    const target = screen.getByText("community-operator").closest('[role="treeitem"]')!;
    const dataTransfer = makeDataTransfer();
    withRowRect(target, 40);
    decorate.mockClear();
    fireEvent.dragStart(source, { dataTransfer });
    const dragStartRenders = decorate.mock.calls.map(([id]) => id);

    for (const [y, zone] of [[5, "before"], [20, "body"], [35, "after"]] as const) {
      decorate.mockClear();
      fireEvent.pointerMove(target, { clientY: y });
      // Native HTML drag-and-drop delivers pointer samples as dragover.
      dragOverAt(target, dataTransfer, y);
      expect(target).toHaveAttribute("data-drop-zone", zone);
      expect(decorate.mock.calls.map(([id]) => id)).toEqual(["community-operator"]);
      decorate.mockClear();
      for (let sample = 0; sample < 10; sample++) {
        fireEvent.pointerMove(target, { clientY: y + 1 });
        dragOverAt(target, dataTransfer, y + 1);
      }
      expect(decorate).not.toHaveBeenCalled();
    }

    // The tree background takes over as the top-level drop target: the row
    // hint clears and only the involved row re-renders (no pseudo-row left).
    dragOverAt(treeEl, dataTransfer, 20);
    expect(decorate.mock.calls.map(([id]) => id)).toEqual(["community-operator"]);
    expect(target).not.toHaveAttribute("data-drop-zone");
    decorate.mockClear();
    fireEvent.dragEnd(source);
    expect(new Set(decorate.mock.calls.map(([id]) => id))).toEqual(new Set(["release-engineer"]));
    expect(dragStartRenders).toEqual(["release-engineer"]);
  });

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
