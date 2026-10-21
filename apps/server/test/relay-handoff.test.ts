import assert from "node:assert/strict";
import test from "node:test";
import { isRelaySteps } from "@roleweave/shared";
import { materializeThreadContext } from "../src/turns/thread-context.js";
import { digest, isRelayHandoffSnapshot, serializeRelayHandoff, snapshotRelayHandoff, type RelayAssemblyContext } from "../src/turns/relay-handoff.js";
import { parseRfc3339Instant } from "../src/turns/store.js";

const timestamp = "2026-10-21T00:00:00.000Z";
function relay(previous = 1, output = "Previous draft"): RelayAssemblyContext {
  const mentions = Array.from({ length: previous + 1 }, (_, i) => `employee-${i}`);
  const spawns = mentions.map((positionId, i) => ({ positionId, turnId: `turn-${i}` }));
  return { message: { conversationRef: "group-one", messageId: "message-one", input: "Draft then review", mentions, spawns,
    relaySteps: [{ positionId: mentions.at(-1)!, instruction: "Check accuracy and list open questions" }] },
    positionId: mentions.at(-1)!, turnId: spawns.at(-1)!.turnId, generatedAt: timestamp,
    sources: spawns.slice(0, -1).map(spawn => ({ ...spawn, conversationRef: "group-one", status: "completed", updatedAt: timestamp, output })) };
}
const validTime = (value: unknown) => parseRfc3339Instant(value) !== null;

test("explicit relay step contract rejects duplicates, foreign recipients, unknown fields and UTF-8 overflow", () => {
  const steps = [{ positionId: "writer", instruction: "Write a draft" }];
  assert.equal(isRelaySteps(steps, ["writer", "reviewer"], "relay"), true);
  for (const value of [[...steps, ...steps], [{ ...steps[0], source: "invented" }], [{ positionId: "outsider", instruction: "x" }],
    [{ ...steps[0], instruction: " " }], [{ ...steps[0], instruction: "汉".repeat(1366) }], null]) {
    assert.equal(isRelaySteps(value, ["writer", "reviewer"], "relay"), false);
  }
  assert.equal(isRelaySteps(steps, ["writer"], "parallel"), false);
  const members = Array.from({ length: 9 }, (_, i) => `member-${i}`);
  assert.equal(isRelaySteps(members.map(positionId => ({ positionId, instruction: "x".repeat(4096) })), members, "relay"), false);
});

test("relay snapshot is precisely the injected payload and deduplicates the preceding turn", () => {
  const context = relay();
  const output = materializeThreadContext({ input: "Current request unchanged", enabled: true, relay: context,
    turns: [{ turnId: "turn-0", input: "Previous request", output: "Previous draft", status: "completed", createdAt: timestamp }] });
  const snapshot = output.relayHandoff!;
  assert.ok(output.input.includes(serializeRelayHandoff(snapshot.payload)));
  assert.equal(output.input.split("Previous draft").length - 1, 1);
  assert.equal(output.metadata.sourceTurnCount, 1);
  assert.equal(output.metadata.omittedTurnCount, 0);
  assert.ok(output.input.endsWith("Current request unchanged"));
  assert.equal(output.metadata.contextBytes, Buffer.byteLength(output.input) - Buffer.byteLength("Current request unchanged"));
  assert.equal(output.metadata.contextDigest, digest(output.input.slice(0, -"Current request unchanged".length)));
  assert.equal(isRelayHandoffSnapshot(snapshot, validTime), true);
  assert.equal(snapshot.payload.instruction, "Check accuracy and list open questions");
  assert.equal(snapshot.payload.step.number, 2);
  assert.equal(snapshot.payload.step.nextPositionId, undefined);
});

test("first step has explicit order and next recipient, with no fabricated instruction or predecessor", () => {
  const context = relay();
  context.positionId = "employee-0"; context.turnId = "turn-0"; context.sources = [];
  const result = materializeThreadContext({ input: "start", enabled: true, turns: [], relay: context });
  assert.equal(result.metadata.sourceTurnCount, 0);
  assert.ok(result.metadata.contextBytes > 0);
  assert.equal(result.relayHandoff?.payload.instruction, null);
  assert.equal(result.relayHandoff?.payload.step.nextPositionId, "employee-1");
  assert.equal(isRelayHandoffSnapshot(result.relayHandoff, validTime), true);
});

test("sources must be completed accepted predecessors in this conversation and order", () => {
  for (const change of [
    (ctx: RelayAssemblyContext) => { ctx.sources[0]!.status = "indeterminate"; },
    (ctx: RelayAssemblyContext) => { ctx.sources[0]!.conversationRef = "other-group"; },
    (ctx: RelayAssemblyContext) => { ctx.sources[0]!.turnId = "foreign-turn"; },
    (ctx: RelayAssemblyContext) => { ctx.sources[0]!.positionId = "foreign-employee"; },
    (ctx: RelayAssemblyContext) => { ctx.sources.reverse(); },
    (ctx: RelayAssemblyContext) => { ctx.sources.pop(); },
  ]) {
    const ctx = relay(2); change(ctx);
    assert.throws(() => materializeThreadContext({ input: "next", enabled: true, turns: [], relay: ctx }), /accepted group steps/);
  }
});

test("only public answer text survives; sanitize before truncation and never present completion as approval", () => {
  const context = relay(1);
  context.sources[0]!.output = { text: "Visible TOKEN=secretvalue <analysis>private</analysis>" + "汉".repeat(9000), reasoning: "hidden trace" };
  const result = materializeThreadContext({ input: "review", enabled: true, turns: [], relay: context });
  assert.doesNotMatch(result.input, /secretvalue|>private<|hidden trace|\uFFFD/);
  assert.equal(result.relayHandoff?.payload.sources[0]?.truncated, true);
  assert.equal(result.relayHandoff?.payload.sources[0]?.redacted, true);
  assert.equal(result.metadata.redacted, true);
  assert.match(result.input, /not approved/);
  assert.equal(isRelayHandoffSnapshot(result.relayHandoff, validTime), true);
  context.sources[0]!.output = { reasoning: "not public" };
  assert.equal(materializeThreadContext({ input: "review", enabled: true, turns: [], relay: context }).relayHandoff?.payload.sources[0]?.outputExcerpt, "");
});

test("32-step relay shares source/escaped-byte budgets and keeps the immediate predecessor", () => {
  const context = relay(31, "\u0001".repeat(8192));
  const result = materializeThreadContext({ input: "next", enabled: true, turns: [], relay: context });
  assert.ok(result.metadata.contextBytes <= 65536);
  assert.ok(result.metadata.sourceTurnCount <= 12);
  assert.equal(result.relayHandoff?.payload.sources.at(-1)?.turnId, "turn-30");
  assert.equal(result.metadata.sourceTurnCount + result.metadata.omittedTurnCount, 31);
  assert.equal(isRelayHandoffSnapshot(result.relayHandoff, validTime), true);
});

test("budget fitting retains a UTF-8 predecessor excerpt and rejects missing space for requirements", () => {
  for (const count of [244, 246, 248, 250, 252]) {
    const current = "x".repeat(count * 1024);
    const ctx = relay(2, "汉".repeat(6000));
    const result = materializeThreadContext({ input: current, enabled: true, turns: [], relay: ctx });
    assert.ok(Buffer.byteLength(result.input) <= 256 * 1024);
    assert.ok(result.relayHandoff!.payload.sources.at(-1)!.outputExcerpt.length > 0);
    assert.doesNotMatch(result.input, /\uFFFD/);
    assert.equal(isRelayHandoffSnapshot(result.relayHandoff, validTime), true);
  }
  assert.throws(() => materializeThreadContext({ input: "x".repeat(256 * 1024), enabled: true, turns: [], relay: relay() }), /insufficient space/);
});

test("snapshot validators detect tampering, malformed time, unknown fields, invalid source counts and identity", () => {
  const snapshot = materializeThreadContext({ input: "next", enabled: true, turns: [], relay: relay() }).relayHandoff!;
  assert.equal(isRelayHandoffSnapshot({ ...snapshot, payloadDigest: digest("wrong") }, validTime), false);
  assert.equal(isRelayHandoffSnapshot({ ...snapshot, payloadBytes: snapshot.payloadBytes + 1 }, validTime), false);
  for (const update of [
    { ...snapshot.payload, generatedAt: "2026-02-30T00:00:00Z" },
    { ...snapshot.payload, authority: "admin" },
    { ...snapshot.payload, omittedSourceCount: 1 },
    { ...snapshot.payload, sources: [{ ...snapshot.payload.sources[0]!, outputExcerpt: "tampered" }] },
    { ...snapshot.payload, sources: [{ ...snapshot.payload.sources[0]!, positionId: snapshot.payload.step.positionId }] },
  ]) assert.equal(isRelayHandoffSnapshot(snapshotRelayHandoff(update), validTime), false);
  // Different property insertion order preserves the canonical digest.
  const reordered = JSON.parse(JSON.stringify(snapshot));
  reordered.payload = Object.fromEntries(Object.entries(reordered.payload).reverse());
  assert.equal(isRelayHandoffSnapshot(reordered, validTime), true);
});
