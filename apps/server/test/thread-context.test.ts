import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { compactThreadContextHistory, isThreadContextMetadata, materializeThreadContext } from "../src/turns/thread-context.js";
import { MAX_GROUP_MEMBERS, MAX_TURNS_PER_POSITION, THREAD_CONTEXT_MAX_OMITTED_TURNS } from "../src/history-limits.js";
import type { TurnRecord } from "@roleweave/shared";

function turn(id: string, input: string, output: unknown, status: TurnRecord["status"] = "completed"): TurnRecord {
  return { schemaVersion: "turn-record.v1", conversationId: "conversation", turnId: id,
    positionId: "repo-owner", engine: "qoder", status, input, output, envelopeDigest: `sha256:${"0".repeat(64)}`,
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", events: [] };
}

test("thread context carries trusted background and draft, leaving the current request verbatim", () => {
  const current = "Revise the draft for the same project.";
  const result = materializeThreadContext({ input: current, enabled: true, turns: [turn("one", "Project Orion ships Friday; use concise prose", "Orion draft")] });
  assert.match(result.input, /Project Orion ships Friday/);
  assert.match(result.input, /Orion draft/);
  assert.ok(result.input.endsWith(current));
  assert.equal(result.metadata.sourceTurnCount, 1);
  assert.match(result.metadata.contextDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.metadata.contextBytes, Buffer.byteLength(result.input) - Buffer.byteLength(current));
});

test("disabled and empty context do not change model input; unsafe results are excluded", () => {
  const turns = [turn("one", "background", "draft")];
  assert.equal(materializeThreadContext({ input: "next", enabled: false, turns }).input, "next");
  const result = materializeThreadContext({ input: "next", enabled: true, turns: [turn("bad", "not complete", "untrusted secret draft", "indeterminate")] });
  assert.equal(result.input, "next");
  assert.equal(result.metadata.sourceTurnCount, 0);
});

test("thread context is UTF-8 bounded, preserves the first and latest turns, and removes credential-shaped material", () => {
  const turns = Array.from({ length: 30 }, (_, index) => turn(String(index), `turn ${index} background ${"汉字".repeat(9000)}`, `draft ${index}`));
  turns[0] = turn("0", "original project TOKEN=supersecretvalue Bearer topsecretvalue", "first draft");
  const result = materializeThreadContext({ input: "continue", enabled: true, turns });
  assert.ok(result.metadata.contextBytes <= 64 * 1024);
  assert.match(result.input, /original project/);
  assert.match(result.input, /draft 29/);
  assert.doesNotMatch(result.input, /supersecretvalue|topsecretvalue|\uFFFD/);
  assert.equal(result.metadata.redacted, true);
  assert.equal(result.metadata.truncated, true);
  assert.ok(result.metadata.omittedTurnCount > 0);
  const full = "汉".repeat(Math.floor(256 * 1024 / 3));
  const bounded = materializeThreadContext({ input: full, enabled: true, turns });
  assert.ok(Buffer.byteLength(bounded.input) <= 256 * 1024);
  assert.ok(bounded.input.endsWith(full));
});

test("relay handoff remains quoted, bounded data even when personal history is disabled", () => {
  const result = materializeThreadContext({ input: "review", enabled: false, turns: [], supplementalContext: [{ label: "writer", input: "draft request", output: "the draft" }] });
  assert.match(result.input, /the draft/);
  assert.match(result.input, /untrusted historical data/);
  assert.ok(result.input.endsWith("review"));
  assert.throws(() => materializeThreadContext({ input: "x".repeat(256 * 1024), enabled: false, turns: [], supplementalContext: [{ label: "writer", input: "draft request", output: "the draft" }] }), /insufficient space/);
});

test("private reasoning and structured trace fields never appear in model history", () => {
  const result = materializeThreadContext({ input: "continue", enabled: true, turns: [
    turn("first", "project background", { text: "public answer", thinking: "private trace", tools: ["private tool"] }),
    turn("second", "more", "public answer <analysis>private unclosed reasoning"),
  ] });
  assert.match(result.input, /public answer/);
  assert.doesNotMatch(result.input, /private trace|private tool|private unclosed reasoning/);
});


test("the maximum group history and handoff count still produces persistable context metadata", () => {
  const result = materializeThreadContext({ input: "next", enabled: true,
    turns: Array.from({ length: MAX_GROUP_MEMBERS * MAX_TURNS_PER_POSITION }, (_, index) => turn(String(index), "prior input", "prior output")),
    supplementalContext: Array.from({ length: MAX_GROUP_MEMBERS }, (_, index) => ({ label: String(index), input: "handoff", output: "draft" })),
  });
  assert.equal(result.metadata.sourceTurnCount + result.metadata.omittedTurnCount, THREAD_CONTEXT_MAX_OMITTED_TURNS);
  assert.equal(isThreadContextMetadata(result.metadata), true);
});

test("thread context read bound preserves the current boundary and derives from both storage limits", () => {
  assert.equal(THREAD_CONTEXT_MAX_OMITTED_TURNS, 8224);
  assert.equal(THREAD_CONTEXT_MAX_OMITTED_TURNS, MAX_TURNS_PER_POSITION * MAX_GROUP_MEMBERS + MAX_GROUP_MEMBERS);
  const { metadata } = materializeThreadContext({ input: "next", enabled: true, turns: [], omittedTurnCount: THREAD_CONTEXT_MAX_OMITTED_TURNS });
  assert.equal(isThreadContextMetadata(metadata), true);
  assert.equal(isThreadContextMetadata({ ...metadata, omittedTurnCount: THREAD_CONTEXT_MAX_OMITTED_TURNS + 1 }), false);
});

test("thread context read bound follows injected changes to either source limit", async (t) => {
  const [limitsSource, contextSource] = await Promise.all([
    fs.readFile(new URL("../src/history-limits.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/turns/thread-context.js", import.meta.url), "utf8"),
  ]);
  const moduleUrl = (source: string): string => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  for (const [name, value] of [
    ["MAX_TURNS_PER_POSITION", MAX_TURNS_PER_POSITION * 2],
    ["MAX_GROUP_MEMBERS", MAX_GROUP_MEMBERS * 2],
    ["MAX_TURNS_PER_POSITION", MAX_TURNS_PER_POSITION / 2],
    ["MAX_GROUP_MEMBERS", MAX_GROUP_MEMBERS / 2],
  ] as const) {
    await t.test(`${name} = ${value}`, async () => {
      // Inject only a source constant into isolated module copies. Keep the
      // production derivation and validator intact, without a runtime override.
      const injectedSource = limitsSource.replace(new RegExp(`(export const ${name} = )\\d+;`), (_, prefix: string) => `${prefix}${value};`);
      assert.notEqual(injectedSource, limitsSource);
      const limitsUrl = moduleUrl(injectedSource);
      const limits = await import(limitsUrl) as typeof import("../src/history-limits.js");
      const context = await import(moduleUrl(contextSource
        .replace('"../history-limits.js"', JSON.stringify(limitsUrl))
        .replace('"@roleweave/shared"', JSON.stringify(import.meta.resolve("@roleweave/shared"))))) as typeof import("../src/turns/thread-context.js");
      const expected = limits.MAX_TURNS_PER_POSITION * limits.MAX_GROUP_MEMBERS + limits.MAX_GROUP_MEMBERS;
      assert.equal(limits.THREAD_CONTEXT_MAX_OMITTED_TURNS, expected);
      assert.notEqual(expected, THREAD_CONTEXT_MAX_OMITTED_TURNS);
      const { metadata } = context.materializeThreadContext({
        // Fill the input budget so every historical turn is omitted.
        input: "x".repeat(256 * 1024), enabled: true,
        turns: Array.from({ length: limits.MAX_TURNS_PER_POSITION * limits.MAX_GROUP_MEMBERS }, (_, index) => turn(String(index), "prior input", "prior output")),
        omittedTurnCount: limits.MAX_GROUP_MEMBERS,
      });
      assert.equal(metadata.omittedTurnCount, expected);
      assert.equal(context.isThreadContextMetadata(metadata), true);
      assert.equal(context.isThreadContextMetadata({ ...metadata, omittedTurnCount: expected + 1 }), false);
    });
  }
});

test("group candidate projection releases traces and large outputs while counting omitted turns", () => {
  const source = Array.from({ length: 40 }, (_, index) => turn(String(index), "background", "汉".repeat(10000)));
  const compact = compactThreadContextHistory(source);
  assert.equal(compact.turns.length, 12);
  assert.equal(compact.turns[0]!.turnId, "0");
  assert.equal(compact.turns.at(-1)!.turnId, "39");
  assert.equal(compact.omittedTurnCount, 28);
  assert.equal(compact.truncated, true);
  assert.equal(Object.hasOwn(compact.turns[0]!, "events"), false);
  assert.ok(compact.turns.every((entry) => Buffer.byteLength(String(entry.output)) <= 8 * 1024));
  const result = materializeThreadContext({ input: "continue", enabled: true, ...compact });
  assert.equal(result.metadata.sourceTurnCount + result.metadata.omittedTurnCount, 40);
  assert.equal(isThreadContextMetadata(result.metadata), true);
});
