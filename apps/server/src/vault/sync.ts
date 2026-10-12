import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrgApiError, errorCodes } from '@roleweave/shared';
import type { VaultRemoteSnapshot, VaultSyncEntry, VaultSyncReceipt, VaultSyncTarget, LocalVaultSnapshot } from '@roleweave/shared';
import type { OpenWorkspace } from '../workspace-state.js';
import type { ControlPlaneContext } from '../context.js';
import { normalizeServiceUrl, resolveServiceConnection, type ServiceConnection } from '../services/connections.js';
import { applyLocalVaultSnapshot, exportLocalVaultSnapshot, validateVaultPath } from './store.js';
import { entryValue, planVaultSync } from './sync-plan.js';
import { prepareVaultAttachments, hydrateVaultAttachments, normalizeVaultAssetReferences } from './attachments.js';
import { readVaultFile } from './file-read.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WIRE = 40 * 1024 * 1024;
const active = new Map<string, Promise<VaultSyncReceipt>>();
interface State { schemaVersion: 'vault-sync-state.v1'; connection: string; remoteVaultId: string; snapshot: VaultRemoteSnapshot; pending?: boolean }
function failure(code: string, status = 502): never { throw new OrgApiError(code, status, 'Notebook synchronization did not complete; local notes are retained', true); }
function canonicalVaultId(value: unknown, code: string = errorCodes.vault_request_invalid, status = 400): string {
  if (typeof value !== 'string' || !UUID.test(value)) failure(code, status);
  // Decode the identity, then serialize its 16 bytes. Persisted state never
  // supplies arbitrary URL/query bytes or an opaque object to the request.
  const hex = Buffer.from(value.replaceAll('-', ''), 'hex').toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function withoutBindings(entries: readonly VaultSyncEntry[]): VaultSyncEntry[] { return entries.map(entry => { const properties = { ...(entry.properties ?? {}) }; delete properties.positionIds; return { ...entry, properties }; }); }
async function privateDirectory(workspace: OpenWorkspace): Promise<string> {
  let current = path.resolve(workspace.dir);
  for (const segment of ['.roleweave', 'vault']) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, {mode:0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) failure(errorCodes.vault_path_forbidden, 403);
  }
  return current;
}
async function loadState(workspace: OpenWorkspace): Promise<State | null> {
  const file = path.join(await privateDirectory(workspace), 'sync-state.json');
  try {
    const failed = () => new OrgApiError(errorCodes.vault_storage_failed, 500, 'Notebook synchronization state could not be verified');
    const value = JSON.parse((await readVaultFile(workspace.dir, file, MAX_WIRE, {unsafe: failed, changed: failed, limit: failed})).toString('utf8')) as State;
    if (!value || value.schemaVersion !== 'vault-sync-state.v1' || typeof value.connection !== 'string') failure(errorCodes.vault_storage_failed, 500);
    const remoteVaultId = canonicalVaultId(value.remoteVaultId, errorCodes.vault_storage_failed, 500);
    // Keep the previous snapshot's original identity casing for validation;
    // network requests use only the reconstructed canonical UUID.
    snapshot(value.snapshot, value.remoteVaultId);
    return { schemaVersion: 'vault-sync-state.v1', connection: value.connection, remoteVaultId, snapshot: value.snapshot, ...(value.pending === true ? {pending: true} : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function saveState(workspace: OpenWorkspace, state: State): Promise<void> {
  const directory = await privateDirectory(workspace), temp = path.join(directory, '.sync-' + crypto.randomUUID() + '.tmp');
  const text = JSON.stringify(state); if (Buffer.byteLength(text) > MAX_WIRE) failure(errorCodes.vault_limit_exceeded, 413);
  try { await fs.writeFile(temp, text, {flag:'wx',mode:0o600}); await fs.rename(temp, path.join(directory,'sync-state.json')); }
  finally { await fs.unlink(temp).catch(()=>{}); }
}
function snapshot(value: unknown, vaultId: string): VaultRemoteSnapshot {
  const result = value as VaultRemoteSnapshot;
  if (!result || result.schemaVersion !== 'vault-snapshot.v1' || result.vaultId !== vaultId || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.entries) || result.entries.length > 1000) failure(errorCodes.vault_storage_failed);
  const ids = new Set<string>(), paths = new Set<string>(); let total = 0;
  for (const entry of result.entries) {
    if (!UUID.test(entry.noteId) || ids.has(entry.noteId) || typeof entry.content !== 'string' || typeof entry.deleted !== 'boolean' || Buffer.byteLength(entry.content) > 1024*1024 || (entry.deleted && entry.content !== '')) failure(errorCodes.vault_storage_failed);
    ids.add(entry.noteId); validateVaultPath(entry.path);
    if (entry.properties !== undefined && (!entry.properties || typeof entry.properties !== 'object' || Array.isArray(entry.properties) || Buffer.byteLength(JSON.stringify(entry.properties)) > 16384)) failure(errorCodes.vault_storage_failed);
    if (!entry.deleted) { const key = entry.path.normalize('NFC').toLowerCase(); if (paths.has(key)) failure(errorCodes.vault_storage_failed); paths.add(key); total += Buffer.byteLength(entry.content); }
  }
  if (total > 16*1024*1024) failure(errorCodes.vault_limit_exceeded, 413);
  return result;
}
export async function requestVaultRemote(connection: ServiceConnection, endpoint: string, body?: unknown): Promise<{status:number;body:unknown}> {
  if (endpoint.startsWith('/v1/vault/snapshot?vaultId=')) endpoint = '/v1/vault/snapshot?vaultId=' + canonicalVaultId(endpoint.slice('/v1/vault/snapshot?vaultId='.length));
  else if (endpoint !== '/v1/vault/list' && endpoint !== '/v1/vault/commit') failure(errorCodes.vault_request_invalid,400);
  const base = normalizeServiceUrl(connection.apiUrl), target = new URL(base + endpoint);
  if (!endpoint.startsWith('/v1/vault/') || target.origin !== new URL(base).origin) failure(errorCodes.vault_request_invalid,400);
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined && Buffer.byteLength(text)>4*1024*1024) failure(errorCodes.vault_limit_exceeded,413);
  const headers: Record<string,string> = {accept:'application/json'};
  if (connection.token) headers.authorization = 'Bearer '+connection.token;
  if (connection.workspaceId) headers['X-Workspace-ID']=connection.workspaceId;
  if (text !== undefined) headers['content-type']='application/json';
  try {
    const response = await fetch(target,{method:text===undefined?'GET':'POST',headers,body:text,redirect:'error',signal:AbortSignal.timeout(10000)});
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); failure(errorCodes.vault_storage_failed); }
    if (Number(response.headers.get('content-length'))>MAX_WIRE) { await response.body?.cancel(); failure(errorCodes.vault_limit_exceeded,413); }
    const chunks:Uint8Array[]=[];let length=0;const reader=response.body?.getReader();
    if(reader)try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>MAX_WIRE){await reader.cancel();failure(errorCodes.vault_limit_exceeded,413);}chunks.push(part.value);}}finally{reader.releaseLock();}
    return {status:response.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
  } catch (error) { if(error instanceof OrgApiError)throw error; return failure(errorCodes.service_upstream_failed); }
}
export async function vaultSyncTargets(ctx:ControlPlaneContext):Promise<{vaults:VaultSyncTarget[]}> {
  const connection=resolveServiceConnection(ctx,'mem');if(!connection)failure(errorCodes.drive_not_configured,503);
  const response=await requestVaultRemote(connection,'/v1/vault/list');
  if(response.status!==200)failure(errorCodes.service_upstream_failed,response.status>=400&&response.status<500?response.status:502);
  const body=response.body as {vaults:VaultSyncTarget[]};if(!Array.isArray(body?.vaults)||body.vaults.length>1000||body.vaults.some(v=>!UUID.test(v.vaultId)||typeof v.title!=='string'||v.title.length>256||!Number.isSafeInteger(v.revision)))failure(errorCodes.vault_storage_failed);
  return body;
}
export function syncWorkspaceVault(ctx:ControlPlaneContext,request:{vaultId?:string}={}):Promise<VaultSyncReceipt> {
  const workspace=ctx.workspace.requireOpen();const key=path.resolve(workspace.dir);
  const pending=active.get(key);if(pending)return pending;
  const task=sync(ctx,workspace,request).finally(()=>{if(active.get(key)===task)active.delete(key);});active.set(key,task);return task;
}
async function sync(ctx:ControlPlaneContext,workspace:OpenWorkspace,request:{vaultId?:string}):Promise<VaultSyncReceipt> {
  const connection=resolveServiceConnection(ctx,'mem');if(!connection)failure(errorCodes.drive_not_configured,503);
  if(request.vaultId!==undefined)canonicalVaultId(request.vaultId);
  const saved=await loadState(workspace), local=await exportLocalVaultSnapshot(workspace);
  const vaultId=canonicalVaultId(request.vaultId??saved?.remoteVaultId??local.vaultId);
  const fingerprint=crypto.createHash('sha256').update(connection.apiUrl+'\0'+(connection.workspaceId??'')+'\0'+vaultId).digest('hex');
  const base=saved?.connection===fingerprint?withoutBindings(normalizeVaultAssetReferences(saved.snapshot.entries)):[];
  const here=withoutBindings(await prepareVaultAttachments(workspace,local.entries,connection,vaultId));
  for(let attempt=0;attempt<3;attempt++){
    const fetched=await requestVaultRemote(connection,'/v1/vault/snapshot?vaultId='+vaultId);
    if(fetched.status!==200)failure(errorCodes.service_upstream_failed,fetched.status>=400&&fetched.status<500?fetched.status:502);
    const rawRemote=snapshot(fetched.body,vaultId);
    const remote={...rawRemote,entries:withoutBindings(normalizeVaultAssetReferences(rawRemote.entries))};
    const planned=planVaultSync(base,here,withoutBindings(remote.entries));
    // Include normalization deltas so cloud bodies and local Markdown use
    // the same portable version paths, rather than diverging silently.
    const changes=planned.entries.filter(e=>entryValue(e)!==entryValue(rawRemote.entries.find(r=>r.noteId===e.noteId)));
    if(changes.length>512)failure(errorCodes.vault_limit_exceeded,413);
    if((await exportLocalVaultSnapshot(workspace)).expectedHash!==local.expectedHash)failure(errorCodes.vault_conflict,409);
    let committed=remote;
    if(changes.length||remote.revision===0){const uploaded=await requestVaultRemote(connection,'/v1/vault/commit',{vaultId,title:remote.title||local.title,baseRevision:remote.revision,entries:changes.map(({revision,...entry})=>entry)});
      if(uploaded.status===409)continue;
      if(uploaded.status!==200&&uploaded.status!==201)failure(errorCodes.service_upstream_failed,uploaded.status>=400&&uploaded.status<500?uploaded.status:502);
      committed=snapshot(uploaded.body,vaultId);
    }
    // Until local apply succeeds, the pre-sync local image is the merge base.
    // Retrying must not treat an unapplied remote edit as a fresh local edit.
    const pendingBase:VaultRemoteSnapshot={...committed,entries:here.map(e=>({...e,deleted:e.deleted===true,revision:e.revision??0}))};
    await saveState(workspace,{schemaVersion:'vault-sync-state.v1',connection:fingerprint,remoteVaultId:vaultId,snapshot:pendingBase,pending:true});
    await hydrateVaultAttachments(workspace,committed.entries,connection);
    try {
      const incoming:Omit<LocalVaultSnapshot,'expectedHash'>={schemaVersion:'vault-snapshot.v1',vaultId:local.vaultId,title:local.title,revision:committed.revision,updatedAt:new Date().toISOString(),entries:committed.entries.map(e=>({...e,deleted:e.deleted===true,revision:e.revision??committed.revision}))};
      const currentValues=withoutBindings(local.entries);
      if(incoming.entries.length!==currentValues.length||incoming.entries.some(e=>entryValue(e)!==entryValue(currentValues.find(h=>h.noteId===e.noteId)))) {
        await applyLocalVaultSnapshot(workspace,incoming,{expectedHash:local.expectedHash});
      } else if ((await exportLocalVaultSnapshot(workspace)).expectedHash!==local.expectedHash) failure(errorCodes.vault_conflict,409);
    } catch(error){if(error instanceof OrgApiError&&error.code===errorCodes.vault_conflict)return{status:'local_changed',vaultId,revision:committed.revision,pushed:changes.length,pulled:0,conflicts:planned.conflicts};throw error;}
    await saveState(workspace,{schemaVersion:'vault-sync-state.v1',connection:fingerprint,remoteVaultId:vaultId,snapshot:committed});
    return {status:planned.conflicts.length?'conflict':'synced',vaultId,revision:committed.revision,pushed:changes.length,pulled:committed.entries.filter(e=>entryValue(e)!==entryValue(here.find(h=>h.noteId===e.noteId))).length,conflicts:planned.conflicts};
  }
  failure(errorCodes.vault_conflict,409);
}
