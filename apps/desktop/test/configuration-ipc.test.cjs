const {test}=require('node:test');const assert=require('node:assert/strict');
const {registerConfigurationIpc,registerExternalUrlIpc,safeExternalUrl}=require('../src/configuration-ipc.cjs');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createConfigurationStore}=require('../src/configuration.cjs');
test('configuration IPC is enumerated, trusted, and rejects malformed arity before storage',async()=>{
 const handlers=new Map(),calls=[];
 registerConfigurationIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f)},getStore:()=>({get:()=>{calls.push('get');return{ok:true};},getPreferences:()=>{calls.push('preferences');return{ok:true};}}),isTrusted:e=>e.trusted,shell:{},setDirty:()=>{},close:()=>{}});
 assert.equal(handlers.size,10);
 assert.deepEqual(await handlers.get('owb:configuration:get')({trusted:false}),{ok:false,code:'untrusted_sender'});
 assert.deepEqual(await handlers.get('owb:configuration:get')({trusted:true},'extra'),{ok:false,code:'invalid_request'});
 assert.deepEqual(calls,[]);
 assert.equal((await handlers.get('owb:configuration:get')({trusted:true})).ok,true);
 assert.deepEqual(await handlers.get('owb:configuration:get-preferences')({trusted:false}),{ok:false,code:'untrusted_sender'});
 assert.deepEqual(await handlers.get('owb:configuration:get-preferences')({trusted:true},'extra'),{ok:false,code:'invalid_request'});
 assert.equal((await handlers.get('owb:configuration:get-preferences')({trusted:true})).ok,true);
 assert.deepEqual(calls,['get','preferences']);
 assert.deepEqual(await handlers.get('owb:configuration:dirty')({trusted:true},'true'),{ok:false,code:'invalid_request'});
});
test('external links refuse executable schemes, credentials, controls and untrusted frames',async()=>{
 for(const url of ['javascript:alert(1)','data:text/html,test','file:///tmp/example','https://user:secret@example.com','https://example.com\n','https://example.com bad'])assert.equal(safeExternalUrl(url),false,url);
 for(const url of ['https://example.com/docs?q=topic#intro','http://localhost:3100','mailto:hello@example.com'])assert.equal(safeExternalUrl(url),true,url);
 let open;const calls=[];registerExternalUrlIpc({ipcMain:{handle:(_n,f)=>{open=f;}},isTrusted:e=>e.trusted,shell:{openExternal:async u=>calls.push(u)}});
 assert.equal((await open({trusted:false},'https://example.com')).ok,false);
 assert.equal((await open({trusted:true},'file:///tmp/example')).ok,false);assert.equal(calls.length,0);
 assert.equal((await open({trusted:true},'https://example.com')).ok,true);assert.equal(calls.length,1);
});
test('a saved removal of service overrides never claims live environment defaults applied',async()=>{
 const handlers=new Map();registerConfigurationIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f)},isTrusted:()=>true,
  getStore:()=>({save:()=>({ok:true,servicesChanged:true,servicesRestartRequired:true})}),onSaved:async()=>true,shell:{},setDirty:()=>{},close:()=>{}});
 const result=await handlers.get('owb:configuration:save')({},{});assert.equal(result.ok,true);assert.equal(result.servicesApplied,false);assert.equal(result.servicesRestartRequired,true);
});
test('storage diagnostics and native project picker require the trusted enumerated bridge',async()=>{
 const handlers=new Map(),calls=[];
 registerConfigurationIpc({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},getStore:()=>({}),
  isTrusted:event=>event.trusted,shell:{},setDirty:()=>{},close:()=>{},
  pickProjectDirectory:async()=>{calls.push('pick');return{ok:true,path:'/tmp/projects'};},
  cacheInfo:async()=>{calls.push('size');return{ok:true,bytes:42};},
  openCache:async()=>{calls.push('open');return{ok:true};}});
 for(const name of ['pick-project-directory','cache-info','open-cache']){
  const handler=handlers.get(`owb:configuration:${name}`);
  assert.deepEqual(await handler({trusted:false}),{ok:false,code:'untrusted_sender'});
  assert.deepEqual(await handler({trusted:true},'unexpected'),{ok:false,code:'invalid_request'});
 }
 assert.deepEqual(calls,[]);
 assert.equal((await handlers.get('owb:configuration:pick-project-directory')({trusted:true})).path,'/tmp/projects');
 assert.equal((await handlers.get('owb:configuration:cache-info')({trusted:true})).bytes,42);
 assert.equal((await handlers.get('owb:configuration:open-cache')({trusted:true})).ok,true);
 assert.deepEqual(calls,['pick','size','open']);
});
for(const [name,callback] of [['open-cache','openCache'],['cache-info','cacheInfo'],['pick-project-directory','pickProjectDirectory']]){
 test(`pending ${name} does not block validation, saving, reading or dirty state`,async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roleweave-ipc-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store=createConfigurationStore({userDataPath:directory,env:{},safeStorage:{isEncryptionAvailable:()=>false}});
  const current=store.get();assert.equal(current.ok,true);
  const config=structuredClone(current.config);config.storage={projectDirectory:'/tmp/saved-projects'};
  const text=JSON.stringify(config),handlers=new Map();let release,dirty=false;
  registerConfigurationIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f)},getStore:()=>store,isTrusted:()=>true,
   shell:{},setDirty:value=>{dirty=value;},close:()=>{},[callback]:()=>new Promise(resolve=>{release=resolve;})});
  const invoke=(channel,...args)=>handlers.get(`owb:configuration:${channel}`)({},...args);
  const auxiliary=invoke(name);await Promise.resolve();
  let savedBeforeRelease=false,validatedBeforeRelease=false,readBeforeRelease=false;
  const validated=invoke('validate',text).then(result=>{validatedBeforeRelease=result.ok;});
  const saved=invoke('save',{text,revision:current.revision}).then(result=>{savedBeforeRelease=result.ok;});
  const read=invoke('get').then(result=>{readBeforeRelease=result.config.storage?.projectDirectory==='/tmp/saved-projects';});
  const marked=invoke('dirty',true);
  await new Promise(setImmediate);
  const observed={savedBeforeRelease,validatedBeforeRelease,readBeforeRelease,dirty};
  release({ok:false});await Promise.all([auxiliary,validated,saved,read,marked]);
  assert.deepEqual(observed,{savedBeforeRelease:true,validatedBeforeRelease:true,readBeforeRelease:true,dirty:true});
  assert.equal(store.get().config.storage.projectDirectory,'/tmp/saved-projects');
 });
}
