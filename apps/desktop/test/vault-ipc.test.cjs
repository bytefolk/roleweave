const assert = require('node:assert/strict');
const test = require('node:test');
const { validateVaultRequest, registerVaultIpc } = require('../src/vault-ipc.cjs');
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
test('notebook bridge bounds inputs and only builds owned routes', () => {
  assert.equal(validateVaultRequest('read', id).pathname, '/vault/read?noteId=' + id);
  assert.equal(validateVaultRequest('read', 'https://evil.example/').ok, false);
  assert.equal(validateVaultRequest('list', { q: '产品 说明' }).ok, true);
  assert.equal(validateVaultRequest('list', { q: 'a'.repeat(257) }).ok, false);
  assert.equal(validateVaultRequest('create', { path: '项目/新笔记.md', content: '' }).ok, true);
  assert.equal(validateVaultRequest('create', { path: 'a.md', content: 'x'.repeat(1024 * 1024 + 1) }).ok, false);
  assert.equal(validateVaultRequest('write', { noteId: id, content: 'x' }).ok, false);
  assert.equal(validateVaultRequest('write', { noteId: id, content: 'x', expectedVersion: 'sha256:' + 'a'.repeat(64) }).ok, true);
  assert.equal(validateVaultRequest('create', { path: 'a.md', content: '', token: 'no' }).ok, false);
});
test('all notebook IPC methods reject foreign frames before contacting the API', async () => {
  const handlers = new Map(), calls = [];
  const frame = {url:'file:///roleweave/index.html'}, window = {webContents:{mainFrame:frame}};
  registerVaultIpc({ipcMain:{handle:(name, fn)=>handlers.set(name,fn)}, getMainWindow:()=>window, getTrustedRendererUrl:()=>frame.url,
    apiRequest:async (...args)=>{calls.push(args);return {status:200,body:{}};}});
  for (const fn of handlers.values()) assert.equal((await fn({senderFrame:{url:frame.url}}, {})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await handlers.get('owb:vault:read')({senderFrame:frame},id)).status,200);
  assert.deepEqual(calls[0],['/vault/read?noteId='+id,undefined]);
});
