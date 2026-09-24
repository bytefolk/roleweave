import { describe, expect, it } from "vitest";
import { presentReadyHostOverlay } from "../src/org/ready-host-overlay";
import type { TurnEngine } from "../src/turns/types";

const unready = { positionId: "codex-writer", engine: "codex" as TurnEngine, ready: false };
const readyQoder = { positionId: "qoder-owner", engine: "qoder" as TurnEngine, ready: true };

describe("ready-host overlay (#465)", () => {
  it("does not call Jev when zero or one ready candidate exists", () => {
    const none = presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready],
    });
    expect(none.callJev).toBe(false);

    const one = presentReadyHostOverlay({
      overlayEnabled: true,
      selected: unready,
      positions: [unready, readyQoder],
    });
    expect(one.callJev).toBe(false);
  });
});
