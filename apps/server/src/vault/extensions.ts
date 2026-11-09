import type { IncomingMessage, ServerResponse } from 'node:http';
import { OrgApiError, errorCodes } from '@roleweave/shared';
import type { ControlPlaneContext } from '../context.js';
import { readJsonBody, sendJson } from '../http.js';
import { resolveServiceConnection } from '../services/connections.js';
import { syncWorkspaceVault, vaultSyncTargets } from './sync.js';
import { attachMemAsset } from './attachments.js';
import { noteFromTurn } from './from-turn.js';
import { assembleVaultContext } from './context.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid():never {throw new OrgApiError(errorCodes.vault_request_invalid,400,'Invalid notebook request');}
function object(raw:unknown,keys:string[]):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!keys.includes(key)))invalid();return raw as Record<string,unknown>;}
/** All routes are dispatched after the existing operator boot-token check. */
export async function handleVaultExtensions(ctx:ControlPlaneContext,req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  if(!['/vault/attach','/vault/from-turn','/vault/context','/vault/sync','/vault/sync/targets'].includes(url.pathname))return false;
  const ws=ctx.workspace.requireOpen();res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/vault/sync/targets'&&req.method==='GET'){sendJson(res,200,await vaultSyncTargets(ctx));return true;}
  if(req.method!=='POST')throw new OrgApiError(errorCodes.method_not_allowed,405,'Method not allowed');
  if(url.pathname==='/vault/attach'){
    const raw=object(await readJsonBody(req),['fileId']);if(typeof raw.fileId!=='string'||!UUID.test(raw.fileId))invalid();
    const connection=resolveServiceConnection(ctx,'mem');if(!connection)throw new OrgApiError(errorCodes.drive_not_configured,503,'Connect Mem to attach a file');
    sendJson(res,200,await attachMemAsset(ws,connection,raw.fileId));return true;
  }
  if(url.pathname==='/vault/from-turn'){
    const raw=object(await readJsonBody(req),['positionId','turnId','path','content']);
    if(typeof raw.positionId!=='string'||typeof raw.turnId!=='string'||typeof raw.path!=='string'||(raw.content!==undefined&&typeof raw.content!=='string'))invalid();
    sendJson(res,201,await noteFromTurn(ctx,raw as {positionId:string;turnId:string;path:string;content?:string}));return true;
  }
  if(url.pathname==='/vault/context'){
    const raw=object(await readJsonBody(req),['positionId','q']);if(typeof raw.positionId!=='string'||(raw.q!==undefined&&(typeof raw.q!=='string'||raw.q.length>256)))invalid();
    const context=await assembleVaultContext(ws,raw.positionId,(raw.q as string|undefined)??'');sendJson(res,200,{notes:context.notes});return true;
  }
  const raw=object(await readJsonBody(req),['vaultId']);if(raw.vaultId!==undefined&&(typeof raw.vaultId!=='string'||!UUID.test(raw.vaultId)))invalid();
  sendJson(res,200,await syncWorkspaceVault(ctx,raw as {vaultId?:string}));return true;
}
