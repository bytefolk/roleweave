import assert from "node:assert/strict";
import test from "node:test";
import type { EngineEvent } from "@roleweave/shared";
import { DeltaForwarder } from "../src/turns/delta-forwarder.js";

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000_000;
  return {
    now: () => time,
    advance: (ms: number) => { time += ms; },
  };
}

function deltaEvent(runId: string, text: string, timestamp = "2026-09-01T00:00:00.000Z"): EngineEvent {
  return { type: "model.delta", runId, timestamp, text };
}

function startedEvent(runId: string): EngineEvent {
  return { type: "run.started", runId, timestamp: "2026-09-01T00:00:00.000Z" };
}

function completedEvent(runId: string): EngineEvent {
  return {
    type: "run.completed",
    runId,
    timestamp: "2026-09-01T00:00:05.000Z",
    output: "done",
    terminalReason: "goal_met",
  };
}

function usageEvent(runId: string, totalTokens: number): EngineEvent {
  return { type: "usage", runId, timestamp: "2026-09-01T00:00:01.000Z", totalTokens };
}

test("rate-limits rapid model.delta events into batched forwards", () => {
  const clock = makeClock();
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({
    rateLimitMs: 100,
    onForward: (event) => forwarded.push(event),
    now: clock.now,
  });

  forwarder.handle(startedEvent("run-1"));
  clock.advance(1);
  forwarder.handle(deltaEvent("run-1", "a"));
  forwarder.handle(deltaEvent("run-1", "b"));
  forwarder.handle(deltaEvent("run-1", "c"));

  assert.equal(forwarded.length, 1, "only run.started forwarded immediately");
  assert.equal(forwarded[0]!.type, "run.started");

  clock.advance(100);
  forwarder.handle(deltaEvent("run-1", "d"));

  const deltas = forwarded.filter((e) => e.type === "model.delta");
  assert.equal(deltas.length, 1, "batched into one forwarded delta");
  assert.equal((deltas[0] as { text: string }).text, "abcd");
});

test("passes through non-delta events immediately", () => {
  const clock = makeClock();
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({
    rateLimitMs: 100,
    onForward: (event) => forwarded.push(event),
    now: clock.now,
  });

  forwarder.handle(startedEvent("run-1"));
  forwarder.handle(usageEvent("run-1", 200));

  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0]!.type, "run.started");
  assert.equal(forwarded[1]!.type, "usage");
});

test("stops forwarding after buffer cap is reached", () => {
  const clock = makeClock();
  const forwarded: EngineEvent[] = [];
  const capBytes = 10;
  const forwarder = new DeltaForwarder({
    rateLimitMs: 0,
    bufferCapBytes: capBytes,
    onForward: (event) => forwarded.push(event),
    now: clock.now,
  });

  forwarder.handle(deltaEvent("run-1", "12345"));
  forwarder.handle(deltaEvent("run-1", "67890"));

  const deltas = forwarded.filter((e) => e.type === "model.delta");
  assert.equal(deltas.length, 1);
  assert.equal((deltas[0] as { text: string }).text, "12345");

  forwarder.handle(deltaEvent("run-1", "OVERFLOW"));
  assert.ok(forwarder.isCapped);

  const afterCap = forwarded.filter((e) => e.type === "model.delta");
  assert.equal(afterCap.length, 1, "no further deltas forwarded after cap");
});

test("flushes buffered text on terminal event", () => {
  const clock = makeClock();
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({
    rateLimitMs: 5_000,
    onForward: (event) => forwarded.push(event),
    now: clock.now,
  });

  forwarder.handle(deltaEvent("run-1", "buffered"));
  forwarder.handle(completedEvent("run-1"));

  const deltas = forwarded.filter((e) => e.type === "model.delta");
  assert.equal(deltas.length, 1);
  assert.equal((deltas[0] as { text: string }).text, "buffered");

  const terminals = forwarded.filter((e) => e.type === "run.completed");
  assert.equal(terminals.length, 1);
});

test("adapter without streaming emits no deltas", () => {
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({
    onForward: (event) => forwarded.push(event),
  });

  forwarder.handle(startedEvent("run-1"));
  forwarder.handle(usageEvent("run-1", 100));
  forwarder.handle(completedEvent("run-1"));

  const deltas = forwarded.filter((e) => e.type === "model.delta");
  assert.equal(deltas.length, 0, "no model.delta forwarded when adapter emits none");
  assert.equal(forwarded.length, 3);
});

test("flushes pending buffer when cap is hit mid-accumulation", () => {
  const clock = makeClock();
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({
    rateLimitMs: 5_000,
    bufferCapBytes: 8,
    onForward: (event) => forwarded.push(event),
    now: clock.now,
  });

  forwarder.handle(deltaEvent("run-1", "ABCD"));
  forwarder.handle(deltaEvent("run-1", "EFGH"));

  const deltas = forwarded.filter((e) => e.type === "model.delta");
  assert.equal(deltas.length, 1, "buffer flushed once when cap is reached");
  assert.equal((deltas[0] as { text: string }).text, "ABCD");
  assert.ok(forwarder.isCapped);
});

test("terminal forwarding closes the forwarder against delayed driver callbacks", () => {
  const clock = makeClock();
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({ rateLimitMs: 100, onForward: (event) => forwarded.push(event), now: clock.now });
  forwarder.handle(startedEvent("run-1"));
  forwarder.handle(deltaEvent("run-1", "trusted buffered text"));
  forwarder.handle(completedEvent("run-1"));
  const terminalEvents = [...forwarded];
  assert.equal(terminalEvents.filter((event) => event.type === "model.delta").length, 1);
  clock.advance(200);
  forwarder.handle(deltaEvent("run-1", "late text"));
  forwarder.handle(usageEvent("run-1", 200));
  assert.deepEqual(forwarded, terminalEvents, "late callbacks must not revive a closed terminal stream");
});

test("closing a nonterminal forwarder cancels its timer and rejects later callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const forwarded: EngineEvent[] = [];
  const forwarder = new DeltaForwarder({ rateLimitMs: 100, onForward: (event) => forwarded.push(event), now: () => 0 });
  forwarder.handle(startedEvent("run-1"));
  forwarder.handle(deltaEvent("run-1", "untrusted buffered text"));
  forwarder.close();
  forwarder.close();
  t.mock.timers.tick(1000);
  forwarder.handle(deltaEvent("run-1", "late callback"));
  forwarder.handle(usageEvent("run-1", 500));
  t.mock.timers.tick(1000);
  assert.deepEqual(forwarded, [startedEvent("run-1")]);
});
