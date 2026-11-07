const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateDrivePreviewRequest, authorizeDrivePreviewSender, authorizeDriveReadSender } = require("../src/drive-ipc.cjs");

test("preview encodes the object id into its sole allowed route", () => {
  assert.deepEqual(validateDrivePreviewRequest("aa08645f-1b34-47ac-bbe5-fcba0d4a6745"), {
    ok: true, pathname: "/drive/preview?id=aa08645f-1b34-47ac-bbe5-fcba0d4a6745",
  });
  for (const id of [undefined, null, {}, 10, "", "a".repeat(129), "a\n", "a b", "\u0000", "\ud800", "image?x=1&token=bad", "https://other.example/image", "../image"]) {
    const result = validateDrivePreviewRequest(id);
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 400);
  }
});

test("preview is restricted to the app's own current top-level frame", () => {
  const url = "file:///roleweave/dist/renderer/index.html";
  const frame = { url };
  const window = { webContents: { mainFrame: frame } };
  assert.equal(authorizeDrivePreviewSender({ senderFrame: frame }, window, url).ok, true);
  for (const event of [null, {}, { senderFrame: { url } }, { senderFrame: { url: "http://mem.local/" } }]) {
    assert.equal(authorizeDrivePreviewSender(event, window, url).response.status, 403);
  }
  frame.url = "https://other.example/";
  assert.equal(authorizeDrivePreviewSender({ senderFrame: frame }, window, url).response.status, 403);
  assert.equal(authorizeDrivePreviewSender({ senderFrame: frame }, null, url).response.status, 403);
});

test("provider and preview use only enumerated readonly channels in the actual preload", async () => {
  let bridge;
  const calls = [];
  const response = { status: 200, body: { schemaVersion: "drive-provider.v1", status: { schemaVersion: "drive-provider.v1", kind: "bdpan", state: "ready" } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8"), {
    process: { platform: "win32" },
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "owb"); bridge = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(response); } },
      };
    },
  });
  const result = await bridge.drive.provider({ provider: "mem", url: "https://other.example/" });
  assert.equal(result.body.status.kind, "bdpan", "the renderer must display the server-selected provider");
  assert.equal(calls[0][0], "owb:drive:provider");
  assert.equal(calls[0].length, 1, "provider accepts no mutation or remote-path argument");
  await bridge.drive.preview("preview-image");
  assert.equal(calls[1][0], "owb:drive:preview");
  assert.equal(calls[1][1], "preview-image");
  assert.equal(bridge.drive.setProvider, undefined);
  assert.equal(authorizeDriveReadSender, authorizeDrivePreviewSender, "both reads retain the same main-frame trust boundary");
});
