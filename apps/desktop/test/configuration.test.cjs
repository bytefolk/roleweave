const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfigurationStore, validateConfigurationText, defaults } = require('../src/configuration.cjs');
const { createCredentialStore } = require('../src/credential-settings.cjs');
const { createConnectionStore } = require('../src/service-connections.cjs');
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roleweave-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
    encryptString: (s) => Buffer.from([...s].reverse().join('')), decryptString: (b) => [...b.toString()].reverse().join('') };
  const store = createConfigurationStore({ userDataPath: dir, safeStorage, env: {}, ...options });
  return { dir, safeStorage, store, file: path.join(dir, 'roleweave.config.jsonc') };
}
const text = (value) => JSON.stringify(value, null, 2);
test('JSONC accepts comments and rejects unknown fields, duplicate keys, plaintext tokens, and unsafe URLs with location', () => {
  assert.equal(validateConfigurationText('// prefs\n'+text(defaults())).ok, true);
  const preGemini = defaults(); delete preGemini.hosts.gemini;
  assert.deepEqual(validateConfigurationText(text(preGemini)).config.hosts.gemini, {});
  for (const patch of [c => c.hosts.codex.apiKey='secret', c => c.services.doc={apiUrl:'http://remote.example'},
    c => c.chat.sendShortcut='other', c => c.hosts.codex.apiKeyRef='secret:host/ANTHROPIC_API_KEY']) {
    const c=defaults(); patch(c); const result=validateConfigurationText(text(c));
    assert.equal(result.ok,false); assert.ok(result.errors[0].line>0); assert.ok(result.errors[0].field);
    assert.equal(JSON.stringify(result).includes('secret"'),false);
  }
  assert.equal(validateConfigurationText('{"schemaVersion":1,"schemaVersion":1}').ok,false);
});
test('migrates legacy stores and preferences without removing originals; references never expose secrets', t => {
  const h=setup(t); const legacy=createCredentialStore({userDataPath:h.dir,safeStorage:h.safeStorage});
  legacy.set('OPENAI_API_KEY','dummy-test-credential'); legacy.set('OPENAI_BASE_URL','https://provider.example/v1');
  createConnectionStore({userDataPath:h.dir,safeStorage:h.safeStorage}).write({doc:{kind:'doc',apiUrl:'https://doc.example',token:'dummy-service-token'}});
  fs.writeFileSync(path.join(h.dir,'runtime-settings.json'),text({mode:'wsl',distro:'Ubuntu'}));
  const s=h.store.get(); assert.equal(s.ok,true); assert.equal(s.config.runtime.distro,'Ubuntu');
  assert.equal(s.config.hosts.codex.baseUrl,'https://provider.example/v1'); assert.ok(s.config.hosts.codex.apiKeyRef);
  assert.equal(JSON.stringify(s).includes('dummy-test-credential'),false); assert.equal(s.config.services.doc.tokenRef,'secret:service/doc');
  const migrated=h.store.migratePreferences({mode:'dark',profile:'default',locale:'en'}); assert.equal(migrated.config.appearance.locale,'en');
  assert.ok(fs.existsSync(path.join(h.dir,'host-credentials.json.legacy.bak')));
  assert.equal(h.store.migratePreferences({mode:'light',profile:'mint',locale:'zh-CN'}).config.appearance.mode,'dark');
});
test('save persists, reloads, previews and detects external edits; invalid text retains effective config', t => {
  const h=setup(t); const a=h.store.get(); const c=structuredClone(a.config); c.appearance.mode='dark';
  const b=h.store.save({text:'// retained comment\n'+text(c),revision:a.revision}); assert.equal(b.ok,true);
  assert.equal(h.store.get().config.appearance.mode,'dark'); assert.match(h.store.get().text,/retained comment/);
  assert.equal(h.store.save({text:'{broken',revision:b.revision}).ok,false);
  fs.appendFileSync(h.file,'\n// external'); const conflict=h.store.save({text:text(c),revision:b.revision});
  assert.equal(conflict.code,'conflict'); assert.equal(conflict.current.config.appearance.mode,'dark');
  assert.equal(h.store.save({text:text(c),revision:conflict.current.revision}).ok,true);
  fs.writeFileSync(h.file,'{broken'); const recovered=h.store.get(); assert.equal(recovered.ok,true); assert.ok(recovered.warnings.length);
});
test('grouped credentials validate before any write and roll back if config commit fails; blank retains', t => {
  let fail=false; const h=setup(t,{beforeWrite: name => {if(fail&&name==='roleweave.config.jsonc')throw Error('disk');}});
  const a=h.store.get(); const c=structuredClone(a.config); c.hosts.codex.apiKeyRef='secret:host/OPENAI_API_KEY';
  let b=h.store.save({text:text(c),revision:a.revision,hostChanges:{OPENAI_API_KEY:'dummy-first-key'}}); assert.equal(b.ok,true);
  const before=fs.readFileSync(path.join(h.dir,'host-credentials.json'),'utf8');
  assert.equal(h.store.save({text:text(c),revision:b.revision,hostChanges:{OPENAI_API_KEY:'invalid space'}}).ok,false);
  assert.equal(fs.readFileSync(path.join(h.dir,'host-credentials.json'),'utf8'),before);
  fail=true; assert.equal(h.store.save({text:text(c),revision:b.revision,hostChanges:{OPENAI_API_KEY:'dummy-next-key'}}).ok,false);
  assert.equal(fs.readFileSync(path.join(h.dir,'host-credentials.json'),'utf8'),before); fail=false;
  b=h.store.save({text:text(c),revision:b.revision,hostChanges:{OPENAI_API_KEY:''}}); assert.equal(b.ok,true);
  assert.equal(h.store.hostEnvironment({}).OPENAI_API_KEY,'dummy-first-key');
});
test('inherited host settings win as a group; runtime overrides preserve operator env and app data boundary', t => {
  const h=setup(t,{env:{OPENAI_BASE_URL:'https://operator.example',ROLEWEAVE_WSL_DISTRO:'Operator'},platform:'win32'});
  const a=h.store.get(),c=a.config; c.hosts.codex={baseUrl:'https://saved.example',apiKeyRef:'secret:host/OPENAI_API_KEY'};
  c.runtime={mode:'wsl',distro:'Saved'}; assert.equal(h.store.save({text:text(c),revision:a.revision,hostChanges:{OPENAI_API_KEY:'dummy-private-key'}}).ok,true);
  const hostSource=Object.freeze({OPENAI_BASE_URL:'https://operator.example'}),hostEnv=h.store.hostEnvironment(hostSource);
  assert.deepEqual(hostEnv,{OPENAI_BASE_URL:'https://operator.example'});assert.notEqual(hostEnv,hostSource);
  const runtimeSource=Object.freeze({PATH:'original-path',ROLEWEAVE_WSL_DISTRO:'Operator'}),runtimeEnv=h.store.runtimeEnvironment(runtimeSource);
  assert.notEqual(runtimeEnv,runtimeSource);assert.deepEqual(runtimeEnv,{...runtimeSource,ROLEWEAVE_CONTROL_PLANE_MODE:'wsl'});
  runtimeEnv.PATH='child-only';assert.deepEqual(runtimeSource,{PATH:'original-path',ROLEWEAVE_WSL_DISTRO:'Operator'});
  assert.equal(h.store.get().sources['hosts.codex'],'environment');
  c.workspace={agent:'other'}; assert.equal(h.store.save({text:text(c),revision:h.store.get().revision}).ok,false);
});
test('locked keychain migration retains service references and imports host endpoint after unlock', t => {
  const h=setup(t); const host=createCredentialStore({userDataPath:h.dir,safeStorage:h.safeStorage});
  host.set('OPENAI_API_KEY','dummy-original-key'); host.set('OPENAI_BASE_URL','https://saved.example');
  createConnectionStore({userDataPath:h.dir,safeStorage:h.safeStorage}).write({doc:{kind:'doc',apiUrl:'https://doc.example',token:'dummy-doc-token'}});
  h.safeStorage.isEncryptionAvailable=()=>false;
  const locked=h.store.get(); assert.equal(locked.ok,true); assert.equal(locked.config.services.doc.tokenRef,'secret:service/doc');
  assert.deepEqual(locked.config.migration.pendingHostUrls,['codex']);
  const changed=structuredClone(locked.config); changed.appearance.profile='default';
  assert.equal(h.store.save({text:text(changed),revision:locked.revision}).ok,true);
  h.safeStorage.isEncryptionAvailable=()=>true;
  const unlocked=h.store.get(); assert.equal(unlocked.config.hosts.codex.baseUrl,'https://saved.example');
  assert.equal(unlocked.config.appearance.profile,'default'); assert.equal(h.store.readServices().doc.token,'dummy-doc-token');
});
test('corrupt external edits retain the most recently effective in-process configuration', t => {
  const h=setup(t),a=h.store.get(),c=a.config;c.appearance.mode='dark';
  assert.equal(h.store.save({text:text(c),revision:a.revision}).ok,true);
  fs.writeFileSync(h.file,'{corrupt');assert.equal(h.store.get().config.appearance.mode,'dark');
});
test('pending restart remains visible after subsequent appearance-only saves', t => {
 const h=setup(t),a=h.store.get(),c=a.config;c.hosts.codex={apiKeyRef:'secret:host/OPENAI_API_KEY'};
 const b=h.store.save({text:text(c),revision:a.revision,hostChanges:{OPENAI_API_KEY:'dummy-new-key'}});assert.equal(b.pendingRestart,true);
 c.appearance.mode='dark';const d=h.store.save({text:text(c),revision:b.revision});assert.equal(d.pendingRestart,true);assert.equal(h.store.get().pendingRestart,true);
 const restarted=createConfigurationStore({userDataPath:h.dir,safeStorage:h.safeStorage,env:{}});assert.equal(restarted.get().pendingRestart,false);
});
test('a service token cannot follow a changed endpoint without an explicit update or clear',t=>{
 const h=setup(t),a=h.store.get(),c=a.config;c.services.doc={apiUrl:'https://first.example',tokenRef:'secret:service/doc'};
 const b=h.store.save({text:text(c),revision:a.revision,serviceChanges:{doc:'dummy-service-key'}});assert.equal(b.ok,true);
 c.services.doc.apiUrl='https://second.example';assert.equal(h.store.save({text:text(c),revision:b.revision}).code,'service_endpoint_changed');
 assert.equal(h.store.readServices().doc.apiUrl,'https://first.example');delete c.services.doc.tokenRef;
 const d=h.store.save({text:text(c),revision:b.revision,serviceChanges:{doc:null}});assert.equal(d.ok,true);assert.equal(h.store.readServices().doc.token,'');
});
test('oversized configuration and locked credentials do not prevent unrelated local features from booting',t=>{
 const h=setup(t),a=h.store.get(),c=a.config;c.hosts.codex={apiKeyRef:'secret:host/OPENAI_API_KEY'};
 assert.equal(h.store.save({text:text(c),revision:a.revision,hostChanges:{OPENAI_API_KEY:'dummy-locked-key'}}).ok,true);
 h.safeStorage.isEncryptionAvailable=()=>false;
 assert.deepEqual(h.store.hostEnvironment({PATH:'/test/bin'}),{PATH:'/test/bin'});
 fs.writeFileSync(h.file,'x'.repeat(2*1024*1024));assert.equal(h.store.get().ok,true);assert.equal(h.store.get().config.appearance.mode,'system');
 assert.equal(h.store.save({text:text(c),revision:h.store.get().revision}).ok,false);
});
test('near-limit escaped JSONC and encrypted data roll back through a bounded readable journal',t=>{
 let fail=false;const h=setup(t,{beforeWrite:name=>{if(fail&&name==='roleweave.config.jsonc')throw Error('disk');}});
 let a=h.store.get();const c=a.config;c.hosts.codex={apiKeyRef:'secret:host/OPENAI_API_KEY'};
 const prefix=text(c)+'\n// ',big=prefix+'\\'.repeat(256*1024-Buffer.byteLength(prefix)-4);
 let result=h.store.save({text:big,revision:a.revision,hostChanges:{OPENAI_API_KEY:'d'.repeat(6000)}});assert.equal(result.ok,true);
 result=h.store.save({text:big+'\n',revision:result.revision});assert.equal(result.ok,true);
 const before=fs.readFileSync(h.file,'utf8'),cipher=fs.readFileSync(path.join(h.dir,'host-credentials.json'),'utf8');
 fail=true;const rejected=h.store.save({text:big+'\n\n',revision:result.revision,hostChanges:{OPENAI_API_KEY:'dummy-replacement'}});
 assert.equal(rejected.ok,false);assert.equal(h.store.get().ok,true);assert.equal(fs.readFileSync(h.file,'utf8'),before);assert.equal(fs.readFileSync(path.join(h.dir,'host-credentials.json'),'utf8'),cipher);
 assert.equal(fs.existsSync(path.join(h.dir,'roleweave.config.jsonc.transaction')),false);
});
test('removing a saved service override truthfully remains pending restart across later saves',t=>{
 const h=setup(t),a=h.store.get(),c=a.config;c.services.doc={apiUrl:'https://saved.example'};
 const b=h.store.save({text:text(c),revision:a.revision});assert.equal(b.ok,true);delete c.services.doc;
 const d=h.store.save({text:text(c),revision:b.revision});assert.equal(d.ok,true);assert.equal(d.pendingRestart,true);assert.equal(d.servicesRestartRequired,true);assert.equal(d.sources['services.doc'],'environment-after-restart');
 c.appearance.mode='dark';const e=h.store.save({text:text(c),revision:d.revision});assert.equal(e.servicesRestartRequired,true);
 const restarted=createConfigurationStore({userDataPath:h.dir,safeStorage:h.safeStorage,env:{}});assert.equal(restarted.get().servicesRestartRequired,false);assert.deepEqual(restarted.readServices(),{});
});
test('external missing encrypted references cannot replace valid effective preferences',t=>{
 const h=setup(t),a=h.store.get(),c=a.config;c.appearance.mode='dark';assert.equal(h.store.save({text:text(c),revision:a.revision}).ok,true);
 const invalid=structuredClone(c);invalid.appearance.mode='light';invalid.hosts.codex.apiKeyRef='secret:host/OPENAI_API_KEY';fs.writeFileSync(h.file,text(invalid));
 const current=h.store.get();assert.equal(current.ok,true);assert.equal(current.config.appearance.mode,'dark');assert.ok(current.warnings.length);assert.ok(current.errors.length);
});
test('an unrelated malformed encrypted store does not block noncredential preference edits',t=>{
 const h=setup(t),a=h.store.get();fs.writeFileSync(path.join(h.dir,'host-credentials.json'),'{malformed');
 const c=a.config;c.appearance.mode='dark';const result=h.store.save({text:text(c),revision:a.revision});assert.equal(result.ok,true);assert.equal(result.config.appearance.mode,'dark');
});
test('quick preferences and automatic legacy preference import never silently overwrite a corrupt external edit',t=>{
 const h=setup(t);h.store.get();const broken='{temporary external edit';fs.writeFileSync(h.file,broken);
 assert.equal(h.store.patchPreferences({appearance:{mode:'dark'}}).ok,false);assert.equal(fs.readFileSync(h.file,'utf8'),broken);
 const boot=h.store.migratePreferences({mode:'dark'});assert.equal(boot.ok,true);assert.equal(boot.repairRequired,true);assert.equal(fs.readFileSync(h.file,'utf8'),broken);
 const repaired=h.store.save({text:text(defaults()),revision:boot.revision});assert.equal(repaired.ok,true);assert.equal(repaired.repairRequired,false);
});
test('recovery never reactivates backup or in-process references whose encrypted values were cleared',t=>{
 const h=setup(t),a=h.store.get(),c=a.config;c.hosts.codex.apiKeyRef='secret:host/OPENAI_API_KEY';
 const saved=h.store.save({text:text(c),revision:a.revision,hostChanges:{OPENAI_API_KEY:'dummy-cleared-key'}});assert.equal(saved.ok,true);
 delete c.hosts.codex.apiKeyRef;assert.equal(h.store.save({text:text(c),revision:saved.revision,hostChanges:{OPENAI_API_KEY:null}}).ok,true);
 for(const broken of ['{corrupt','x'.repeat(2*1024*1024)]){
  fs.writeFileSync(h.file,broken);
  const restarted=createConfigurationStore({userDataPath:h.dir,safeStorage:h.safeStorage,env:{}}),current=restarted.get();
  assert.equal(current.ok,true);assert.equal(current.config.hosts.codex.apiKeyRef,undefined);assert.equal(current.canRestore,false);
  assert.ok(current.warnings.some(message=>message.includes('defaults')));assert.deepEqual(restarted.hostEnvironment({}),{});
 }
 fs.writeFileSync(h.file,text(defaults()));const live=createConfigurationStore({userDataPath:h.dir,safeStorage:h.safeStorage,env:{}});
 const original=live.get(),withRef=original.config;withRef.hosts.codex.apiKeyRef='secret:host/OPENAI_API_KEY';
 assert.equal(live.save({text:text(withRef),revision:original.revision,hostChanges:{OPENAI_API_KEY:'dummy-removed-externally'}}).ok,true);
 createCredentialStore({userDataPath:h.dir,safeStorage:h.safeStorage}).clear('OPENAI_API_KEY');fs.writeFileSync(h.file,'{corrupt');
 assert.equal(live.get().config.hosts.codex.apiKeyRef,undefined);
});
test('bootstrap and ordinary preferences never probe the native credential backend',t=>{
 const h=setup(t,{platform:'win32'});let nativeCalls=0;
 h.safeStorage.isEncryptionAvailable=()=>{nativeCalls++;throw Error('native backend must not be called');};
 // Main constructs the runtime/Host environment and starts services before
 // mounting App. None of those paths needs native storage without references.
 assert.deepEqual(h.store.runtimeEnvironment({PATH:'fixture-path'}),{PATH:'fixture-path'});
 assert.deepEqual(h.store.hostEnvironment({PATH:'fixture-path'}),{PATH:'fixture-path'});
 assert.deepEqual(h.store.readServices(),{});
 const boot=h.store.migratePreferences({mode:'dark',locale:'en'});
 assert.equal(boot.ok,true);assert.equal(boot.config.appearance.mode,'dark');assert.equal(boot.storageAvailable,null);
 const saved=h.store.patchPreferences({chat:{sendShortcut:'mod-enter'}});
 assert.equal(saved.ok,true);assert.equal(saved.config.chat.sendShortcut,'mod-enter');
 assert.equal(h.store.getPreferences().ok,true);assert.equal(nativeCalls,0);
 // Opening credential settings remains an explicit backend check.
 assert.equal(h.store.get().storageAvailable,false);assert.ok(nativeCalls>0);
});
test('preference-only migration retains encrypted references and defers legacy endpoint decryption',t=>{
 const h=setup(t),host=createCredentialStore({userDataPath:h.dir,safeStorage:h.safeStorage});
 host.set('OPENAI_API_KEY','dummy-deferred-key');host.set('OPENAI_BASE_URL','https://deferred.example');
 const available=h.safeStorage.isEncryptionAvailable;let nativeCalls=0;
 h.safeStorage.isEncryptionAvailable=()=>{nativeCalls++;throw Error('native backend must not be called');};
 const boot=h.store.migratePreferences({mode:'dark'});
 assert.equal(boot.ok,true);assert.equal(boot.config.hosts.codex.apiKeyRef,'secret:host/OPENAI_API_KEY');
 assert.deepEqual(boot.config.migration.pendingHostUrls,['codex']);
 assert.equal(h.store.patchPreferences({appearance:{locale:'en'}}).ok,true);assert.equal(nativeCalls,0);
 h.safeStorage.isEncryptionAvailable=available;
 const settings=h.store.get();assert.equal(settings.config.hosts.codex.baseUrl,'https://deferred.example');
 assert.equal(settings.config.appearance.locale,'en');assert.equal(settings.storageAvailable,true);
 assert.equal(h.store.hostEnvironment({}).OPENAI_API_KEY,'dummy-deferred-key');
});
test('Windows startup migration and rollback flush a writable temporary descriptor before rename',t=>{
 const h=setup(t,{platform:'win32'}),descriptors=new Map();
 const open=fs.openSync,close=fs.closeSync,flush=fs.fsyncSync;let flushed=0,failNextFlush=false;
 t.mock.method(fs,'openSync',(...args)=>{const fd=open(...args);descriptors.set(fd,{file:String(args[0]),flags:args[1]});return fd;});
 t.mock.method(fs,'closeSync',fd=>{descriptors.delete(fd);return close(fd);});
 t.mock.method(fs,'fsyncSync',fd=>{
  // Windows FlushFileBuffers requires GENERIC_WRITE, unlike POSIX fsync.
  const entry=descriptors.get(fd);
  if(entry?.flags!=='wx')throw Object.assign(Error('FlushFileBuffers requires a writable handle'),{code:'EPERM'});
  if(failNextFlush&&!entry.file.includes('.transaction.')){failNextFlush=false;throw Object.assign(Error('injected disk failure'),{code:'EIO'});}
  flushed++;return flush(fd);
 });
 const inherited=Object.freeze({PATH:'windows-path'});
 assert.deepEqual(h.store.runtimeEnvironment(inherited),inherited);
 const original=h.store.getPreferences(),changed=structuredClone(original.config);changed.appearance.mode='dark';
 const saved=h.store.save({text:text(changed),revision:original.revision});assert.equal(saved.ok,true);
 const previous=fs.readFileSync(h.file,'utf8');changed.appearance.mode='light';failNextFlush=true;
 assert.equal(h.store.save({text:text(changed),revision:saved.revision}).ok,false);
 assert.equal(fs.readFileSync(h.file,'utf8'),previous);assert.equal(h.store.getPreferences().ok,true);
 assert.ok(flushed>=5);assert.equal(descriptors.size,0);
 assert.equal(fs.readdirSync(h.dir).some(name=>name.endsWith('.tmp')||name.endsWith('.transaction')),false);
});
