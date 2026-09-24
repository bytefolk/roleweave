import { describe, expect, it } from "vitest";
import { presentDismissHandoff } from "../src/org/dismiss-handoff";

describe("dismiss handoff overlay (#464)", () => {
  it("hides overlay when the flag is off", () => {
    const view = presentDismissHandoff({
      flagOn: false,
      dismissingId: "issue-researcher",
      facts: { runningTurns: 1, boundGoals: 2, pendingApprovals: 3 },
      candidates: [{ id: "repo-owner", name: "Owner", mode: "write" }],
    });
    expect(view.visible).toBe(false);
    expect(view.suggestion).toBeNull();
  });

  it("suggests another position without skipping dismiss confirmation", () => {
    const view = presentDismissHandoff({
      flagOn: true,
      dismissingId: "issue-researcher",
      facts: { runningTurns: 1, boundGoals: 0, pendingApprovals: 1 },
      candidates: [
        { id: "issue-researcher", name: "Researcher" },
        { id: "repo-owner", name: "Owner", mode: "write" },
      ],
    });
    expect(view.visible).toBe(true);
    expect(view.suggestion?.id).toBe("repo-owner");
    expect(view.facts.runningTurns).toBe(1);
  });
});
