import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EngineIcon } from "../src/turns/engine-icon";
import type { TurnEngine } from "../src/turns";

describe("EngineIcon (#57)", () => {
  const engines: TurnEngine[] = ["qoder", "claude-code", "claude-local", "codex", "codex-local"];

  it.each(engines)("renders a 14px brand mark for %s", (engine) => {
    const { container } = render(<EngineIcon engine={engine} />);
    const img = container.querySelector("img.owb-engine-icon");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps each engine to its own brand mark, with the two claude engines sharing one", () => {
    const src = (engine: TurnEngine) => {
      const { container } = render(<EngineIcon engine={engine} />);
      return container.querySelector("img.owb-engine-icon")?.getAttribute("src") ?? "";
    };
    // Vite inlines the small claude.svg as a data URI; the brand fill #D97757
    // stays percent-encoded, so it is the stable identity marker in tests.
    expect(src("qoder")).toMatch(/qoder/);
    expect(src("claude-code")).toContain("%23D97757");
    expect(src("claude-local")).toContain("%23D97757");
    expect(src("claude-code")).toBe(src("claude-local"));
    expect(src("claude-code")).not.toEqual(src("qoder"));
    // #206: Codex carries its own mark, distinct from every other engine.
    expect(src("codex")).toMatch(/codex/);
    expect(src("codex")).not.toEqual(src("qoder"));
    expect(src("codex")).not.toEqual(src("claude-code"));
    // The two Codex Hosts share one mark, exactly as the two Claude ones do.
    expect(src("codex-local")).toBe(src("codex"));
  });
});
