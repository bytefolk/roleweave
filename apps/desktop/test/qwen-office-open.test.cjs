const assert = require("node:assert/strict");
const test = require("node:test");
const { openQwenOffice } = require("../src/qwen-office-open.cjs");

test("Office launch uses only the registered client protocol", async () => {
  const opened = [];
  const result = await openQwenOffice({ platform: "win32", event: { url: "https://untrusted.test" },
    isTrusted: () => true, openExternal: async url => { opened.push(url); } });
  assert.deepEqual(result, { opened: true });
  assert.deepEqual(opened, ["qwenwork-cn://"]);
});

test("untrusted senders and unsupported platforms cannot launch Office", async () => {
  for (const [trusted, platform, reason] of [[false, "win32", "untrusted_sender"], [true, "linux", "platform_unavailable"]]) {
    assert.deepEqual(await openQwenOffice({ platform, isTrusted: () => trusted,
      openExternal: () => assert.fail("must not launch") }), { opened: false, reason });
  }
});

test("missing client registration returns a bounded failure without native diagnostics", async () => {
  assert.deepEqual(await openQwenOffice({ platform: "win32", isTrusted: () => true,
    openExternal: async () => { throw Error("private installation details"); } }),
  { opened: false, reason: "client_unavailable" });
});
