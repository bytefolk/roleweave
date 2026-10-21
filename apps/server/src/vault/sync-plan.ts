import crypto from 'node:crypto';
import path from 'node:path';
import type { VaultSyncEntry } from '@roleweave/shared';

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]));
  return value;
}
export function entryValue(entry: VaultSyncEntry | undefined): string {
  return entry === undefined || entry.deleted ? 'deleted' : JSON.stringify([entry.path, entry.content, ordered(entry.properties ?? {})]);
}
function tombstone(entry: VaultSyncEntry): VaultSyncEntry { return { ...entry, content: '', deleted: true }; }
function conflictId(entry: VaultSyncEntry, salt: number): string {
  const bytes = crypto.createHash('sha256').update('vault-conflict.v1\0' + entry.noteId + '\0' + entryValue(entry) + '\0' + salt).digest();
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0,16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function boundedPathStem(value: string, maximum: number): string {
  let result='';for(const character of value){if(Buffer.byteLength(result+character)>maximum)break;result+=character;}
  return result.replace(/[ .]+$/u, '') || 'note';
}
function relocateAssetLinks(entry: VaultSyncEntry, destination: string): string {
  if(path.posix.dirname(entry.path)===path.posix.dirname(destination))return entry.content;
  const records=Array.isArray(entry.properties?.assets)?entry.properties.assets as Array<{path?:unknown}>:[];
  const known=new Set(records.filter(record=>typeof record?.path==='string').map(record=>record.path as string));
  return entry.content.replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)([^)\n]*\))/g, (whole,prefix:string,token:string,suffix:string)=>{
    const angle=token.startsWith('<'), raw=angle?token.slice(1,-1):token;
    let decoded:string;try{decoded=decodeURIComponent(raw);}catch{return whole;}
    if(/^[a-z][a-z0-9+.-]*:/i.test(decoded)||decoded.startsWith('/')||decoded.startsWith('#'))return whole;
    const rootPath=path.posix.normalize(path.posix.join(path.posix.dirname(entry.path),decoded));
    if(!known.has(rootPath))return whole;
    const relative=path.posix.relative(path.posix.dirname(destination),rootPath).split('/').map(segment=>encodeURIComponent(segment)).join('/');
    return prefix+(angle?'<'+relative+'>':relative)+suffix;
  });
}
export function planVaultSync(base: readonly VaultSyncEntry[], local: readonly VaultSyncEntry[], remote: readonly VaultSyncEntry[], newId?: () => string): {
  entries: VaultSyncEntry[]; changes: VaultSyncEntry[]; conflicts: Array<{path: string; copyPath: string}>;
} {
  const baselines = new Map(base.map(entry => [entry.noteId, entry]));
  const localById = new Map(local.map(entry => [entry.noteId, entry]));
  const remoteById = new Map(remote.map(entry => [entry.noteId, entry]));
  const allIds = [...new Set([...baselines.keys(), ...localById.keys(), ...remoteById.keys()])].sort();
  const result = new Map<string, VaultSyncEntry>();
  const conflicts: Array<{path: string; copyPath: string}> = [];
  const used = new Set([...local, ...remote].filter(entry => !entry.deleted).map(entry => entry.path.normalize('NFC').toLowerCase()));
  const copy = (entry: VaultSyncEntry): VaultSyncEntry => {
    let salt = 0, noteId = newId ? newId() : conflictId(entry, salt);
    while (true) {
      const existing = result.get(noteId) ?? remoteById.get(noteId) ?? localById.get(noteId);
      if (!existing || existing.deleted) break;
      if (existing.content === relocateAssetLinks(entry,existing.path) && JSON.stringify(ordered(existing.properties ?? {})) === JSON.stringify(ordered(entry.properties ?? {}))) {
        conflicts.push({path:entry.path,copyPath:existing.path}); return existing;
      }
      noteId = conflictId(entry, ++salt);
    }
    let directory = path.posix.dirname(entry.path), suffix = 0;
    const name = path.posix.basename(entry.path).replace(/\.(md|markdown)$/i, '');
    const candidate = () => {
      const tail = ` (conflict ${noteId.slice(0, 8)}${suffix ? ' ' + suffix : ''}).md`;
      let prefix = directory === '.' ? '' : directory + '/';
      if (512 - Buffer.byteLength(prefix + tail) < 4) { directory='Conflicts';prefix='Conflicts/'; }
      return prefix + boundedPathStem(name, Math.min(255-Buffer.byteLength(tail), 512-Buffer.byteLength(prefix+tail))) + tail;
    };
    let copyPath = candidate();
    while (used.has(copyPath.normalize('NFC').toLowerCase())) { suffix++; copyPath = candidate(); }
    used.add(copyPath.normalize('NFC').toLowerCase());
    conflicts.push({ path: entry.path, copyPath });
    return { ...entry, noteId, path: copyPath, content:relocateAssetLinks(entry,copyPath), deleted: false };
  };
  for (const id of allIds) {
    const before = baselines.get(id), here = localById.get(id), there = remoteById.get(id);
    const h = entryValue(here), t = entryValue(there), b = entryValue(before);
    let chosen: VaultSyncEntry | undefined;
    if (h === t) chosen = here ?? there;
    else if (h === b) chosen = there ?? (before ? tombstone(before) : undefined);
    else if (t === b) chosen = here ?? (before ? tombstone(before) : undefined);
    else if (here && there && !here.deleted && !there.deleted && here.content === there.content
      && JSON.stringify(ordered(here.properties ?? {})) === JSON.stringify(ordered(there.properties ?? {}))) {
      // Concurrent naming alone keeps one identity; a retry of a committed
      // conflict rename must not manufacture another logical copy.
      chosen = there; conflicts.push({path:here.path,copyPath:there.path});
    }
    else {
      chosen = there ?? (before ? tombstone(before) : undefined);
      if (here && !here.deleted) { const duplicate = copy(here); result.set(duplicate.noteId, duplicate); }
      else if (there && !there.deleted) conflicts.push({ path: there.path, copyPath: there.path });
    }
    if (chosen) result.set(id, chosen);
  }
  const paths = new Map<string, string>();
  // Prefer the existing remote owner of a path; preserve every other note as a copy.
  const ownsRemotePath = (entry: VaultSyncEntry) => { const previous=remoteById.get(entry.noteId);return !!previous && !previous.deleted && previous.path.normalize('NFC').toLowerCase()===entry.path.normalize('NFC').toLowerCase(); };
  const entries = [...result.values()].sort((a, b) => Number(ownsRemotePath(b)) - Number(ownsRemotePath(a)) || a.noteId.localeCompare(b.noteId));
  for (const entry of entries) {
    if (entry.deleted) continue;
    const key = entry.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) {
      const duplicate = copy(entry);
      // A path collision alone does not create a second logical note.
      // Keep the caller's identity (and its local bindings), changing its name.
      result.set(entry.noteId, {...duplicate,noteId:entry.noteId});
      paths.set(duplicate.path.normalize('NFC').toLowerCase(), entry.noteId);
    } else paths.set(key, entry.noteId);
  }
  const merged = [...result.values()].sort((a, b) => a.noteId.localeCompare(b.noteId));
  return { entries: merged, changes: merged.filter(entry => entryValue(entry) !== entryValue(remoteById.get(entry.noteId))), conflicts };
}
