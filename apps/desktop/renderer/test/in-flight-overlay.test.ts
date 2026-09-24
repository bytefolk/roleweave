import { describe, expect, it } from "vitest";
import { presentInFlightOverlay } from "../src/turns/in-flight-present";

describe("in-flight duplicate overlay (#463)", () => {
  it("hides the list when the flag is off", () => {
    const view = presentInFlightOverlay({
      flagOn: false,
      hasConfirmedTaskSummary: true,
      facts: [{ positionId: "issue-researcher", status: "running" }],
      choice: "join_existing",
    });
    expect(view.visible).toBe(false);
    expect(view.facts).toEqual([]);
  });

  it("keeps running rows when send anyway is chosen", () => {
    const facts = [{ positionId: "issue-researcher", status: "running" as const }];
    const view = presentInFlightOverlay({
      flagOn: true,
      hasConfirmedTaskSummary: true,
      facts,
      choice: "send_anyway",
    });
    expect(view.visible).toBe(true);
    expect(view.facts).toEqual(facts);
    expect(view.matching).toBe("send_anyway");
  });

  it("abstains without a confirmed task summary", () => {
    const view = presentInFlightOverlay({
      flagOn: true,
      hasConfirmedTaskSummary: false,
      facts: [{ positionId: "issue-researcher", status: "running" }],
      choice: "join_existing",
    });
    expect(view.matching).toBe("abstain");
    expect(view.facts).toHaveLength(1);
  });
});
