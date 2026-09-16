import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocViewer } from "../src/docs/DocViewer";
import { splitFrontmatter } from "../src/docs/frontmatter";

const SKILL_DOC = `---
name: release-engineer
description: Prepares release notes and publish checklists.
---

# Release Engineer

## Role

Prepares **release notes**.
`;

describe("splitFrontmatter", () => {
  it("splits a leading frontmatter block into data and body", () => {
    const { data, body, hasFrontmatter } = splitFrontmatter(SKILL_DOC);
    expect(hasFrontmatter).toBe(true);
    expect(data).toEqual({
      name: "release-engineer",
      description: "Prepares release notes and publish checklists.",
    });
    expect(body.startsWith("# Release Engineer")).toBe(true);
  });

  it("treats source without a leading fence as plain body", () => {
    const { data, body, hasFrontmatter } = splitFrontmatter("# Just markdown\n");
    expect(hasFrontmatter).toBe(false);
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown\n");
  });

  it("fails closed on an unterminated block", () => {
    const source = "---\nname: x\n# never closed";
    expect(splitFrontmatter(source).hasFrontmatter).toBe(false);
    expect(splitFrontmatter(source).body).toBe(source);
  });

  it("fails closed on malformed lines", () => {
    const source = "---\nnot a key value line\n---\nbody";
    expect(splitFrontmatter(source).hasFrontmatter).toBe(false);
  });

  it("accepts a block whose closing fence ends the file", () => {
    const { data, body, hasFrontmatter } = splitFrontmatter("---\nname: x\n---");
    expect(hasFrontmatter).toBe(true);
    expect(data.name).toBe("x");
    expect(body).toBe("");
  });
});

describe("DocViewer", () => {
  it("renders markdown body and strips frontmatter from it", () => {
    render(<DocViewer source={SKILL_DOC} />);
    expect(screen.getByRole("heading", { name: "Release Engineer" })).toBeTruthy();
    expect(screen.getByText("release notes")).toBeTruthy();
    expect(document.body.textContent).not.toContain("---");
  });

  it("surfaces frontmatter fields in the header meta", () => {
    render(<DocViewer source={SKILL_DOC} />);
    expect(screen.getByText("release-engineer")).toBeTruthy();
    expect(screen.getByText("Prepares release notes and publish checklists.")).toBeTruthy();
  });

  it("shows file-level version as provenance only when provided", () => {
    const { unmount } = render(<DocViewer source={SKILL_DOC} version="sha256:abc123" />);
    expect(screen.getByText("引用标识 sha256:abc123")).toBeTruthy();
    unmount();
    render(<DocViewer source={SKILL_DOC} />);
    expect(screen.queryByText(/引用标识/)).toBeNull();
  });

  it("renders plain markdown without a header meta block when no frontmatter exists", () => {
    render(<DocViewer source={"# Plain\n\nbody text"} />);
    expect(screen.getByRole("heading", { name: "Plain" })).toBeTruthy();
    expect(screen.getByText("body text")).toBeTruthy();
    expect(document.querySelector(".owb-doc-viewer__meta")).toBeNull();
  });

  it("prefers an explicit title over the frontmatter name", () => {
    render(<DocViewer source={SKILL_DOC} title="岗位技能书" />);
    expect(screen.getByText("岗位技能书")).toBeTruthy();
  });
});

describe("Type-aware document preview (#294)", () => {
  it("preserves TXT, JSON and YAML literally without Markdown interpretation", () => {
    for (const extension of ["txt", "json", "yaml"]) {
      const source = "# Literal heading\n**do not format**\n---\nvalue: true";
      const view = render(<DocViewer source={source} path={`knowledge/test.${extension}`} />);
      expect(screen.queryByRole("heading", { name: "Literal heading" })).not.toBeInTheDocument();
      expect(document.querySelector(".owb-doc-viewer__body")?.textContent).toBe(source);
      view.unmount();
    }
  });

  it("uses a collapsible table of contents only when three real headings exist", () => {
    render(<DocViewer source={"# First\n\n## Second\n\n```txt\n# not a heading\n```\n\n### Third"} />);
    const contents = screen.getByText("文章目录").closest("details");
    expect(contents).not.toHaveAttribute("open");
    const links = contents!.querySelectorAll("a");
    expect(links).toHaveLength(3);
    for (const link of links) expect(document.querySelector(link.getAttribute("href")!)).toBeTruthy();
  });
});
