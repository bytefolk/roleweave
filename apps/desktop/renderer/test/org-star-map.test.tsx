import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import { OrgStarMap } from "../src/org/OrgStarMap";

const SNAPSHOT: OrgTreeSnapshot = {
  schemaVersion: "org-tree.v1",
  business: "oss-maintainer",
  owner: "repo-owner",
  updatedAt: "2026-08-23T00:00:00.000Z",
  positionCount: 3,
  depth: 2,
  tree: [
    {
      id: "repo-owner",
      reportTo: null,
      budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
      children: [
        {
          id: "release-engineer",
          reportTo: "repo-owner",
          budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
          children: [
            {
              id: "docs-writer",
              reportTo: "release-engineer",
              budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

function renderMap(onSelect = vi.fn(), extra: Partial<ComponentProps<typeof OrgStarMap>> = {}) {
  return render(
    <OwbI18nProvider locale="en">
      <OrgStarMap
        snapshot={SNAPSHOT}
        displayNames={{ "repo-owner": "CEO", "release-engineer": "Release", "docs-writer": "Docs" }}
        selectedId="release-engineer"
        onSelect={onSelect}
        {...extra}
      />
    </OwbI18nProvider>,
  );
}

describe("OrgStarMap dock and fallback", () => {
  it("renders a crisp fallback list in jsdom and keeps the selected card", () => {
    renderMap();
    expect(screen.getByLabelText("Celestial org map")).toBeInTheDocument();
    expect(document.querySelector("[data-org-star-fallback]")).not.toBeNull();
    expect(screen.getByTestId ? document.querySelector("[data-org-star-card]") : document.querySelector("[data-org-star-card]")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Release" })).toBeInTheDocument();
  });

  it("filters by name, lists candidates, and Enter flies to the first match", () => {
    const onSelect = vi.fn();
    renderMap(onSelect);
    const search = screen.getByLabelText("Find a digital employee");
    fireEvent.change(search, { target: { value: "Docs" } });
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("docs-writer");
  });

  it("clicking a body selects it without proposing a move", () => {
    const onSelect = vi.fn();
    const onMove = vi.fn();
    renderMap(onSelect, { onMove });
    fireEvent.click(document.querySelector('[data-org-star-node="docs-writer"]')!);
    expect(onSelect).toHaveBeenCalledWith("docs-writer");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("refuses dropping a planet onto its own moon", () => {
    const onMove = vi.fn();
    renderMap(vi.fn(), { onMove });
    const source = document.querySelector('[data-org-star-node="release-engineer"]')!;
    const target = document.querySelector('[data-org-star-node="docs-writer"]')!;
    fireEvent.dragStart(source, { clientX: 0, clientY: 0, dataTransfer: { setData: vi.fn(), getData: () => "release-engineer" } });
    fireEvent.drop(target, { clientX: 40, clientY: 0, dataTransfer: { getData: () => "release-engineer" } });
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/itself or its own reports/i);
  });

  it("hire / dismiss / undo reuse the supplied channels", () => {
    const onHireEntry = vi.fn();
    const onDismiss = vi.fn();
    const onUndo = vi.fn();
    renderMap(vi.fn(), { onHireEntry, onDismiss, onUndo });
    fireEvent.click(screen.getAllByRole("button", { name: "Hire" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" }).at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onHireEntry).toHaveBeenCalledWith("release-engineer");
    expect(onDismiss).toHaveBeenCalledWith("release-engineer");
    expect(onUndo).toHaveBeenCalled();
  });
});
