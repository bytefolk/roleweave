import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { zhCatalog } from "@roleweave/ui";
import { SpaceModule, SPACE_SPINE_FILE_KEY } from "../src/space/SpaceModule.js";
import type { DocsFileEntry } from "@roleweave/shared";

/**
 * The spine filename is UI copy, so it lives in the catalog rather than as a
 * literal in the component (the CJK gate forbids string literals under src/).
 * Read it back from the same catalog so the fixtures cannot drift.
 */
const SPACE_SPINE_FILE = zhCatalog[SPACE_SPINE_FILE_KEY] as string;

const SPINE = `# 目标：对账自动化

先说结论。

## 验收标准
- [ ] 差异可归因
- [ ] 口径已评审

## 任务
| 任务 | 状态 | 负责岗位 | 截止 |
| --- | --- | --- | --- |
| 写脚本 | in_progress | engineer | 2026-10-05 |
| 梳理分类 | done | analyst | 2026-09-20 |
`;

const files: DocsFileEntry[] = [
  { path: SPACE_SPINE_FILE, kind: "file", size: SPINE.length, modifiedAt: "2026-10-01T00:00:00.000Z" },
  { path: "笔记.md", kind: "file", size: 10, modifiedAt: "2026-10-01T00:00:00.000Z" },
];

function setup(overrides: Partial<Parameters<typeof SpaceModule>[0]> = {}) {
  const readFile = vi.fn(async (path: string) => ({ content: path === SPACE_SPINE_FILE ? SPINE : "笔记", version: "v1" }));
  const writeFile = vi.fn(async () => ({ version: "v2" }));
  const onAccept = vi.fn();
  const utils = render(
    <SpaceModule
      workspaceOpen
      spaceName="对账专项"
      files={files}
      readFile={readFile}
      writeFile={writeFile}
      participants={[
        { positionId: "operator", name: "修雨", owner: true },
        { positionId: "engineer", name: "工程师", owner: false },
      ]}
      onAccept={onAccept}
      {...overrides}
    />,
  );
  return { ...utils, readFile, writeFile, onAccept };
}

describe("SpaceModule", () => {
  it("loads the spine file by default", async () => {
    const { readFile } = setup();
    await waitFor(() => expect(readFile).toHaveBeenCalledWith(SPACE_SPINE_FILE));
    await screen.findByText(/先说结论/);
  });

  it("marks exactly one participant as owner", async () => {
    setup();
    await screen.findByText("修雨");
    const ownerRow = document.querySelector(".owb-space-agents__item--owner");
    expect(ownerRow?.textContent).toContain("修雨");
    expect(document.querySelectorAll(".owb-space-agents__item--owner")).toHaveLength(1);
  });

  it("switches to the structure view and renders the board columns", async () => {
    setup();
    await screen.findByText(/先说结论/);
    fireEvent.click(screen.getByRole("button", { name: /结构/ }));
    await waitFor(() => expect(document.querySelector(".owb-space-structure")).toBeTruthy());
    expect(screen.getByText("写脚本")).toBeTruthy();
    expect(screen.getByText("梳理分类")).toBeTruthy();
  });

  it("disables accept until every criterion is ticked", async () => {
    const { onAccept } = setup();
    await waitFor(() => expect(document.querySelector(".owb-space-gate")).toBeTruthy());
    const gate = document.querySelector(".owb-space-gate") as HTMLElement;

    const acceptNow = () =>
      Array.from(gate.querySelectorAll("button")).find((b) => b.textContent?.includes("验收通过")) as HTMLButtonElement;
    // antd inserts a space between two CJK characters, so match on the raw text
    // with whitespace stripped rather than an exact string.
    const confirmNow = () =>
      Array.from(gate.querySelectorAll("button")).find(
        (b) => b.textContent?.replace(/\s/g, "") === "确认",
      ) as HTMLButtonElement | undefined;

    expect(acceptNow().disabled).toBe(true);

    const boxes = Array.from(gate.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) fireEvent.click(box);

    await waitFor(() => expect(acceptNow().disabled).toBe(false));

    fireEvent.click(acceptNow());
    await waitFor(() => expect(confirmNow()).toBeTruthy());
    fireEvent.click(confirmNow() as HTMLButtonElement);
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
  });

  it("writes criteria back as done on acceptance", async () => {
    const { writeFile } = setup();
    await waitFor(() => expect(document.querySelector(".owb-space-gate")).toBeTruthy());
    const gate = document.querySelector(".owb-space-gate") as HTMLElement;
    const boxes = Array.from(gate.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    for (const box of boxes) fireEvent.click(box);
    fireEvent.click(
      Array.from(gate.querySelectorAll("button")).find((b) => b.textContent?.includes("验收通过")) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(
        Array.from(gate.querySelectorAll("button")).some((b) => b.textContent?.replace(/\s/g, "") === "确认"),
      ).toBe(true),
    );
    fireEvent.click(
      Array.from(gate.querySelectorAll("button")).find(
        (b) => b.textContent?.replace(/\s/g, "") === "确认",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(writeFile).toHaveBeenCalled());
    const [, content] = writeFile.mock.calls[0] as unknown as [string, string, string];
    expect(content).toContain("- [x] 差异可归因");
    expect(content).toContain("- [x] 口径已评审");
  });
});
