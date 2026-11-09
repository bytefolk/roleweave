const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
function loadFunction(name, next, globals) {
  return vm.runInNewContext(`${source.slice(source.indexOf(`function ${name}(`), source.indexOf(next))}\n${name}`, globals);
}
function streamingHttp(payload, cut) {
  return { request(_options, callback) {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const response = new PassThrough(); response.statusCode = 200;
      callback(response);
      response.write(payload.subarray(0, cut));
      setImmediate(() => response.end(payload.subarray(cut)));
    };
    return request;
  } };
}

test('desktop API keeps Chinese and emoji intact across every UTF-8 byte boundary', async () => {
  const expected = { output: '任务完成需验收证据 🧪' };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (let cut = 1; cut < bytes.length; cut++) {
    const api = loadFunction('apiRequest', 'function startEventStream(', {
      Buffer, controlPlane: { port: 1, token: 'fixture' }, http: streamingHttp(bytes, cut),
    });
    const result = await api('/turns');
    assert.equal(result.status, 200);
    assert.equal(result.body.output, expected.output, `split at byte ${cut}`);
  }
});

test('desktop SSE keeps Chinese progress intact across UTF-8 byte boundaries', async () => {
  const expected = { type: 'turn.progress', text: '正在验收 🧪' };
  const bytes = Buffer.from(`data: ${JSON.stringify(expected)}\n\n`);
  for (let cut = 1; cut < bytes.length; cut++) {
    const messages = [];
    const start = loadFunction('startEventStream', 'function broadcastSseStatus(', {
      controlPlane: { port: 1, token: 'fixture' }, eventStreamRequest: null,
      statusTray: null, http: streamingHttp(bytes, cut),
      broadcastSseStatus() {},
      mainWindow: { isDestroyed: () => false, webContents: { send: (_channel, event) => messages.push(event) } },
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
    });
    start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages[0]?.text, expected.text, `split at byte ${cut}`);
  }
});
