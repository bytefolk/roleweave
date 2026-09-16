const { validateConfigurationText } = require('./configuration.cjs');
const failure = code => ({ok:false,code});
function registerConfigurationIpc({ ipcMain, getStore, isTrusted, shell, onSaved = async () => true, setDirty, close }) {
  let pending=Promise.resolve();
  const serial=fn=>{const result=pending.then(fn,fn);pending=result.catch(()=>{});return result;};
  const register=(name,arity,handler)=>ipcMain.handle(`owb:configuration:${name}`,(event,...args)=>{
    if(!isTrusted(event))return failure('untrusted_sender');
    if(args.length!==arity)return failure('invalid_request');
    return serial(async()=>{try{return await handler(...args);}catch{return failure('storage_unavailable');}});
  });
  const saved=async(result)=>{if(result.ok&&result.servicesChanged){const live=await onSaved();return{...result,servicesApplied:live===true&&!result.servicesRestartRequired};}return result;};
  register('get',0,()=>getStore().get());
  register('get-preferences',0,()=>getStore().getPreferences());
  register('validate',1,text=>validateConfigurationText(text));
  register('save',1,request=>saved(getStore().save(request)));
  register('preferences',1,request=>getStore().patchPreferences(request));
  register('migrate-preferences',1,request=>getStore().migratePreferences(request));
  register('restore',1,revision=>saved(getStore().restore(revision)));
  register('open-location',0,()=>{const current=getStore().getPreferences();if(!current.ok)return current;shell.showItemInFolder(current.filePath);return{ok:true};});
  register('dirty',1,value=>{if(typeof value!=='boolean')return failure('invalid_request');setDirty(value);return{ok:true};});
  register('confirm-close',0,()=>{setDirty(false);close();return{ok:true};});
}
function safeExternalUrl(value) {
  if(typeof value!=='string'||value.length>8192||/[\x00-\x20\x7f]/.test(value))return false;
  try{const url=new URL(value);return ['https:','http:','mailto:'].includes(url.protocol)&&!url.username&&!url.password&&
    (url.protocol==='mailto:'?!!url.pathname:!!url.hostname);}catch{return false;}
}
function registerExternalUrlIpc({ipcMain,isTrusted,shell}){
  ipcMain.handle('owb:external:open',async(event,value)=>{
    if(!isTrusted(event)||!safeExternalUrl(value))return{ok:false};
    try{await shell.openExternal(value);return{ok:true};}catch{return{ok:false};}
  });
}
module.exports={registerConfigurationIpc,registerExternalUrlIpc,safeExternalUrl};
