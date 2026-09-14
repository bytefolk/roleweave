import { describe, expect, it } from "vitest";
import { assignDefaultAvatars, AVATAR_PRESETS, avatarSrcFor, readAvatarPreferences } from "../src/PositionAvatar";

describe("employee portrait allocation", () => {
  const ids = ["agent-smoke-owner", "test-codex", "test-claude", "test-qoder"];
  it("gives the four test employees different transparent portrait assets", () => {
    const assigned = assignDefaultAvatars(ids, {});
    expect(new Set(ids.map((id) => avatarSrcFor(id, assigned[id]))).size).toBe(ids.length);
  });
  it("keeps faces stable when employees are added or reordered", () => {
    const first = assignDefaultAvatars(ids.slice(1), {});
    const next = assignDefaultAvatars([...ids].reverse(), first);
    for (const id of ids.slice(1)) expect(next[id]).toBe(first[id]);
    expect(assignDefaultAvatars(ids, next)).toEqual(next);
  });
  it("preserves uploaded and manually selected avatars", () => {
    const upload = "data:image/png;base64,YWJj";
    const assigned = assignDefaultAvatars(ids, { "test-codex": upload, "test-qoder": AVATAR_PRESETS[0].id });
    expect(avatarSrcFor("test-codex", assigned["test-codex"])).toBe(upload);
    expect(assigned["test-qoder"]).toBe(AVATAR_PRESETS[0].id);
  });
  it("only repeats presets after every face has been used", () => {
    const assigned = assignDefaultAvatars(Array.from({ length: 12 }, (_, i) => `employee-${i}`), {});
    for (const preset of AVATAR_PRESETS) expect(Object.values(assigned).filter((value) => value === preset.id)).toHaveLength(3);
  });
  it("ignores malformed storage entries instead of crashing the roster", () => {
    const storage = { getItem: () => JSON.stringify({ bad: 12, svg: "data:image/svg+xml;utf8,<svg/>", good: AVATAR_PRESETS[0].id }) };
    expect(readAvatarPreferences(storage, "/workspace")).toEqual({ good: AVATAR_PRESETS[0].id });
    expect(readAvatarPreferences({ getItem: () => "broken" }, "/workspace")).toEqual({});
  });
});
