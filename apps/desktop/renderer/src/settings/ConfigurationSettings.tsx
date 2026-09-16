import { configurationText, configurationGroups } from '../locales/configuration';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Input, Modal, Select, Spin } from 'antd';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { useT } from '@roleweave/ui';
import type { ApplicationConfiguration, ConfigurationSnapshot, ConfigurationIssue, ConfigurationChange, ConfigurationSave } from '../configuration-types';
import { applyConfiguration, registerSettingsLeave, CONFIGURATION_APPLIED } from '../configuration-preferences';
import { CREDENTIAL_FIELDS, type CredentialKey } from './credential-settings';
import { ServiceConnections } from './ServiceConnections';
import './configuration-settings.css';
const groups = configurationGroups;
type Category = typeof groups[number][0];
const hostKeys={Qoder:'qoder',Claude:'claude',Codex:'codex'} as const;
const refFields:Partial<Record<CredentialKey,string>>={QODER_PERSONAL_ACCESS_TOKEN:'personalAccessTokenRef',ANTHROPIC_API_KEY:'apiKeyRef',ANTHROPIC_AUTH_TOKEN:'authTokenRef',OPENAI_API_KEY:'apiKeyRef'};
function differences(a:unknown,b:unknown,prefix=''):ConfigurationChange[]{
 const prev=a&&typeof a==='object'?a as Record<string,unknown>:{},next=b&&typeof b==='object'?b as Record<string,unknown>:{};
 return [...new Set([...Object.keys(prev),...Object.keys(next)])].flatMap(key=>{
  const before=prev[key],after=next[key],field=prefix?`${prefix}.${key}`:key;
  if(JSON.stringify(before)===JSON.stringify(after))return[];
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after))return differences(before,after,field);
  return[{field,before:before??null,after:after??null}];
 });
}
const display=(value:unknown)=>value===null?'—':typeof value==='object'?JSON.stringify(value):String(value);
export function ConfigurationSettings({updates}:{updates:ReactNode}) {
 const t=useT();const[snapshot,setSnapshot]=useState<ConfigurationSnapshot|null>(null),[text,setText]=useState('');
 const[category,setCategory]=useState<Category>('general'),[view,setView]=useState<'form'|'file'>('form');
 const[issues,setIssues]=useState<ConfigurationIssue[]>([]),[validatedText,setValidatedText]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[conflict,setConflict]=useState<ConfigurationSnapshot|null>(null);
 const[preview,setPreview]=useState(false),[leaveOpen,setLeaveOpen]=useState(false),[secretVersion,setSecretVersion]=useState(0);
 const[clearKeys,setClearKeys]=useState<Set<string>>(new Set());
 const secretInputs=useRef(new Map<string,HTMLInputElement>()),pendingAction=useRef<(()=>void)|null>(null);
 const validationSequence=useRef(0),saving=useRef(false),latestSave=useRef<()=>Promise<boolean>>(async()=>false);
 const parsed=useMemo(()=>{const errors:ParseError[]=[];const value=parse(text,errors,{allowTrailingComma:true}) as ApplicationConfiguration|undefined;return{value,errors};},[text]);
 const object=(value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const strings=(value:unknown)=>object(value)&&Object.values(value as Record<string,unknown>).every(v=>typeof v==='string');
 const formShape=parsed.errors.length===0&&object(parsed.value?.appearance)&&['system','light','dark'].includes(parsed.value?.appearance?.mode??'')&&['mint','default'].includes(parsed.value?.appearance?.profile??'')&&['en','zh-CN'].includes(parsed.value?.appearance?.locale??'')&&object(parsed.value?.chat)&&['enter','mod-enter'].includes(parsed.value?.chat?.sendShortcut??'')&&typeof parsed.value?.chat?.rememberLayout==='boolean'&&strings(parsed.value?.hosts?.qoder)&&strings(parsed.value?.hosts?.claude)&&strings(parsed.value?.hosts?.codex)&&object(parsed.value?.services)&&Object.values(parsed.value?.services??{}).every(v=>v===null||strings(v))&&strings(parsed.value?.runtime);
 const config=formShape?parsed.value:snapshot?.config;
 const english=(config??snapshot?.config)?.appearance.locale==='en';const copy=(en:string)=>configurationText(english,en);
 const hasSecretChanges=useMemo(()=>secretVersion>=0&&([...secretInputs.current.values()].some(input=>!!input.value)||clearKeys.size>0),[secretVersion,clearKeys]);
 const dirty=!!snapshot&&(text!==snapshot.text||hasSecretChanges);
 const dirtyRef=useRef(dirty);dirtyRef.current=dirty;
 const changes=useMemo(()=>config&&snapshot?differences(snapshot.config,config):[],[config,snapshot]);
 const formInvalid=parsed.errors.length>0||issues.length>0||!config;
 const formBlocked=!formShape;
 function resetSecrets(){for(const input of secretInputs.current.values())input.value='';setClearKeys(new Set());setSecretVersion(v=>v+1);}
 const accept=useCallback((next:ConfigurationSnapshot)=>{setSnapshot(next);setText(next.text);setValidatedText(next.text);setIssues([]);setConflict(null);setError(null);},[]);
 const reload=useCallback(async()=>{
  setLoading(true);setError(null);
  try{const result=await window.owb.configuration!.get();if(!result.ok)throw Error();accept(result);resetSecrets();}
  catch{setError('load');}finally{setLoading(false);}
 },[accept]);
 useEffect(()=>{void reload();},[reload]);
 useEffect(()=>{
  if(!snapshot)return;const sequence=++validationSequence.current;
  const timer=window.setTimeout(()=>{void window.owb.configuration!.validate(text).then(result=>{if(sequence===validationSequence.current){setIssues(result.ok?[]:result.errors??[]);setValidatedText(result.ok?text:'');}}).catch(()=>{if(sequence===validationSequence.current)setError('validate');});},140);
  return()=>window.clearTimeout(timer);
 },[text,snapshot]);
 useEffect(()=>{void window.owb.configuration?.setDirty(dirty);},[dirty]);
 useEffect(()=>registerSettingsLeave(proceed=>{if(!dirtyRef.current&&!saving.current){proceed();return;}pendingAction.current=proceed;setLeaveOpen(true);}),[]);
 useEffect(()=>{
  const refresh=()=>{if(!dirtyRef.current&&!saving.current)void reload();};
  window.addEventListener(CONFIGURATION_APPLIED,refresh);window.addEventListener('owb:services-changed',refresh);
  return()=>{window.removeEventListener(CONFIGURATION_APPLIED,refresh);window.removeEventListener('owb:services-changed',refresh);};
 },[reload]);
 function field(path:(string|number)[],value:unknown){setText(current=>applyEdits(current,modify(current,path,value,{formattingOptions:{insertSpaces:true,tabSize:2}})));setNotice(null);setIssues([]);}
 function secretChanged(key:string,path:string[],reference:string){const input=secretInputs.current.get(key);if(input?.value){field(path,reference);setClearKeys(current=>{const next=new Set(current);next.delete(key);return next;});}setSecretVersion(v=>v+1);}
 function clearSecret(key:string,path:string[],reference?:string){
  setClearKeys(current=>{const next=new Set(current);if(next.has(key)){next.delete(key);if(reference)field(path,reference);}else{next.add(key);field(path,undefined);}return next;});setSecretVersion(v=>v+1);
 }
 function request():ConfigurationSave{
  const hostChanges:ConfigurationSave['hostChanges']={},serviceChanges:ConfigurationSave['serviceChanges']={};
  for(const[key,input]of secretInputs.current){const value=clearKeys.has(key)?null:input.value;if(value==='')continue;if(key.startsWith('service:'))serviceChanges[key.slice(8) as 'doc'|'mem']=value;else hostChanges[key as CredentialKey]=value;}
  return{text,revision:snapshot!.revision,hostChanges,serviceChanges};
 }
 async function save(revision?:string):Promise<boolean>{
  if(saving.current||!snapshot)return false;saving.current=true;setBusy(true);setError(null);setNotice(null);
  try{
   const valid=await window.owb.configuration!.validate(text);if(!valid.ok){setIssues(valid.errors??[]);setError('validate');return false;}
   const result=await window.owb.configuration!.save({...request(),...(revision?{revision}:{})});
   if(!result.ok){if(result.code==='conflict'&&result.current)setConflict(result.current);else{setIssues(result.errors??[]);setError(result.code);}return false;}
   accept(result);resetSecrets();applyConfiguration(result);
   setNotice(result.servicesRestartRequired?'services-restart':result.servicesApplied===false?'services-pending':result.pendingRestart?'restart':'saved');
   if(result.servicesChanged)window.dispatchEvent(new Event('owb:services-changed'));
   return true;
  }catch{setError('storage_unavailable');return false;}finally{saving.current=false;setBusy(false);}
 }
 latestSave.current=()=>save();
 function discardAndProceed(){setLeaveOpen(false);resetSecrets();if(snapshot)setText(snapshot.text);dirtyRef.current=false;void window.owb.configuration?.setDirty(false);const action=pendingAction.current;pendingAction.current=null;action?.();}
 async function saveAndProceed(){if(await latestSave.current()){setLeaveOpen(false);dirtyRef.current=false;void window.owb.configuration?.setDirty(false);const action=pendingAction.current;pendingAction.current=null;action?.();}}
 async function restore(){if(!snapshot||busy)return;setBusy(true);try{const result=await window.owb.configuration!.restore(snapshot.revision);if(!result.ok){setError(result.code);if(result.current)setConflict(result.current);return;}accept(result);resetSecrets();applyConfiguration(result);setNotice(result.pendingRestart?'restart':'saved');}catch{setError('storage_unavailable');}finally{setBusy(false);}}
 const errorCopy=error==='service_endpoint_changed'?copy("The API URL changed. Update or explicitly clear its token before saving."):error==='validate'?copy("Fix the marked fields. The active configuration has not changed."):copy("Could not read or save configuration. Your draft is retained; retry.");
 const input=(label:string,path:string[],value:string|undefined,placeholder?:string)=><label className="owb-config-field"><span>{label}</span><Input value={value??''} onChange={e=>field(path,e.target.value||undefined)} placeholder={placeholder} spellCheck={false} maxLength={4096} /></label>;
 return <section className="owb-settings-module owb-config-settings" aria-label={t('settings.moduleAria')}>
  <header className="owb-settings-module__header"><h1>{t('settings.title')}</h1></header>
  <div className="owb-config-tabs" role="tablist" aria-label={copy("Settings categories")}>
   {groups.map(([id,en])=><button type="button" key={id} id={`settings-tab-${id}`} role="tab" aria-selected={category===id} aria-controls={`settings-panel-${id}`} onClick={()=>setCategory(id)}>{copy(en)}</button>)}
  </div>
  <div className="owb-config-content">
   {loading?<div role="status"><Spin size="small" /> {copy("Loading settings…")}</div>:null}
   {error?<Alert type="error" showIcon title={errorCopy} action={!snapshot?<Button onClick={()=>void reload()}>{copy("Retry")}</Button>:undefined}/>:null}
   {snapshot?.warnings.map(message=><Alert key={message} type="warning" showIcon title={copy("Configuration recovery")} description={message}/>)}
   {snapshot?.storageAvailable===false?<Alert type="warning" showIcon title={copy("OS encrypted storage is unavailable. General preferences remain editable; unlock your keychain to change credentials.")}/>:null}
   {issues.length?<div role="alert" className="owb-config-errors">{issues.map((issue,i)=><p key={`${issue.field}-${i}`}>{copy("Line ")} {issue.line}:{issue.column} · <code>{issue.field}</code> — {issue.message}</p>)}</div>:null}
   {snapshot&&config?<>
    <section id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={category!=='general'}>
     <fieldset disabled={busy||formBlocked}><legend>{copy("Appearance and input")}</legend>
      <label className="owb-config-field"><span>{copy("Language")}</span><Select aria-label={copy("Language")} value={config.appearance.locale} options={[{value:'zh-CN',label:copy('Simplified Chinese')},{value:'en',label:'English'}]} onChange={v=>field(['appearance','locale'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-field"><span>{copy("Theme")}</span><Select aria-label={copy("Theme")} value={config.appearance.mode} options={[{value:'system',label:copy("System")},{value:'light',label:copy("Light")},{value:'dark',label:copy("Dark")}]} onChange={v=>field(['appearance','mode'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-field"><span>{copy("Color profile")}</span><Select aria-label={copy("Color profile")} value={config.appearance.profile} options={[{value:'mint',label:'Mint'},{value:'default',label:'Ant Blue'}]} onChange={v=>field(['appearance','profile'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-field"><span>{copy("Send shortcut")}</span><Select aria-label={copy("Send shortcut")} value={config.chat.sendShortcut} options={[{value:'enter',label:'Enter'},{value:'mod-enter',label:'⌘ / Ctrl + Enter'}]} onChange={v=>field(['chat','sendShortcut'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-checkbox"><input type="checkbox" checked={config.chat.rememberLayout} onChange={e=>field(['chat','rememberLayout'],e.target.checked)}/>{copy("Remember workspace conversation layout")}</label>
      <p className="owb-settings-module__hint">{copy("Appearance applies after save. Quick preferences use the same configuration. Composing text with an IME never sends a message.")}</p>
     </fieldset>
    </section>
    <section id="settings-panel-agents" role="tabpanel" aria-labelledby="settings-tab-agents" hidden={category!=='agents'}>
     <fieldset disabled={busy||formBlocked}><legend>{copy("Project and Agent runtime")}</legend>
      {snapshot.platform==='win32'?<><label className="owb-config-field"><span>{copy("Runtime")}</span><Select aria-label={copy("Runtime")} value={config.runtime.mode??'default'} options={[{value:'default',label:copy("Launch default")},{value:'native',label:'Windows'},{value:'wsl',label:'WSL'}]} onChange={v=>field(['runtime','mode'],v==='default'?undefined:v)} disabled={busy||formBlocked}/></label>
       {input('WSL distribution',['runtime','distro'],config.runtime.distro,'Ubuntu')}{input('WSL Node path',['runtime','nodePath'],config.runtime.nodePath,'/usr/bin/node')}{input('WSL home',['runtime','homePath'],config.runtime.homePath,'/home/example')}
       {Object.entries(snapshot.sources).filter(([key,v])=>key.startsWith('runtime.')&&v==='environment').map(([key])=><p key={key} className="owb-settings-module__hint"><code>{key}</code> · {copy("Environment override takes precedence")}</p>)}
      </>:<p>{copy("This platform uses the native runtime. WSL settings apply only on Windows.")}</p>}
      <p className="owb-settings-module__hint">{copy("Runtime and Host credentials apply after restart. Saving never interrupts a running task or changes an employee’s Agent binding.")}</p>
     </fieldset>
     {(['Qoder','Claude','Codex'] as const).map(host=>{const id=hostKeys[host],hostConfig=config.hosts[id] as Record<string,string|undefined>,configured=Object.keys(hostConfig).length>0,source=snapshot.sources[`hosts.${id}`];return <details key={host} className="owb-config-host" open={Object.keys(snapshot.config.hosts[id]).length?undefined:true}>
      <summary><strong>{host}</strong><span>{source==='environment'?copy("Environment override"):configured?copy("Saved locally"):copy("Host default login")}</span><span className="owb-config-edit">{copy("Edit")}</span></summary>
      <fieldset disabled={busy||formBlocked}><legend className="owb-config-sr">{host}</legend>
       {source==='environment'?<p className="owb-settings-module__hint">{copy("The launch environment supplies this whole Host connection; saved credentials and endpoints are not mixed with it.")}</p>:null}
       {CREDENTIAL_FIELDS.filter(f=>f.host===host).map(f=>{const row=snapshot.credentials.find(v=>v.key===f.key),url=f.key.endsWith('_BASE_URL');if(url)return <div key={f.key}>{input(`${host} ${t(f.label)}`,['hosts',id,'baseUrl'],hostConfig.baseUrl,'https://api.example.com')}</div>;const path=['hosts',id,refFields[f.key]!];return <div key={f.key} className="owb-config-secret"><label htmlFor={`config-${f.key}`}>{t(f.label)}</label><span className="owb-settings-module__hint">{row?.configured?copy('Configured · ••••{last4}').replace('{last4}',row.last4??''):copy("No saved credential")}</span><input id={`config-${f.key}`} ref={node=>{if(node)secretInputs.current.set(f.key,node);else secretInputs.current.delete(f.key);}} className="ant-input" type="password" autoComplete="new-password" spellCheck={false} maxLength={8192} disabled={busy||!snapshot.storageAvailable||formBlocked||clearKeys.has(f.key)} placeholder={copy("Leave blank to retain")} onInput={()=>secretChanged(f.key,path,`secret:host/${f.key}`)}/>
        {row?.configured?<label className="owb-config-checkbox"><input type="checkbox" checked={clearKeys.has(f.key)} onChange={()=>clearSecret(f.key,path,(snapshot.config.hosts[id] as Record<string,string|undefined>)[refFields[f.key]!])}/>{copy("Explicitly clear this credential")}</label>:null}</div>;})}
       <p className="owb-settings-module__hint">{copy("Blank retains the saved value. Inputs clear only after a successful save. Saved locally does not verify remote authentication.")}</p>
       <Button type="primary" disabled={busy||!dirty||formInvalid} loading={busy} onClick={()=>void save()}>{copy("Save configuration")}</Button>
      </fieldset>
     </details>;})}
    </section>
    <section id="settings-panel-services" role="tabpanel" aria-labelledby="settings-tab-services" hidden={category!=='services'}>
     <fieldset disabled={busy||formBlocked}><legend>{copy("Docs and memory configuration")}</legend>
      {(['doc','mem'] as const).map(kind=>{const entry=config.services[kind],name=kind==='doc'?'Doc':'Mem',key=`service:${kind}`;return <section key={kind} className="owb-config-service"><h3>{name}</h3><p className="owb-settings-module__hint">{snapshot.sources[`services.${kind}`]==='environment-after-restart'?copy('Launch defaults apply after restart; the current connection is retained'):snapshot.sources[`services.${kind}`]==='configuration'?copy("Saved connection settings"):copy("Launch environment defaults; enter an address to save an override")}</p>
       <label className="owb-config-field"><span>{name} API URL</span><Input value={entry?.apiUrl??''} onChange={e=>{if(e.target.value)field(['services',kind],{...(entry??{}),apiUrl:e.target.value});else field(['services',kind],null);}} placeholder={kind==='doc'?'http://localhost:3100':'http://localhost:8080'} spellCheck={false}/></label>
       {entry?<>{input(`${name} Web URL`,['services',kind,'webUrl'],entry.webUrl)}{kind==='mem'?input('Mem workspace UUID',['services','mem','workspaceId'],entry.workspaceId):null}</>:null}
        <div className="owb-config-secret"><label htmlFor={`config-${kind}-token`}>{name} Token</label><span className="owb-settings-module__hint">{entry?.tokenRef?copy("Encrypted credential reference"):copy("No credential reference")}</span><input id={`config-${kind}-token`} ref={node=>{if(node)secretInputs.current.set(key,node);else secretInputs.current.delete(key);}} className="ant-input" type="password" autoComplete="new-password" maxLength={8192} disabled={busy||!snapshot.storageAvailable||clearKeys.has(key)||!entry||formBlocked} placeholder={copy("Leave blank to retain")} onInput={()=>secretChanged(key,['services',kind,'tokenRef'],`secret:service/${kind}`)}/>
         {snapshot.config.services[kind]?.tokenRef?<label className="owb-config-checkbox"><input type="checkbox" checked={clearKeys.has(key)} onChange={()=>clearSecret(key,['services',kind,'tokenRef'],snapshot.config.services[kind]?.tokenRef)}/>{copy("Explicitly clear token")}</label>:null}</div>
       {entry?<Button onClick={()=>field(['services',kind],null)}>{copy('Disconnect {name} on save').replace('{name}',name)}</Button>:<Button onClick={()=>field(['services',kind],undefined)}>{copy("Restore launch defaults after restart")}</Button>}
      </section>;})}
      <p className="owb-settings-module__hint">{copy("Service forms and the file view share this draft. Save before checking connectivity. Changing an API URL requires updating or clearing its token.")}</p>
     </fieldset>
     <ServiceConnections operationsOnly />
    </section>
    <section id="settings-panel-updates" role="tabpanel" aria-labelledby="settings-tab-updates" hidden={category!=='updates'}>{updates}</section>
    <section id="settings-panel-advanced" role="tabpanel" aria-labelledby="settings-tab-advanced" hidden={category!=='advanced'}>
     <div className="owb-config-file-head"><div><h2>{copy("Application configuration")}</h2><p className="owb-settings-module__hint"><code>{snapshot.filePath}</code></p></div><Button onClick={()=>void window.owb.configuration!.openLocation()}>{copy("Open location")}</Button></div>
     <p className="owb-settings-module__hint">{copy("JSONC supports comments. It contains app preferences, non-secret connection fields and encrypted references. Workspaces continue to own business data.")}</p>
     <div className="owb-config-view"><Button type={view==='form'?'primary':'default'} onClick={()=>setView('form')}>{copy("Form")}</Button><Button type={view==='file'?'primary':'default'} onClick={()=>setView('file')}>{copy("Configuration file")}</Button></div>
     <div hidden={view!=='form'}><p>{copy("Use the categories above to edit this same configuration. Switching to the file view retains the draft and comments.")}</p><dl className="owb-config-summary">{['appearance','chat','runtime','hosts','services'].map(key=><div key={key}><dt>{key}</dt><dd><code>{JSON.stringify(config[key as keyof ApplicationConfiguration])}</code></dd></div>)}</dl></div>
     <div hidden={view!=='file'}><label htmlFor="roleweave-configuration-editor" className="owb-config-editor-label">roleweave.config.jsonc</label><Input.TextArea id="roleweave-configuration-editor" aria-label="roleweave.config.jsonc" className="owb-config-editor" value={text} onChange={e=>{setText(e.target.value);setNotice(null);}} spellCheck={false} autoSize={false} disabled={busy} /></div>
     <div className="owb-config-file-actions"><Button disabled={busy} onClick={()=>{void window.owb.configuration!.validate(text).then(r=>{setIssues(r.ok?[]:r.errors??[]);setNotice(r.ok?'valid':null);});}}>{copy("Validate")}</Button><Button disabled={busy||dirty||!snapshot.canRestore} onClick={()=>Modal.confirm({title:copy("Restore the previous configuration?"),content:copy("The current configuration becomes the backup. Credentials remain encrypted references; the app will not restart automatically."),okText:copy("Restore"),cancelText:copy("Cancel"),onOk:()=>restore()})}>{copy("Restore previous")}</Button></div>
    </section>
   </>:null}
  </div>
  {snapshot?<footer className="owb-config-savebar"><span role="status">{notice==='services-restart'?copy('Saved · Launch default connections apply after restart; current connections are retained'):notice==='restart'?copy("Saved · Runtime / Host changes require restart"):notice==='services-pending'?copy("Saved. Live services are unavailable; check or retry the connection."):notice==='saved'?copy("Configuration saved"):notice==='valid'?copy("Configuration valid"):dirty?copy("Unsaved changes"):snapshot.servicesRestartRequired?copy('Saved · Launch default connections apply after restart; current connections are retained'):snapshot.pendingRestart?copy("Saved · Runtime / Host changes require restart"):copy("Configuration is up to date")}</span><Button disabled={busy||!dirty||formInvalid||validatedText!==text} onClick={()=>setPreview(true)}>{copy("Preview changes")}</Button><Button type="primary" disabled={busy||!dirty} loading={busy} onClick={()=>void save()}>{copy("Save configuration")}</Button></footer>:null}
  <Modal open={preview} title={copy("Preview changes")} onCancel={()=>setPreview(false)} footer={<Button onClick={()=>setPreview(false)}>{copy("Back to editing")}</Button>} width={720}>
   {changes.map(row=><div className="owb-config-diff" key={row.field}><code>{row.field}</code><span>{display(row.before)} → {display(row.after)}</span></div>)}
   {[...secretInputs.current].map(([key,input])=><div key={key} className="owb-config-diff"><code>{key}</code><span>{clearKeys.has(key)?copy("Clear"):input.value?copy("Update"):copy("Retain")}</span></div>)}
   {!changes.length&&!hasSecretChanges?<p>{copy("Only comments or formatting changed.")}</p>:null}
  </Modal>
  <Modal open={!!conflict} title={copy("Configuration changed on disk")} onCancel={()=>setConflict(null)} footer={<><Button onClick={()=>{if(conflict){accept(conflict);resetSecrets();}}}>{copy("Reload disk and discard draft")}</Button><Button danger loading={busy} onClick={()=>void save(conflict?.revision)}>{copy("Overwrite this version")}</Button><Button onClick={()=>setConflict(null)}>{copy("Keep editing")}</Button></>} width={720}>
   <p>{copy("Current disk values → your draft. Overwrite checks the disk revision again.")}</p>
   {conflict&&config?differences(conflict.config,config).map(row=><div key={row.field} className="owb-config-diff"><code>{row.field}</code><span>{display(row.before)} → {display(row.after)}</span></div>):null}
  </Modal>
  <Modal open={leaveOpen} title={copy("Unsaved settings")} onCancel={()=>{pendingAction.current=null;setLeaveOpen(false);}} footer={<><Button type="primary" loading={busy} onClick={()=>void saveAndProceed()}>{copy("Save and leave")}</Button><Button disabled={busy} danger onClick={discardAndProceed}>{copy("Discard and leave")}</Button><Button onClick={()=>{pendingAction.current=null;setLeaveOpen(false);}}>{copy("Keep editing")}</Button></>}>
   <p>{copy("Save, discard, or keep editing. Saving configuration does not interrupt running tasks.")}</p>
  </Modal>
 </section>;
}
