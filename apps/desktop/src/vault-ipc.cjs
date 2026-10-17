const { isTrustedWindowSender } = require('./window-ipc.cjs');
const { isPositionId } = require('@roleweave/shared/position-id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^sha256:[0-9a-f]{64}$/;
const invalid = () => ({ ok: false, response: { status: 400, body: { code: 'vault_request_invalid', message: 'Invalid notebook request', retryable: false } } });
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const boundedPath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
const role = isPositionId;
const note = value => typeof value === 'string' && UUID.test(value);
function source(value) {
  return value === undefined || (object(value, ['positionId', 'sessionId', 'turnId']) &&
    (value.positionId === undefined || role(value.positionId)) &&
    (value.sessionId === undefined || note(value.sessionId)) &&
    (value.turnId === undefined || (typeof value.turnId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value.turnId))));
}
function validateVaultRequest(action, raw) {
  if (action === 'used') {
    if (!object(raw, ['positionId', 'turnId']) || !role(raw.positionId) || typeof raw.turnId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(raw.turnId)) return invalid();
    return {ok:true,pathname:'/vault/used?'+new URLSearchParams(raw).toString()};
  }
  if (action === 'source' || action === 'targets') return { ok: true, pathname: action === 'source' ? '/vault/source' : '/vault/sync/targets' };
  if (action === 'list') {
    const value = raw ?? {};
    if (!object(value, ['q', 'positionId', 'archived', 'includeLegacy']) ||
      (value.q !== undefined && (typeof value.q !== 'string' || value.q.length > 256)) ||
      (value.positionId !== undefined && !role(value.positionId)) ||
      ['archived', 'includeLegacy'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean')) return invalid();
    const query = new URLSearchParams();
    for (const [key, val] of Object.entries(value)) if (val !== undefined) query.set(key, String(val));
    return { ok: true, pathname: '/vault/list' + (query.size ? '?' + query.toString() : '') };
  }
  if (action === 'read') return note(raw) ? { ok: true, pathname: '/vault/read?noteId=' + raw } : invalid();
  if (action === 'image') {
    if (!object(raw, ['path', 'notePath']) || !boundedPath(raw.path) || (raw.notePath !== undefined && !boundedPath(raw.notePath))) return invalid();
    return { ok: true, pathname: '/vault/image?' + new URLSearchParams(raw).toString() };
  }
  if (action === 'bindings') return raw === undefined || role(raw) ? { ok: true, pathname: '/vault/bindings' + (raw ? '?positionId=' + encodeURIComponent(raw) : '') } : invalid();
  let keys, method = 'POST', pathname = '/vault/' + action;
  if (action === 'create') keys = ['path', 'content', 'positionIds', 'source'];
  else if (action === 'write') { keys = ['noteId', 'content', 'expectedVersion']; method = 'PUT'; }
  else if (action === 'rename' || action === 'migrate') keys = ['noteId', 'path', 'expectedVersion'];
  else if (['archive', 'restore', 'delete'].includes(action)) { keys = ['noteId', 'expectedVersion']; if (action === 'delete') method = 'DELETE'; }
  else if (action === 'bind') { keys = ['positionId', 'noteIds']; method = 'PUT'; pathname = '/vault/bindings'; }
  else if (action === 'sync') { keys = ['vaultId']; pathname = '/vault/sync'; raw ??= {}; }
  else if (action === 'attach') keys = ['fileId'];
  else if (action === 'fromTurn') { keys = ['positionId', 'turnId', 'path', 'content']; pathname = '/vault/from-turn'; }
  else if (action === 'context') { keys = ['positionId', 'q']; pathname = '/vault/context'; }
  else if (action === 'history') { if (!note(raw)) return invalid(); return { ok: true, pathname: '/vault/history?noteId=' + raw }; }
  else return invalid();
  if (!object(raw, keys)) return invalid();
  if (keys.includes('noteId') && !note(raw.noteId)) return invalid();
  if (keys.includes('fileId') && !note(raw.fileId)) return invalid();
  if (keys.includes('path') && !boundedPath(raw.path)) return invalid();
  if (keys.includes('positionId') && !role(raw.positionId)) return invalid();
  if (action === 'fromTurn' && (typeof raw.turnId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(raw.turnId))) return invalid();
  if (keys.includes('content') && !(action === 'fromTurn' && raw.content === undefined) && (typeof raw.content !== 'string' || Buffer.byteLength(raw.content, 'utf8') > 1024 * 1024)) return invalid();
  if (raw.expectedVersion !== undefined && (typeof raw.expectedVersion !== 'string' || !VERSION.test(raw.expectedVersion))) return invalid();
  if ((action === 'write' || action === 'migrate') && raw.expectedVersion === undefined) return invalid();
  if (raw.positionIds !== undefined && (!Array.isArray(raw.positionIds) || raw.positionIds.length > 64 || !raw.positionIds.every(role))) return invalid();
  if (!source(raw.source)) return invalid();
  if (action === 'bind' && (!Array.isArray(raw.noteIds) || raw.noteIds.length > 1000 || !raw.noteIds.every(note))) return invalid();
  if (action === 'sync' && raw.vaultId !== undefined && !note(raw.vaultId)) return invalid();
  if (action === 'context' && raw.q !== undefined && (typeof raw.q !== 'string' || raw.q.length > 256)) return invalid();
  return { ok: true, pathname, options: { method, body: raw } };
}
function registerVaultIpc({ ipcMain, getMainWindow, getTrustedRendererUrl, apiRequest }) {
  for (const action of ['list', 'read', 'create', 'write', 'rename', 'archive', 'restore', 'delete', 'migrate', 'bindings', 'bind', 'source', 'resolve', 'image', 'attach', 'fromTurn', 'sync', 'targets', 'context', 'history', 'used']) {
    ipcMain.handle('owb:vault:' + action, async (event, raw) => {
      if (!isTrustedWindowSender(event, getMainWindow(), getTrustedRendererUrl())) return { status: 403, body: { code: 'vault_request_invalid', message: 'Untrusted sender', retryable: false } };
      if (action === 'resolve') {
        if (!object(raw, ['uri']) || typeof raw.uri !== 'string' || raw.uri.length > 2048) return invalid().response;
        return apiRequest('/vault/resolve', { method: 'POST', body: raw });
      }
      const parsed = validateVaultRequest(action, raw);
      return parsed.ok ? apiRequest(parsed.pathname, parsed.options) : parsed.response;
    });
  }
}
module.exports = { validateVaultRequest, registerVaultIpc };
