import { describe, expect, it } from "vitest";
import { localizePositionCard, type PositionCardData } from "@roleweave/ui";

const position: PositionCardData = {
  id: "issue-researcher",
  name: "Issue Researcher",
  description: "Triages issues and produces researched summaries.",
  reportTo: "repo-owner",
  mode: "approval_required",
  contextScope: "position",
  permissions: { toolAllow: [], toolDeny: [] },
  budget: null,
  metadata: {
    "roleweave.i18n.zh-CN.name": "问题研究员",
    "roleweave.i18n.zh-CN.description": "分诊问题，并产出经研究的摘要。",
  },
};

describe("position display localization", () => {
  it("uses the current locale's metadata copy without changing canonical data", () => {
    const localized = localizePositionCard(position, "zh-CN");
    expect(localized.name).toBe("问题研究员");
    expect(localized.description).toBe("分诊问题，并产出经研究的摘要。");
    expect(position.name).toBe("Issue Researcher");
  });

  it("falls back to the canonical copy when a locale is not provided", () => {
    const localized = localizePositionCard(position, "en");
    expect(localized.name).toBe("Issue Researcher");
    expect(localized.description).toBe("Triages issues and produces researched summaries.");
  });
});
