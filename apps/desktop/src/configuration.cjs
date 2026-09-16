// User preferences only. Workspace identity, Agent binding and business data
// are deliberately absent from this closed schema and its IPC surface.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const jsonc = require('./vendor/jsonc-parser.cjs');
const { createCredentialStore, HOST_FIELDS, validValue } = require('./credential-settings.cjs');
const { createConnectionStore, normalizeConnection } = require('./service-connections.cjs');
const { validateRuntimeSettings } = require('./runtime-settings.cjs');
const FILE = 'roleweave.config.jsonc';
const MAX_BYTES = 256 * 1024;
const MAX_STORED_BYTES = MAX_BYTES * 4;
// Four bounded source files can each expand sixfold when JSON-stringified.
// Recovery must accept every journal the transaction writer can produce.
const MAX_JOURNAL_BYTES = 4 * MAX_STORED_BYTES * 6 + 4096;
const REF_FIELDS = { qoder: { personalAccessTokenRef: 'QODER_PERSONAL_ACCESS_TOKEN' },
  claude: { apiKeyRef: 'ANTHROPIC_API_KEY', authTokenRef: 'ANTHROPIC_AUTH_TOKEN' }, codex: { apiKeyRef: 'OPENAI_API_KEY' } };
const HOST_URLS = { claude: 'ANTHROPIC_BASE_URL', codex: 'OPENAI_BASE_URL' };
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => ({ ok: false, code });
function defaults() { return { schemaVersion: 1, appearance: { mode: 'system', profile: 'mint', locale: 'zh-CN' },
  chat: { sendShortcut: 'enter', rememberLayout: true }, layouts: { focusByWorkspace: {} },
  runtime: {}, hosts: { qoder: {}, claude: {}, codex: {} }, services: {}, migration: { rendererPreferences: false, pendingHostUrls: [] } }; }
function validateConfigurationText(text) {
  const errors = [];
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) return { ok: false, code: 'invalid_configuration', errors: [{ field: '$', line: 1, column: 1, message: 'Configuration exceeds 256 KiB.' }] };
  const syntax = [];
  const tree = jsonc.parseTree(text, syntax, { allowTrailingComma: true, disallowComments: false });
  const location = offset => { const lines = text.slice(0, offset).split('\n'); return { line: lines.length, column: lines.at(-1).length + 1 }; };
  const error = (field, message, offset) => {
    const node = tree && jsonc.findNodeAtLocation(tree, field === '$' ? [] : field.split('.'));
    errors.push({ field, ...location(offset ?? node?.offset ?? 0), message });
  };
  for (const entry of syntax) error('$', jsonc.printParseErrorCode(entry.error), entry.offset);
  // JSONC's parser accepts repeated object names. Reject them explicitly so a
  // form and an external text editor cannot disagree about the effective value.
  function duplicates(node, field = '$') {
    if (!node) return;
    if (node.type === 'object') {
      const names = new Set();
      for (const prop of node.children ?? []) {
        const name = prop.children?.[0]?.value;
        if (names.has(name)) error(field, 'Duplicate property.', prop.offset);
        names.add(name); duplicates(prop.children?.[1], field === '$' ? name : `${field}.${name}`);
      }
    }
  }
  duplicates(tree);
  if (errors.length) return { ok: false, code: 'invalid_configuration', errors };
  const value = tree && jsonc.getNodeValue(tree);
  function shape(v, keys, field) {
    if (!plain(v)) { error(field, 'Expected an object.'); return false; }
    for (const key of Object.keys(v)) if (!keys.includes(key)) error(field, 'Unknown or unsupported property.');
    return true;
  }
  function choice(v, values, field) { if (!values.includes(v)) error(field, `Expected ${values.join(' / ')}.`); }
  if (!shape(value, Object.keys(defaults()), '$')) return { ok: false, code: 'invalid_configuration', errors };
  if (value.schemaVersion !== 1) error('schemaVersion', 'Unsupported schema version. Expected 1.');
  if (shape(value.appearance, ['mode','profile','locale'], 'appearance')) {
    choice(value.appearance.mode, ['system','light','dark'], 'appearance.mode');
    choice(value.appearance.profile, ['mint','default'], 'appearance.profile');
    choice(value.appearance.locale, ['zh-CN','en'], 'appearance.locale');
  }
  if (shape(value.chat, ['sendShortcut','rememberLayout'], 'chat')) {
    choice(value.chat.sendShortcut, ['enter','mod-enter'], 'chat.sendShortcut');
    if (typeof value.chat.rememberLayout !== 'boolean') error('chat.rememberLayout','Expected a boolean.');
  }
  if (shape(value.layouts, ['focusByWorkspace'], 'layouts')) {
    const records = value.layouts.focusByWorkspace;
    if (!plain(records) || Object.keys(records).length > 256 || Object.entries(records).some(([key, v]) =>
      !key || key.length > 4096 || ['__proto__','constructor','prototype'].includes(key) || /[\x00-\x1f]/.test(key) || typeof v !== 'boolean')) error('layouts.focusByWorkspace', 'Expected at most 256 workspace layout preferences.');
  }
  try { validateRuntimeSettings(value.runtime); } catch { error('runtime', 'Invalid runtime fields. WSL paths must be absolute Linux paths.'); }
  if (shape(value.hosts, Object.keys(REF_FIELDS), 'hosts')) for (const [host, refs] of Object.entries(REF_FIELDS)) {
    const entry = value.hosts[host];
    if (!shape(entry, [...Object.keys(refs), ...(HOST_URLS[host] ? ['baseUrl'] : [])], `hosts.${host}`)) continue;
    for (const [field, key] of Object.entries(refs)) if (entry[field] !== undefined && entry[field] !== `secret:host/${key}`) error(`hosts.${host}.${field}`, 'Invalid encrypted credential reference.');
    if (entry.baseUrl !== undefined && !validValue(HOST_URLS[host], entry.baseUrl)) error(`hosts.${host}.baseUrl`, 'Use HTTPS or localhost HTTP without credentials, query or fragment.');
  }
  if (shape(value.services, ['doc','mem'], 'services')) for (const kind of ['doc','mem']) {
    const entry = value.services[kind];
    if (entry === null || entry === undefined) continue;
    if (!shape(entry, ['apiUrl','webUrl', ...(kind === 'mem' ? ['workspaceId'] : []), 'tokenRef'], `services.${kind}`)) continue;
    if (entry.tokenRef !== undefined && entry.tokenRef !== `secret:service/${kind}`) error(`services.${kind}.tokenRef`, 'Invalid encrypted service reference.');
    try { const { tokenRef, ...fields } = entry; normalizeConnection({kind,...fields}); }
    catch { error(`services.${kind}`, 'Invalid URL or Mem workspace UUID. URLs cannot include credentials, query or fragment.'); }
  }
  if (value.migration !== undefined && shape(value.migration, ['rendererPreferences','pendingHostUrls'], 'migration')) {
    if(typeof value.migration.rendererPreferences !== 'boolean') error('migration.rendererPreferences','Expected a boolean.');
    const pending=value.migration.pendingHostUrls;
    if(pending!==undefined&&(!Array.isArray(pending)||pending.length>2||pending.some(host=>!['claude','codex'].includes(host))))error('migration.pendingHostUrls','Invalid pending migration.');
  }
  return errors.length ? { ok: false, code: 'invalid_configuration', errors } : { ok: true, config: value };
}
function changesBetween(previous, next, prefix = '') {
  const result = [];
  for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])) {
    const field = prefix ? `${prefix}.${key}` : key, a = previous?.[key], b = next?.[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (plain(a) && plain(b)) result.push(...changesBetween(a,b,field));
    else result.push({field, before: a ?? null, after: b ?? null});
  }
  return result;
}
function createConfigurationStore({ userDataPath, safeStorage, env = process.env, platform = process.platform, beforeWrite = () => {} }) {
  const file = path.join(userDataPath, FILE), backup = `${file}.bak`, journal = `${file}.transaction`;
  const hostStore = () => createCredentialStore({userDataPath,safeStorage});
  const serviceStore = () => createConnectionStore({userDataPath,safeStorage});
  const transactionFiles = [FILE, `${FILE}.bak`, 'host-credentials.json', 'service-connections.json'];
  let migrationWarnings = [], lastGood = null;
  let activationBaseline = null, credentialsPendingRestart = false;
  const servicesPendingRestart = new Set();
  const activationKey = config => JSON.stringify({ runtime: config.runtime, hosts: config.hosts });
  const pendingRestart = config => credentialsPendingRestart || servicesPendingRestart.size>0 || (activationBaseline !== null && activationKey(config) !== activationBaseline);
  const readRaw = name => {
    let fd;
    try { fd=fs.openSync(path.join(userDataPath,name),'r'); if(fs.fstatSync(fd).size>(name===`${FILE}.transaction`?MAX_JOURNAL_BYTES:MAX_STORED_BYTES)) throw Error(); return fs.readFileSync(fd,'utf8'); }
    catch (e) { if(e.code==='ENOENT')return null; throw Error('storage_unavailable'); }
    finally { if(fd!==undefined)fs.closeSync(fd); }
  };
  const revision = raw => createHash('sha256').update(raw ?? '<missing>').digest('hex');
  function writeAtomic(name, raw, instrument = true) {
    if(instrument)beforeWrite(name);
    fs.mkdirSync(userDataPath,{recursive:true,mode:0o700});
    const destination=path.join(userDataPath,name), temp=`${destination}.${randomUUID()}.tmp`;
    try {
      // Windows FlushFileBuffers requires write access. Keep the exclusive
      // writable descriptor through the flush, then close it before rename.
      const fd=fs.openSync(temp,'wx',0o600);
      try {fs.writeFileSync(fd,raw);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temp,destination);
    }
    finally { try {fs.unlinkSync(temp);}catch{} }
  }
  function recover() {
    const raw=readRaw(`${FILE}.transaction`); if(raw===null)return;
    const value=JSON.parse(raw);
    if(value.version!==1||!plain(value.files)||Object.keys(value.files).sort().join('|')!==[...transactionFiles].sort().join('|'))throw Error('storage_unavailable');
    for(const [name,contents] of Object.entries(value.files)) {
      if(contents===null) {try{fs.unlinkSync(path.join(userDataPath,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
      else if(typeof contents==='string'&&Buffer.byteLength(contents)<=MAX_STORED_BYTES)writeAtomic(name,contents,false);
      else throw Error('storage_unavailable');
    }
    fs.unlinkSync(journal); migrationWarnings.push('An interrupted save was rolled back.');
  }
  function transaction(write) {
    recover(); const files=Object.fromEntries(transactionFiles.map(name=>[name,readRaw(name)]));
    const journalText=serialize({version:1,files});
    if(Buffer.byteLength(journalText)>MAX_JOURNAL_BYTES)throw Error('storage_unavailable');
    writeAtomic(`${FILE}.transaction`,journalText);
    try { write(); fs.unlinkSync(journal); }
    catch { recover(); throw Error('storage_unavailable'); }
  }
  function migrate({resolveHostUrls=true}={}) {
    recover(); if(fs.existsSync(file))return;
    const config=defaults();
    try {const raw=readRaw('runtime-settings.json'); if(raw!==null) config.runtime=validateRuntimeSettings(JSON.parse(raw));}catch{migrationWarnings.push('Legacy runtime settings could not be imported.');}
    try {
      const keys=hostStore().configuredKeys();
      for(const [host,refs]of Object.entries(REF_FIELDS))for(const [field,key]of Object.entries(refs))if(keys.includes(key))config.hosts[host][field]=`secret:host/${key}`;
      config.migration.pendingHostUrls=Object.entries(HOST_URLS).filter(([,key])=>keys.includes(key)).map(([host])=>host);
      if(resolveHostUrls&&config.migration.pendingHostUrls.length){
        const values=hostStore().environment({});
        for(const [host,key] of Object.entries(HOST_URLS))if(values[key])config.hosts[host].baseUrl=values[key];
        config.migration.pendingHostUrls=[];
      }
    }catch{migrationWarnings.push('Encrypted Agent storage is unavailable; unlock the OS keychain before using saved connections.');}
    try {
      for(const [kind,entry]of Object.entries(serviceStore().readMetadata())){
        if(entry===null){config.services[kind]=null;continue;}
        const {kind:_kind,tokenConfigured,...fields}=entry;
        config.services[kind]={...fields,...(tokenConfigured?{tokenRef:`secret:service/${kind}`}:{})};
      }
    }catch{migrationWarnings.push('Legacy service connections could not be imported. The original file is retained.');}
    for(const name of ['runtime-settings.json','host-credentials.json','service-connections.json']){
      const raw=readRaw(name); if(raw!==null&&readRaw(`${name}.legacy.bak`)===null)writeAtomic(`${name}.legacy.bak`,raw);
    }
    const raw='// RoleWeave application preferences. Secrets are encrypted references only.\n'+serialize(config);
    if(!validateConfigurationText(raw).ok)throw Error('storage_unavailable');
    writeAtomic(FILE,raw); writeAtomic(`${FILE}.bak`,raw);
  }
  function availableReferences(config) {
    try{return referencesExist(config,{},{});}catch{return false;}
  }
  function usableBackup() {
    try {
      const text=readRaw(`${FILE}.bak`),parsed=validateConfigurationText(text);
      return parsed.ok&&availableReferences(parsed.config)?{text,config:parsed.config}:null;
    }catch{return null;}
  }
  function fallbackConfiguration() {
    const current=(lastGood&&availableReferences(lastGood.config)?lastGood:null)??usableBackup();
    return current?{...current,notice:'The last valid configuration remains active.'}
      :{text:serialize(defaults()),config:defaults(),notice:'No usable saved configuration remains. Application defaults are active.'};
  }
  function readEffective({resolveHostUrls=true}={}) {
    migrate({resolveHostUrls});
    let raw;
    try { raw=readRaw(FILE); }
    catch {
      const current=fallbackConfiguration();
      return{...current,raw:'<unreadable>',repairRequired:true,warnings:[...migrationWarnings,`The configuration file cannot be read. ${current.notice} Repair the file before saving.`],errors:[]};
    }
    let parsed=validateConfigurationText(raw);
    if(parsed.ok){
      if(!availableReferences(parsed.config))parsed={ok:false,errors:[{field:'hosts / services',line:1,column:1,message:'An encrypted reference is missing or does not match its service endpoint. Repair the reference or enter credentials in the form.'}]};
    }
    if(parsed.ok){
      let text=raw,config=parsed.config;
      if(resolveHostUrls&&config.migration?.pendingHostUrls?.length){
        try {
          const values=hostStore().environment({});
          for(const host of config.migration.pendingHostUrls)if(!config.hosts[host].baseUrl&&values[HOST_URLS[host]])text=jsonc.applyEdits(text,jsonc.modify(text,['hosts',host,'baseUrl'],values[HOST_URLS[host]],{}));
          text=jsonc.applyEdits(text,jsonc.modify(text,['migration','pendingHostUrls'],[],{}));
          transaction(()=>{writeAtomic(`${FILE}.bak`,raw);writeAtomic(FILE,text);});
          config=validateConfigurationText(text).config;
        }catch { migrationWarnings=['Agent endpoint migration is pending until encrypted storage is available.']; }
      }
      if(activationBaseline===null)activationBaseline=activationKey(config);
      lastGood={text,config};return{...lastGood,raw:text,warnings:[...migrationWarnings]};
    }
    const current=fallbackConfiguration();
    return{...current,raw,repairRequired:true,warnings:[...migrationWarnings,`The configuration file is invalid or references unavailable credentials. ${current.notice} Repair and save to replace it.`],errors:parsed.errors};
  }
  function sources(config) {
    const result={};
    const contains=key=>Object.keys(env).some(name=>(platform==='win32'?name.toUpperCase()===key:name===key)&&env[name]!==undefined);
    for(const[host,keys]of Object.entries(HOST_FIELDS))result[`hosts.${host}`]=[...keys,...(host==='claude'?['ANTHROPIC_CUSTOM_HEADERS']:[])].some(contains)?'environment':Object.keys(config.hosts[host]).length?'configuration':'host-default';
    for(const[field,names]of Object.entries({mode:['ROLEWEAVE_CONTROL_PLANE_MODE','ORG_WORKBENCH_CONTROL_PLANE'],distro:['ROLEWEAVE_WSL_DISTRO'],nodePath:['ROLEWEAVE_WSL_NODE_PATH'],homePath:['ROLEWEAVE_WSL_HOME']}))result[`runtime.${field}`]=names.some(contains)?'environment':config.runtime[field]!==undefined?'configuration':'default';
    // Service connections already have explicit saved-over-environment precedence.
    for(const kind of ['doc','mem'])result[`services.${kind}`]=servicesPendingRestart.has(kind)?'environment-after-restart':Object.hasOwn(config.services,kind)?'configuration':'environment-or-default';
    return result;
  }
  function get({includeCredentialStatus=true}={}) {
    try {
      const current=readEffective({resolveHostUrls:includeCredentialStatus});
      // Electron's native credential backend can synchronously wait for OS UI.
      // Appearance/bootstrap callers must never enter that backend merely to
      // discover availability. Null means it has not been queried.
      const credentials=includeCredentialStatus?hostStore().get():{ok:true,storageAvailable:null,credentials:[]};
      return {ok:true,config:clone(current.config),text:current.text,revision:revision(current.raw),filePath:file,
        warnings:[...new Set(current.warnings)],errors:current.errors??[],repairRequired:current.repairRequired===true,sources:sources(current.config),
        storageAvailable:credentials.ok&&credentials.storageAvailable,credentials:credentials.ok?credentials.credentials:[],
        platform,canRestore:usableBackup()!==null,pendingRestart:pendingRestart(current.config),servicesRestartRequired:servicesPendingRestart.size>0};
    }catch{return fail('storage_unavailable');}
  }
  const preferenceRead={includeCredentialStatus:false};
  function getPreferences(){return get(preferenceRead);}
  function referencesExist(config,hostChanges,serviceChanges) {
    const hasHostRefs=Object.entries(REF_FIELDS).some(([host,refs])=>Object.keys(refs).some(field=>config.hosts[host][field]));
    const keys=hasHostRefs?hostStore().configuredKeys():[];
    for(const[host,refs]of Object.entries(REF_FIELDS))for(const[field,key]of Object.entries(refs))if(config.hosts[host][field] && (hostChanges[key]===null || (!hostChanges[key]&&!keys.includes(key))))return false;
    if(Object.values(config.services).some(entry=>entry?.tokenRef)) {
      const saved=serviceStore().readMetadata();
      for(const kind of ['doc','mem'])if(config.services[kind]?.tokenRef&&(serviceChanges[kind]===null||(!serviceChanges[kind]&&(!saved[kind]?.tokenConfigured||saved[kind]?.apiUrl!==config.services[kind].apiUrl))))return false;
    }
    return true;
  }
  function resolvedServices(config=readEffective().config, changes={}) {
    const entries={}; const needsStored=Object.entries(config.services).some(([kind,entry])=>entry?.tokenRef&&!changes[kind]);
    const saved=needsStored?serviceStore().read():{};
    for(const[kind,entry]of Object.entries(config.services)){
      if(entry===null){entries[kind]=null;continue;}
      const{tokenRef,...fields}=entry;
      // The same encrypted token cannot silently follow a changed API origin.
      const old=saved[kind];
      if(tokenRef&&!changes[kind]&&old&&old.apiUrl!==fields.apiUrl)throw Error('service_endpoint_changed');
      entries[kind]={kind,...fields,...(tokenRef?{token:changes[kind]||old?.token}: {token:''})};
    }
    return entries;
  }
  function save(request,readOptions={}) {
    if(!plain(request)||Object.keys(request).some(k=>!['text','revision','hostChanges','serviceChanges'].includes(k))||typeof request.revision!=='string')return fail('invalid_request');
    const parsed=validateConfigurationText(request.text); if(!parsed.ok)return parsed;
    const hostChanges=request.hostChanges??{},serviceChanges=request.serviceChanges??{};
    if(!plain(hostChanges)||!plain(serviceChanges)||Object.entries(hostChanges).some(([key,value])=>!Object.values(REF_FIELDS).some(refs=>Object.values(refs).includes(key))||(value!==null&&value!==''&&!validValue(key,value)))||Object.entries(serviceChanges).some(([kind,value])=>!['doc','mem'].includes(kind)||(value!==null&&(typeof value!=='string'||value.length>8192||/[\x00-\x20\x7f]/.test(value)))))return fail('invalid_request');
    try {
      const current=readEffective({resolveHostUrls:readOptions.includeCredentialStatus!==false});
      if(request.revision!==revision(current.raw))return{ok:false,code:'conflict',current:get(readOptions)};
      if(!referencesExist(parsed.config,hostChanges,serviceChanges)) {
        const metadata=serviceStore().readMetadata();
        if(['doc','mem'].some(kind=>parsed.config.services[kind]?.tokenRef&&!serviceChanges[kind]&&metadata[kind]?.apiUrl!==parsed.config.services[kind].apiUrl))return fail('service_endpoint_changed');
        return{ok:false,code:'invalid_configuration',errors:[{field:'hosts / services',line:1,column:1,message:'A credential reference has no encrypted value. Enter a credential or remove the reference.'}]};
      }
      const changed=changesBetween(current.config,parsed.config);
      if(parsed.config.migration?.pendingHostUrls?.length){
        const pending=parsed.config.migration.pendingHostUrls.filter(host=>!changed.some(row=>row.field.startsWith(`hosts.${host}`)));
        parsed.config.migration.pendingHostUrls=pending;
        request={...request,text:jsonc.applyEdits(request.text,jsonc.modify(request.text,['migration','pendingHostUrls'],pending,{}))};
      }
      const changedServices=JSON.stringify(current.config.services)!==JSON.stringify(parsed.config.services)||Object.values(serviceChanges).some(v=>v!==''&&v!==undefined);
      const nextServices=changedServices?resolvedServices(parsed.config,serviceChanges):null;
      transaction(()=>{
        if(Object.keys(hostChanges).length&&!hostStore().setMany(hostChanges).ok)throw Error();
        if(nextServices)serviceStore().write(nextServices);
        writeAtomic(`${FILE}.bak`,current.text);
        writeAtomic(FILE,request.text);
      });
      lastGood={text:request.text,config:parsed.config}; migrationWarnings=[];
      if(Object.values(hostChanges).some(value=>value!==''))credentialsPendingRestart=true;
      for(const kind of ['doc','mem']){
        if(Object.hasOwn(current.config.services,kind)&&!Object.hasOwn(parsed.config.services,kind))servicesPendingRestart.add(kind);
        else if(Object.hasOwn(parsed.config.services,kind))servicesPendingRestart.delete(kind);
      }
      return {...get(readOptions),changes:changed,pendingRestart:pendingRestart(parsed.config),servicesChanged:changedServices};
    }catch(error){return fail(error.message==='service_endpoint_changed'?'service_endpoint_changed':'storage_unavailable');}
  }
  function patchPreferences(patch) {
    if(!plain(patch)||Object.keys(patch).some(k=>!['appearance','chat','layouts'].includes(k)))return fail('invalid_request');
    const current=getPreferences();if(!current.ok)return current;if(current.repairRequired)return fail('invalid_configuration');
    let text=current.text;
    for(const[section,fields]of Object.entries(patch)){
      if(!plain(fields))return fail('invalid_request');
      for(const[key,value]of Object.entries(fields))text=jsonc.applyEdits(text,jsonc.modify(text,[section,key],value,{formattingOptions:{insertSpaces:true,tabSize:2}}));
    }
    return save({text,revision:current.revision},preferenceRead);
  }
  function migratePreferences(legacy) {
    const current=getPreferences();if(!current.ok||current.repairRequired||current.config.migration?.rendererPreferences)return current;
    if(!plain(legacy))return fail('invalid_request');
    let text=current.text;
    for(const[key,values]of Object.entries({mode:['light','dark','system'],profile:['mint','default'],locale:['en','zh-CN']}))if(values.includes(legacy[key]))text=jsonc.applyEdits(text,jsonc.modify(text,['appearance',key],legacy[key],{}));
    text=jsonc.applyEdits(text,jsonc.modify(text,['migration','rendererPreferences'],true,{}));
    return save({text,revision:current.revision},preferenceRead);
  }
  function writeServices(connections) {
    const current=get();if(!current.ok)throw Error('service_storage_unavailable');
    const services={}, serviceChanges={};
    for(const[kind,entry]of Object.entries(connections)){
      if(!['doc','mem'].includes(kind))throw Error('service_request_invalid');
      if(entry===null){services[kind]=null;continue;}
      const{kind:_kind,token,...fields}=normalizeConnection(entry);
      services[kind]={...fields,...(token?{tokenRef:`secret:service/${kind}`}:{})};
      if(token!==undefined)serviceChanges[kind]=token||null;
    }
    const text=jsonc.applyEdits(current.text,jsonc.modify(current.text,['services'],services,{formattingOptions:{insertSpaces:true,tabSize:2}}));
    const result=save({text,revision:current.revision,serviceChanges});if(!result.ok)throw Error('service_storage_unavailable');
  }
  function runtimeEnvironment(source) {
    const result={...source};if(platform!=='win32')return result;
    const config=readEffective().config.runtime;
    const mode=source.ROLEWEAVE_CONTROL_PLANE_MODE??source.ORG_WORKBENCH_CONTROL_PLANE??config.mode;
    if(mode!==undefined)result.ROLEWEAVE_CONTROL_PLANE_MODE=mode;
    for(const[field,key]of Object.entries({distro:'ROLEWEAVE_WSL_DISTRO',nodePath:'ROLEWEAVE_WSL_NODE_PATH',homePath:'ROLEWEAVE_WSL_HOME'}))if(config[field]!==undefined&&result[key]===undefined)result[key]=config[field];
    return result;
  }
  function setCredential(key, value) {
    if (!Object.values(HOST_FIELDS).flat().includes(key)) return fail('invalid_value');
    const current=get(); if(!current.ok)return current;
    let target;
    for(const[host,refs]of Object.entries(REF_FIELDS))for(const[field,ref]of Object.entries(refs))if(ref===key)target=['hosts',host,field];
    for(const[host,url]of Object.entries(HOST_URLS))if(url===key)target=['hosts',host,'baseUrl'];
    if(!target)return fail('invalid_value');
    const text=jsonc.applyEdits(current.text,jsonc.modify(current.text,target,value===null?undefined:key.endsWith('_BASE_URL')?value:`secret:host/${key}`,{}));
    const result=save({text,revision:current.revision,...(!key.endsWith('_BASE_URL')?{hostChanges:{[key]:value}}:{})});
    return result.ok?{ok:true}:fail(result.code==='invalid_configuration'?'invalid_value':'storage_unavailable');
  }
  function restore(rev) {
    try { const raw=readRaw(`${FILE}.bak`);if(raw===null)return fail('storage_unavailable');return save({text:raw,revision:rev}); }catch{return fail('storage_unavailable');}
  }
  return {get,getPreferences,save,setCredential,patchPreferences,migratePreferences,restore,runtimeEnvironment,
    hostEnvironment:source=>{
      try{return hostStore().environment(source,readEffective().config.hosts);}
      catch{migrationWarnings.push('Saved Host credentials are unavailable. Unlock or repair encrypted storage; local workspace features remain available.');return{...source};}
    },readServices:()=>resolvedServices(),writeServices};
}
module.exports={createConfigurationStore,validateConfigurationText,changesBetween,defaults,REF_FIELDS,HOST_URLS,FILE};
