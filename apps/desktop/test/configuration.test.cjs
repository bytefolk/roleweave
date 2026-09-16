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
  assert.deepEqual(h.store.hostEnvironment({OPENAI_BASE_URL:'https://operator.example'}),{OPENAI_BASE_URL:'https://operator.example'});
  assert.equal(h.store.runtimeEnvironment({ROLEWEAVE_WSL_DISTRO:'Operator'}).ROLEWEAVE_WSL_DISTRO,'Operator');
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
