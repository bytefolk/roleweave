import assert from 'node:assert/strict';
import test from 'node:test';
import { planVaultSync } from '../src/vault/sync-plan.js';
const entry = (noteId: string, path: string, content: string) => ({ noteId, path, content });
test('vault merge preserves independent empty notes and converges unchanged content', () => {
  const a = entry('a', '空白一.md', ''), b = entry('b', '空白二.md', '');
  assert.equal(planVaultSync([], [a, b], []).changes.length, 2);
  assert.equal(planVaultSync([a], [a], [a]).changes.length, 0);
});
test('vault merge takes unilateral edits and carries deletions without overwriting another edit', () => {
  const base = entry('a', '笔记.md', 'old');
  assert.equal(planVaultSync([base], [entry('a', base.path, 'local')], [base]).changes[0]?.content, 'local');
  const pull = planVaultSync([base], [base], [entry('a', base.path, 'remote')]);
  assert.equal(pull.entries[0]?.content, 'remote');
  assert.equal(pull.changes.length, 0);
  const removed = planVaultSync([base], [], [base]);
  assert.equal(removed.changes[0]?.deleted, true);
  const collision = planVaultSync([base], [], [entry('a', base.path, 'remote')]);
  assert.equal(collision.entries[0]?.content, 'remote');
  assert.equal(collision.conflicts.length, 1);
});
test('vault merge retains both concurrent edits and stable distinct identities', () => {
  const base = entry('a', '项目/方案.md', 'old');
  const plan = planVaultSync([base], [entry('a', base.path, 'local')], [entry('a', base.path, 'remote')], () => 'new-note');
  assert.equal(plan.entries.find(e => e.noteId === 'a')?.content, 'remote');
  assert.equal(plan.entries.find(e => e.noteId === 'new-note')?.content, 'local');
  assert.equal(plan.conflicts[0]?.copyPath, '项目/方案 (conflict new-note).md');
});
test('different notes colliding on a case-insensitive path become two files', () => {
  const plan = planVaultSync([], [entry('a', '计划.md', 'one')], [entry('b', '计划.md', 'two')], () => 'copy-note');
  assert.equal(plan.entries.filter(e => !e.deleted).length, 2);
  assert.equal(plan.entries.find(e => e.noteId === 'b')?.content, 'two');
  assert.equal(plan.conflicts.length, 1);
});
test('retry after remote commit but failed local apply preserves both committed versions', () => {
  const localBefore = entry('a', '方案.md', 'local');
  const committed = [entry('a', '方案.md', 'remote'), entry('copy-note', '方案 (conflict).md', 'local')];
  const retry = planVaultSync([localBefore], [localBefore], committed);
  assert.equal(retry.changes.length, 0);
  assert.equal(retry.entries.find(e => e.noteId === 'a')?.content, 'remote');
  assert.equal(retry.entries.find(e => e.noteId === 'copy-note')?.content, 'local');
});
