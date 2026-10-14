const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { readPickedFile, registerDriveUploadIpc } = require("../src/drive-upload.cjs");

function harness({ picked = { canceled: true, filePaths: [] }, apiRequest, readFile } = {}) {
  const handlers = new Map(); const calls = []; let pickCount = 0;
  const frame = { url: "file:///roleweave/index.html" };
  const window = { webContents: { mainFrame: frame } };
  registerDriveUploadIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => { pickCount++; return typeof picked === "function" ? picked() : picked; } },
    getMainWindow: () => window, getTrustedRendererUrl: () => "file:///roleweave/index.html", readFile,
    apiRequest: apiRequest ?? (async (...args) => { calls.push(args); return { status: 200, body: { status: { kind: "mem", state: "ready" } } }; }),
  });
  return { handlers, calls, frame, event: { senderFrame: frame }, pickCount: () => pickCount };
}

test("upload channels require the current trusted main frame and never read renderer-provided paths", async () => {
  let reads = 0; const h = harness({ readFile: async () => { reads++; } });
  for (const name of ["owb:drive:upload", "owb:drive:pick-and-upload"]) {
    assert.equal((await h.handlers.get(name)({ senderFrame: { url: h.frame.url } }, "/private/file")).status, 403);
  }
  assert.equal((await h.handlers.get("owb:drive:upload")(h.event, "/private/file")).status, 501);
  assert.equal(reads, 0); assert.equal(h.pickCount(), 0); assert.equal(h.calls.length, 0);
});

test("picker cancellation has no file read or upload, and navigating away during a picker prevents reading", async () => {
  let reads = 0;
  const h = harness({ readFile: async () => { reads++; } });
  assert.deepEqual(await h.handlers.get("owb:drive:pick-and-upload")(h.event), { canceled: true });
  assert.equal(reads, 0); assert.equal(h.calls.length, 1);
  const moved = harness({ readFile: async () => { reads++; }, picked: () => { moved.frame.url = "https://other.example"; return { canceled: false, filePaths: ["/private/file"] }; } });
  assert.equal((await moved.handlers.get("owb:drive:pick-and-upload")(moved.event)).status, 403);
  assert.equal(reads, 0);
});

test("unsupported and disconnected providers fail before opening the picker", async () => {
  for (const [kind, state, expected] of [["bdpan", "ready", 501], ["mem", "not_connected", 503]]) {
    const h = harness({ apiRequest: async () => ({ status: 200, body: { status: { kind, state } } }) });
    assert.equal((await h.handlers.get("owb:drive:pick-and-upload")(h.event)).status, expected);
    assert.equal(h.pickCount(), 0);
  }
});

test("OS-picked file reading is bounded and rejects directories, symlinks, missing and oversized files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drive-picker-"));
  try {
    const selected = path.join(root, "素材.png"); const bytes = Buffer.from([0, 255, 128, 2]); await fs.writeFile(selected, bytes);
    const read = await readPickedFile(selected); assert.deepEqual(read.bytes, bytes); assert.equal(read.name, "素材.png"); assert.equal(read.mime, "image/png");
    for (const candidate of [root, path.join(root, "absent"), "relative.png"]) await assert.rejects(readPickedFile(candidate), error => error.status === 400 && !JSON.stringify(error).includes(root));
    if (process.platform !== "win32") { const link = path.join(root, "link.png"); await fs.symlink(selected, link); await assert.rejects(readPickedFile(link), error => error.status === 400); }
    const big = path.join(root, "big.bin"); const fd = await fs.open(big, "w"); await fd.truncate(32 * 1024 * 1024 + 1); await fd.close();
    await assert.rejects(readPickedFile(big), error => error.status === 413);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the real desktop HTTP proxy transmits picker bytes and UTF-8 filename without a local path across the WSL boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drive-upload-"));
  const bytes = Buffer.alloc(1024 * 1024 + 9, 0x80); bytes[0] = 0; bytes[1] = 255;
  const file = path.join(root, "素材.png"); await fs.writeFile(file, bytes);
  let received;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/drive/provider") { res.end(JSON.stringify({ status: { kind: "mem", state: "ready" } })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) };
    res.writeHead(201); res.end(JSON.stringify({ schemaVersion: "drive-object-upload.v1", object: { id: "uploaded" }, deduped: false }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = await fs.readFile(path.join(__dirname, "../src/main.js"), "utf8");
    const start = source.indexOf("function apiRequest("); const end = source.indexOf("\nfunction startEventStream", start);
    assert.ok(start !== -1 && end !== -1);
    const apiRequest = vm.runInNewContext(source.slice(start, end) + "\napiRequest;", { http, Buffer, setTimeout, clearTimeout, controlPlane: { port: server.address().port, token: "boot-fixture" } });
    const h = harness({ apiRequest, picked: { canceled: false, filePaths: [file] } });
    assert.equal((await h.handlers.get("owb:drive:pick-and-upload")(h.event)).status, 201);
    assert.deepEqual(received.bytes, bytes);
    assert.equal(new URL(received.url, "http://local").searchParams.get("name"), "素材.png");
    assert.equal(received.headers["content-type"], "application/octet-stream");
    assert.equal(received.headers.authorization, "Bearer boot-fixture");
    assert.ok(!received.url.includes(root));
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test("the desktop binary proxy rejects interrupted, oversized and slow upload replies", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/main.js"), "utf8");
  const start = source.indexOf("function apiRequest("); const end = source.indexOf("\nfunction startEventStream", start);
  for (const mode of ["interrupted", "oversized", "slow"]) {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(201);
      res.write(mode === "oversized" ? "x".repeat(129 * 1024) : "{");
      if (mode === "interrupted") setTimeout(() => res.destroy(), 5);
      else if (mode === "oversized") res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const apiRequest = vm.runInNewContext(source.slice(start, end) + "\napiRequest;", { http, Buffer, setTimeout, clearTimeout, controlPlane: { port: server.address().port, token: "boot-fixture" } });
      await assert.rejects(apiRequest("/drive/upload?name=asset&mime=text%2Fplain", { method: "POST", binaryBody: Buffer.from("x"), timeoutMs: 100 }));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

test("parallel picker requests are rejected and transport errors never expose private diagnostics", async () => {
  let release; const picked = new Promise(resolve => { release = resolve; });
  const h = harness({ picked: () => picked });
  const first = h.handlers.get("owb:drive:pick-and-upload")(h.event);
  assert.equal((await h.handlers.get("owb:drive:pick-and-upload")(h.event)).status, 409);
  release({ canceled: true, filePaths: [] }); await first;
  const failed = harness({ apiRequest: async () => { throw Error("secret /private/path"); } });
  const result = await failed.handlers.get("owb:drive:pick-and-upload")(failed.event);
  assert.equal(result.status, 502); assert.doesNotMatch(JSON.stringify(result), /secret|private\/path/);
});
