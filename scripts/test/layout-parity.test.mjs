import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-layout-parity.mjs");

function run(mac, win) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-parity-"));
  const macFile = path.join(dir, "mac.json");
  const winFile = path.join(dir, "win.json");
  fs.writeFileSync(macFile, JSON.stringify(mac));
  fs.writeFileSync(winFile, JSON.stringify(win));
  return execFileSync(process.execPath, [checker, macFile, winFile], { encoding: "utf8" });
}

// #194: `settled: true` is part of a well-formed report now, so the factory
// carries it and every passing case below keeps passing. Tests that pin the
// refusal override it, or omit it entirely to stand in for an older report.
const layout = (over = {}) => ({
  leftWidth: 560, leftHeight: 700, rightWidth: 660, rightHeight: 700, bottomDelta: 0,
  viewport: { innerWidth: 1240, innerHeight: 800 },
  settled: true,
  ...over,
});

test("layout parity passes when both platforms agree within thresholds", () => {
  const out = run({ layout: layout() }, { layout: layout({ leftWidth: 562, rightWidth: 658 }) });
  assert.match(out, /"ok":\s*true/);
});

test("layout parity fails when a platform reports a stretched-column mismatch", () => {
  assert.throws(() => run({ layout: layout({ bottomDelta: 40 }) }, { layout: layout() }), /bottom delta/);
});

test("layout parity fails on cross-platform width drift", () => {
  assert.throws(() => run({ layout: layout() }, { layout: layout({ leftWidth: 500 }) }), /left column width/);
});

test("layout parity fails loudly when a report lacks the layout measurement", () => {
  assert.throws(() => run({ layout: null }, { layout: layout() }), /did not render/);
  assert.throws(() => run({ noLayout: true }, { layout: layout() }), /no layout measurement/);
});

// #190: the first run that ever had both reports failed on an 89px height
// difference with identical widths and bottomDelta 0 on both sides -- mac 515px
// vs win 604px. The runners do not hand the app the same window height, so an
// absolute cross-platform height comparison measures the runner. These pin the
// distinction the check now makes.
test("#190 a viewport difference alone passes", () => {
  // Same layout, same chrome overhead (100px), different window height.
  const mac = { layout: layout({ leftHeight: 611, rightHeight: 611, viewport: { innerWidth: 1240, innerHeight: 711 } }) };
  const win = { layout: layout({ leftHeight: 700, rightHeight: 700, viewport: { innerWidth: 1240, innerHeight: 800 } }) };
  const out = run(mac, win);
  assert.match(out, /"ok":\s*true/);
  // And the overhead it compared is reported, so a reader can see what passed.
  assert.match(out, /"chromeOverhead"/);
});

test("#190 the measured cross-platform numbers pass, with identical chrome overhead", () => {
  // Measured, not inferred: job 100718398241 in run 33775936612, the first run
  // in which a viewport was ever recorded. Both runners clamp the requested
  // 1240x800 window -- 1024x681 on macOS, 1024x720 on Windows -- and the app's
  // chrome takes exactly 116px out of each. The absolute column heights differ
  // by 39px, which the old check would have failed on.
  //
  // Note the earlier inference of a 711px macOS viewport and 196px of chrome was
  // wrong in its numbers: it assumed Windows received the full 800. The
  // mechanism (a clamped viewport with constant chrome) held; the arithmetic fit
  // was a coincidence. The macOS viewport also moved between runs (631 implied
  // in #188's, 681 measured here), which is exactly why an absolute height
  // comparison could never be stable.
  const mac = { layout: layout({ leftWidth: 314, rightWidth: 314, leftHeight: 565, rightHeight: 565, viewport: { innerWidth: 1024, innerHeight: 681 } }) };
  const win = { layout: layout({ leftWidth: 314, rightWidth: 314, leftHeight: 604, rightHeight: 604, viewport: { innerWidth: 1024, innerHeight: 720 } }) };
  const out = run(mac, win);
  assert.match(out, /"ok":\s*true/);
  assert.match(out, /"macos":\s*116/);
  assert.match(out, /"windows":\s*116/);
});

test("#190 a column mis-sized against its own viewport still fails", () => {
  // Windows keeps 100px of chrome; macOS loses 189px of the same viewport.
  const mac = { layout: layout({ leftHeight: 522, rightHeight: 522, viewport: { innerWidth: 1240, innerHeight: 711 } }) };
  const win = { layout: layout({ leftHeight: 700, rightHeight: 700, viewport: { innerWidth: 1240, innerHeight: 800 } }) };
  assert.throws(() => run(mac, win), /chrome overhead differs/);
});

test("#190 columns of different heights on one platform fail even when aligned at the bottom", () => {
  // bottomDelta 0 says they end together; it does not say they are the same
  // height, and the old check never asserted that within a platform.
  const mac = { layout: layout({ leftHeight: 700, rightHeight: 640 }) };
  assert.throws(() => run(mac, { layout: layout() }), /columns are different heights/);
});

test("#190 a report without a viewport is refused, not compared", () => {
  const noViewport = { layout: { leftWidth: 560, leftHeight: 700, rightWidth: 660, rightHeight: 700, bottomDelta: 0 } };
  assert.throws(() => run(noViewport, { layout: layout() }), /no usable viewport/);
  assert.throws(
    () => run({ layout: layout({ viewport: { innerWidth: 1240, innerHeight: 0 } }) }, { layout: layout() }),
    /no usable viewport/,
  );
});

test("#190 a column taller than its viewport fails", () => {
  const mac = { layout: layout({ leftHeight: 900, rightHeight: 900, viewport: { innerWidth: 1240, innerHeight: 800 } }) };
  assert.throws(() => run(mac, { layout: layout() }), /taller than its viewport/);
});

// #194: on an identical tree (fbff520 and d89ceb5 share tree 23443b1) the macOS
// column measured 515px in one run and 565px in another, moving that platform's
// chrome overhead from 166px to 116px against Windows' steady 116px. The numbers
// were internally consistent and passed every per-platform check; what differed
// was when the measurement was taken. These pin the refusal that makes the
// renderer's settle gate load-bearing rather than advisory.
test("#194 a measurement that never settled is refused even when its numbers would pass", () => {
  // Every value here is the passing default, so only the settle flag can fail it.
  assert.throws(() => run({ layout: layout({ settled: false }) }, { layout: layout() }), /never settled/);
});

test("#194 a report predating the settle gate is refused, not assumed settled", () => {
  // Exactly what the renderer produced before #194: complete, self-consistent,
  // and silent about when it was sampled.
  const preGate = {
    layout: {
      leftWidth: 560, leftHeight: 700, rightWidth: 660, rightHeight: 700, bottomDelta: 0,
      viewport: { innerWidth: 1240, innerHeight: 800 },
    },
  };
  assert.equal("settled" in preGate.layout, false, "fixture is meant to predate the settle gate");
  assert.throws(() => run(preGate, { layout: layout() }), /never settled/);
});

test("#194 the refusal names the side that did not settle", () => {
  assert.throws(() => run({ layout: layout() }, { layout: layout({ settled: false }) }), /win\.json.*never settled/);
});

test("#194 a report with neither viewport nor settled still reports the viewport", () => {
  // Pins the ordering: the viewport absence is the older and more specific
  // diagnosis, and the noViewport fixture above already relies on it.
  const bare = { layout: { leftWidth: 560, leftHeight: 700, rightWidth: 660, rightHeight: 700, bottomDelta: 0, settled: false } };
  assert.throws(() => run(bare, { layout: layout() }), /no usable viewport/);
});

test("#194 the settle gate does not mask a genuine parity failure", () => {
  // Settled, so the new check passes and the pre-existing threshold must still
  // catch the real defect: a gate that swallowed these would be worse than none.
  assert.throws(
    () => run({ layout: layout({ settled: true, bottomDelta: 40 }) }, { layout: layout() }),
    /bottom delta/,
  );
  assert.throws(
    () => run({ layout: layout({ settled: true, leftHeight: 522, rightHeight: 522, viewport: { innerWidth: 1240, innerHeight: 711 } }) }, { layout: layout() }),
    /chrome overhead differs/,
  );
});
