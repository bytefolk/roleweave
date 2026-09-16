import assert from "node:assert/strict";
import test from "node:test";
import { PerKeyLock } from "../src/per-key-lock.js";

test("same key serializes concurrent operations", async () => {
  const lock = new PerKeyLock();
  const order: number[] = [];

  const first = lock.run("a", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(1);
    return "first";
  });

  const second = lock.run("a", async () => {
    order.push(2);
    return "second";
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, "first");
  assert.equal(secondResult, "second");
  assert.deepEqual(order, [1, 2]);
});

test("different keys run in parallel", async () => {
  const lock = new PerKeyLock();
  let firstStarted = false;

  const first = lock.run("a", async () => {
    firstStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "first";
  });

  const second = lock.run("b", async () => {
    assert.ok(firstStarted, "second should start while first is still running");
    return "second";
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, "first");
  assert.equal(secondResult, "second");
});

test("rejection does not block subsequent operations on the same key", async () => {
  const lock = new PerKeyLock();

  await assert.rejects(
    lock.run("a", async () => { throw new Error("boom"); }),
    { message: "boom" },
  );

  const result = await lock.run("a", async () => "recovered");
  assert.equal(result, "recovered");
});

test("settled entries are cleaned up from the internal map", async () => {
  const lock = new PerKeyLock();

  await lock.run("a", async () => "done");

  // @ts-expect-error accessing private field for test assertion
  assert.equal(lock.pending.size, 0);
});

test("settled entries are cleaned up after rejection", async () => {
  const lock = new PerKeyLock();

  await assert.rejects(lock.run("a", async () => { throw new Error("fail"); }));

  // @ts-expect-error accessing private field for test assertion
  assert.equal(lock.pending.size, 0);
});
