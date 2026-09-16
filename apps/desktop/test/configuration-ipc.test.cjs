const {test}=require('node:test');const assert=require('node:assert/strict');
const {registerConfigurationIpc,registerExternalUrlIpc,safeExternalUrl}=require('../src/configuration-ipc.cjs');
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
