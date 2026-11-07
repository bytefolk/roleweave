import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { VaultSyncEntry } from '@roleweave/shared';
import { planVaultSync } from '../src/vault/sync-plan.js';
import { referencedVaultAssetPaths } from '../src/vault/attachments.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const entry = (noteId: string, notePath: string, content: string, properties?: Record<string, unknown>): VaultSyncEntry =>
  ({ noteId, path: notePath, content, ...(properties ? { properties } : {}) });
const live = (entries: readonly VaultSyncEntry[]) => entries.filter(note => !note.deleted);

test('lost commit response or pending baseline does not create another local conflict copy on retry', () => {
  const base = [entry(A, '项目/方案.md', '共同基线')];
  const local = [entry(A, '项目/方案.md', '本地修改', { archived: false, tags: ['共同资料'] })];
  const remote = [entry(A, '项目/方案.md', '远端修改')];
  const first = planVaultSync(base, local, remote);
  const originalCopy = live(first.entries).find(note => note.noteId !== A && note.content === '本地修改');
  assert.ok(originalCopy, 'the first conflict must preserve the local version');

  // The server persisted the first plan, but its response or the pending-state
  // write was lost. The client therefore still has its old baseline/local head.
  // Property key order can also differ after a JSON round trip.
  const retryLocal = [entry(A, '项目/方案.md', '本地修改', { tags: ['共同资料'], archived: false })];
  const retry = planVaultSync(base, retryLocal, first.entries);
  assert.equal(retry.changes.length, 0, 'retry must not push another copy or rename the existing one');
  assert.deepEqual(live(retry.entries).filter(note => note.content === '本地修改').map(note => note.noteId), [originalCopy.noteId]);
  assert.equal(retry.entries.find(note => note.noteId === originalCopy.noteId)?.path, originalCopy.path);
  assert.equal(retry.entries.find(note => note.noteId === A)?.content, '远端修改');
});

function assertBoundedCopy(notePath: string): void {
  assert.ok(Buffer.byteLength(notePath, 'utf8') <= 512, 'the fixture starts within the public path budget');
  const base = [entry(A, notePath, '共同基线')];
  const result = planVaultSync(base, [entry(A, notePath, '本地内容')], [entry(A, notePath, '远端内容')]);
  const copy = live(result.entries).find(note => note.noteId !== A && note.content === '本地内容');
  assert.ok(copy, 'both versions must remain available');
  assert.notEqual(copy.path, notePath);
  assert.ok(Buffer.byteLength(copy.path, 'utf8') <= 512, 'conflict paths must fit the Vault API path budget');
  assert.ok(Buffer.byteLength(path.posix.basename(copy.path), 'utf8') <= 255, 'the copied filename must fit a filesystem component');
  assert.equal(Buffer.from(copy.path, 'utf8').toString('utf8'), copy.path, 'truncation must retain complete Unicode characters');
  assert.equal(copy.path.includes('\uFFFD'), false);
  assert.equal(path.posix.extname(copy.path), '.md');
  assert.equal(result.entries.find(note => note.noteId === A)?.content, '远端内容');
}

test('conflict copy bounds a long Chinese basename without splitting UTF-8 characters', () => {
  // Each component is valid: 120-byte directory, 120-byte directory, and a
  // 255-byte filename. Adding the conflict suffix used to exceed that filename.
  assertBoundedCopy(`${'资'.repeat(40)}/${'料'.repeat(40)}/${'项'.repeat(84)}.md`);
});

test('conflict copy remains within the path budget when the original directory leaves no suffix space', () => {
  // The original is 506 bytes with two independently valid 249-byte directory
  // components. A conflict must relocate or shorten it rather than fail to sync.
  assertBoundedCopy(`${'资'.repeat(83)}/${'料'.repeat(83)}/笔.md`);
});

test('a local rename collision keeps the remote path owner and the renamed note logical identity', () => {
  const previousA = entry(A, '旧方案.md', '笔记 A');
  const renamedA = entry(A, '共同方案.md', '笔记 A');
  const remoteB = entry(B, '共同方案.md', '笔记 B');
  const merged = planVaultSync([previousA], [renamedA], [previousA, remoteB]);
  const active = live(merged.entries);
  const keptA = active.find(note => note.noteId === A);
  const keptB = active.find(note => note.noteId === B);
  assert.ok(keptA, 'a path collision must not tombstone A or replace its logical ID');
  assert.ok(keptB, 'the existing remote owner B must not be deleted');
  assert.equal(keptB.path, remoteB.path);
  assert.equal(keptB.content, remoteB.content);
  assert.equal(keptA.content, renamedA.content);
  assert.notEqual(keptA.path.normalize('NFC').toLowerCase(), remoteB.path.normalize('NFC').toLowerCase());
  assert.equal(active.length, 2, 'the rename is one logical note, not a new third note');
  assert.equal(merged.changes.some(note => note.noteId === B), false, 'B is already current and should receive no update');

  // Bindings live outside the remote properties and refer to logical IDs.
  // The local apply keeps an existing binding only while that ID remains live.
  const binding = [A];
  const activeIds = new Set(active.map(note => note.noteId));
  assert.deepEqual(binding.filter(id => activeIds.has(id)), binding);
});

test('a lost commit response after a rename path collision also retries without duplicating the logical note', () => {
  const previousA = entry(A, '旧方案.md', '笔记 A');
  const renamedA = entry(A, '共同方案.md', '笔记 A');
  const remoteB = entry(B, '共同方案.md', '笔记 B');
  const committed = planVaultSync([previousA], [renamedA], [previousA, remoteB]);

  const retry = planVaultSync([previousA], [renamedA], committed.entries);
  assert.equal(retry.changes.length, 0, 'the collision was already committed despite the missing response');
  assert.deepEqual(live(retry.entries).map(note => note.noteId).sort(), [A, B]);
  assert.equal(retry.entries.find(note => note.noteId === A)?.path, committed.entries.find(note => note.noteId === A)?.path);
  assert.equal(retry.entries.find(note => note.noteId === B)?.path, remoteB.path);
});

test('fallback conflict copy keeps image and file targets, including when its commit response is lost', () => {
  const notePath = `${'资'.repeat(83)}/${'料'.repeat(83)}/笔.md`;
  const imagePath = `assets/${'a'.repeat(64)}.png`;
  const filePath = `assets/${'b'.repeat(64)}.pdf`;
  const links = [
    `![图](../../${imagePath})`,
    `[资料](<../../${filePath}> "说明")`,
    `![[${imagePath}|200]]`,
  ].join('\n');
  const properties = { assets: [
    { path: imagePath, fileId: B, mime: 'image/png', sha256: 'a'.repeat(64) },
    { path: filePath, fileId: '33333333-3333-4333-8333-333333333333', mime: 'application/pdf', sha256: 'b'.repeat(64) },
  ] };
  const base = [entry(A, notePath, `基线\n${links}`, properties)];
  const local = [entry(A, notePath, `本地\n${links}`, properties)];
  const remote = [entry(A, notePath, `远端\n${links}`, properties)];
  const committed = planVaultSync(base, local, remote);
  const copy = live(committed.entries).find(note => note.noteId !== A);
  assert.ok(copy);
  assert.notEqual(path.posix.dirname(copy.path), path.posix.dirname(notePath), 'the fixture must exercise a directory relocation');
  const expectedTargets = [imagePath, filePath].sort();
  assert.deepEqual(referencedVaultAssetPaths(local[0]!).sort(), expectedTargets);
  assert.deepEqual(referencedVaultAssetPaths(copy).sort(), expectedTargets, 'a renamed copy must still resolve to the same verified assets');
  assert.ok(copy.content.includes(`![[${imagePath}|200]]`), 'wiki references remain rooted at the Vault');
  assert.equal(local[0]!.content, `本地\n${links}`, 'planning must not rewrite its captured pre-image');
  assert.ok(Buffer.byteLength(copy.path, 'utf8') <= 512);
  assert.ok(Buffer.byteLength(path.posix.basename(copy.path), 'utf8') <= 255);

  const retry = planVaultSync(base, local, committed.entries);
  assert.equal(retry.changes.length, 0, 'the relocated conflict copy must be reused after a lost response');
  assert.equal(live(retry.entries).length, 2);
  const sameCopy = retry.entries.find(note => note.noteId === copy.noteId);
  assert.ok(sameCopy);
  assert.equal(sameCopy.path, copy.path);
  assert.deepEqual(referencedVaultAssetPaths(sameCopy).sort(), expectedTargets);
});
