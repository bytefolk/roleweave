import { configurationText, configurationGroups } from '../locales/configuration';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Input, Modal, Select, Spin } from 'antd';
import { Bell, CircleCheck, Files, Info, Terminal, FlaskConical, HardDrive, Palette, PlugZap, RefreshCw, SlidersHorizontal, Wrench } from 'lucide-react';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { useT, useOwbLocale } from '@roleweave/ui';
import type { ApplicationConfiguration, ConfigurationSnapshot, ConfigurationIssue, ConfigurationChange, ConfigurationSave } from '../configuration-types';
import { applyConfiguration, registerSettingsLeave, CONFIGURATION_APPLIED } from '../configuration-preferences';
import { CREDENTIAL_FIELDS, type CredentialKey } from './credential-settings';
import { ServiceConnections } from './ServiceConnections';
import './configuration-settings.css';
import { ExperimentalSettings } from './ExperimentalSettings';
import { ThemeSettings } from '../theme-settings';
import type { ExperimentScope } from '../experiments/useWorkspaceExperiments';
const groups = configurationGroups;
export type ConfigurationCategory = typeof groups[number][0];
type Category = ConfigurationCategory;
const categoryIcons: Record<ConfigurationCategory, ReactNode> = {
 general: <SlidersHorizontal aria-hidden="true" />,
 agents: <PlugZap aria-hidden="true" />,
 services: <Files aria-hidden="true" />,
 updates: <RefreshCw aria-hidden="true" />,
 experiments: <FlaskConical aria-hidden="true" />,
 advanced: <Wrench aria-hidden="true" />,
};
const hostKeys={Qoder:'qoder',Claude:'claude',Codex:'codex',Gemini:'gemini'} as const;
const refFields:Partial<Record<CredentialKey,string>>={QODER_PERSONAL_ACCESS_TOKEN:'personalAccessTokenRef',ANTHROPIC_API_KEY:'apiKeyRef',ANTHROPIC_AUTH_TOKEN:'authTokenRef',OPENAI_API_KEY:'apiKeyRef',GEMINI_API_KEY:'apiKeyRef'};
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
function formatCacheBytes(bytes:number,locale:string):string {
 const unit=bytes<1024?'byte':bytes<1048576?'kilobyte':'megabyte';
 const divisor=unit==='byte'?1:unit==='kilobyte'?1024:1048576;
 return new Intl.NumberFormat(locale,{style:'unit',unit,maximumFractionDigits:1}).format(bytes/divisor);
}
export function ConfigurationSettings({updates, initialCategory, ...scope}:{updates:ReactNode; initialCategory?: ConfigurationCategory} & ExperimentScope) {
 const t=useT();const activeLocale=useOwbLocale();const[snapshot,setSnapshot]=useState<ConfigurationSnapshot|null>(null),[text,setText]=useState('');
 const[category,setCategory]=useState<Category>(initialCategory ?? 'general'),[view,setView]=useState<'form'|'file'>('form');
 useEffect(()=>{setCategory(initialCategory ?? 'general');},[initialCategory]);
 const[issues,setIssues]=useState<ConfigurationIssue[]>([]),[validatedText,setValidatedText]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[conflict,setConflict]=useState<ConfigurationSnapshot|null>(null);
 const[preview,setPreview]=useState(false),[leaveOpen,setLeaveOpen]=useState(false),[secretVersion,setSecretVersion]=useState(0);
 const[locationOpen,setLocationOpen]=useState(false),[selectedLocation,setSelectedLocation]=useState<string|null>(null);
 const[locationBusy,setLocationBusy]=useState(false),[locationError,setLocationError]=useState(false);
 const[cacheBytes,setCacheBytes]=useState<number|null>(null),[cacheBusy,setCacheBusy]=useState(false),[cacheError,setCacheError]=useState(false);
 const[notificationPermission,setNotificationPermission]=useState<NotificationPermission|'unsupported'>(()=>typeof Notification==='undefined'?'unsupported':Notification.permission);
 const[clearKeys,setClearKeys]=useState<Set<string>>(new Set());
 const secretInputs=useRef(new Map<string,HTMLInputElement>()),pendingAction=useRef<(()=>void)|null>(null);
 const validationSequence=useRef(0),saving=useRef(false),latestSave=useRef<()=>Promise<boolean>>(async()=>false);
 const parsed=useMemo(()=>{const errors:ParseError[]=[];const value=parse(text,errors,{allowTrailingComma:true}) as ApplicationConfiguration|undefined;return{value,errors};},[text]);
 const object=(value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const strings=(value:unknown)=>object(value)&&Object.values(value as Record<string,unknown>).every(v=>typeof v==='string');
 const formShape=parsed.errors.length===0&&object(parsed.value?.appearance)&&['system','light','dark'].includes(parsed.value?.appearance?.mode??'')&&['mint','default'].includes(parsed.value?.appearance?.profile??'')&&['en','zh-CN'].includes(parsed.value?.appearance?.locale??'')&&object(parsed.value?.chat)&&['enter','mod-enter'].includes(parsed.value?.chat?.sendShortcut??'')&&typeof parsed.value?.chat?.rememberLayout==='boolean'&&object(parsed.value?.hosts)&&(['qoder','claude','codex','gemini'] as const).every(h=>parsed.value?.hosts?.[h]===undefined||strings(parsed.value?.hosts?.[h]))&&object(parsed.value?.services)&&Object.values(parsed.value?.services??{}).every(v=>v===null||strings(v))&&strings(parsed.value?.runtime);
 const config=formShape?parsed.value:snapshot?.config;
 const english=((config??snapshot?.config)?.appearance.locale??activeLocale)==='en';const copy=(en:string)=>configurationText(english,en);
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
 function secretChanged(key:string,path:(string|number)[],reference:string,originalRef?:string){
  const input=secretInputs.current.get(key);
  if(input?.value){
   field(path,reference);
   setClearKeys(current=>{const next=new Set(current);next.delete(key);return next;});
  }else{
   field(path,originalRef);
  }
  setSecretVersion(v=>v+1);
 }
 function clearSecret(key:string,path:(string|number)[],reference?:string){
  const willUnclear=clearKeys.has(key);
  if(willUnclear){
   if(reference)field(path,reference);
  }else{
   const secretInput=secretInputs.current.get(key);
   if(secretInput)secretInput.value='';
   field(path,undefined);
  }
  setClearKeys(current=>{
   const next=new Set(current);
   if(willUnclear)next.delete(key);
   else next.add(key);
   return next;
  });
  setSecretVersion(v=>v+1);
 }
 function request():ConfigurationSave{
  const hostChanges:ConfigurationSave['hostChanges']={},serviceChanges:ConfigurationSave['serviceChanges']={};
  for(const[key,input]of secretInputs.current){
   if(clearKeys.has(key))continue;
   const value=input.value;
   if(value==='')continue;
   if(key.startsWith('service:'))serviceChanges[key.slice(8) as 'doc'|'mem']=value;
   else hostChanges[key as CredentialKey]=value;
  }
  for(const key of clearKeys){
   if(key.startsWith('service:'))serviceChanges[key.slice(8) as 'doc'|'mem']=null;
   else hostChanges[key as CredentialKey]=null;
  }
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
 const overview = config ? [
  [copy('Appearance'), `${copy(config.appearance.locale==='en'?'English':'Simplified Chinese')} · ${copy(config.appearance.mode==='system'?'System':config.appearance.mode==='dark'?'Dark':'Light')} · ${copy(config.appearance.profile==='mint'?'Mint':'Ant Blue')}`],
  [copy('Chat input'), `${config.chat.sendShortcut==='enter'?'Enter':'⌘ / Ctrl + Enter'} · ${copy(config.chat.rememberLayout?'Remember layout':'Do not remember layout')}`],
  [copy('Runtime'), config.runtime.mode==='wsl'?`WSL · ${config.runtime.distro||copy('Default distribution')}`:copy(config.runtime.mode==='native'?'Native':'Launch default')],
  [copy('Host connections'), Object.entries(hostKeys).map(([name,key])=>`${name}: ${copy(snapshot?.sources[`hosts.${key}`]==='environment'?'Environment override':Object.keys(config.hosts[key]??{}).length?'Saved locally':'Host default login')}`).join(' · ')],
  [copy('Docs and memory'), `Mem: ${config.services.mem?.apiUrl??copy(config.services.mem===null?'Disconnected':'Launch default')}`],
 ] : [];
 const input=(label:string,path:string[],value:string|undefined,placeholder?:string)=><label className="owb-config-field"><span>{label}</span><Input value={value??''} onChange={e=>field(path,e.target.value||undefined)} placeholder={placeholder} spellCheck={false} maxLength={4096} /></label>;
 async function browseProjectDirectory(){setLocationBusy(true);setLocationError(false);try{const result=await window.owb.configuration!.pickProjectDirectory();if('ok' in result&&result.ok)setSelectedLocation(result.path);else if(!('canceled' in result))setLocationError(true);}catch{setLocationError(true);}finally{setLocationBusy(false);}}
 async function readCache(){setCacheBusy(true);setCacheError(false);try{const result=await window.owb.configuration!.cacheInfo();if(result.ok)setCacheBytes(result.bytes);else setCacheError(true);}catch{setCacheError(true);}finally{setCacheBusy(false);}}
 return <section className="owb-settings-module owb-config-settings" aria-label={t('settings.moduleAria')}>
  <header className="owb-settings-module__header"><h1>{t('settings.title')}</h1></header>
  <div className="owb-config-tabs" role="tablist" aria-label={copy("Settings categories")}>
   {groups.map(([id,en])=><button type="button" key={id} id={`settings-tab-${id}`} role="tab" aria-selected={category===id} aria-controls={`settings-panel-${id}`} onClick={()=>setCategory(id)}>{categoryIcons[id]}<span>{copy(en)}</span></button>)}
  </div>
  <div className="owb-config-content">
   {loading?<div role="status"><Spin size="small" /> {copy("Loading settings…")}</div>:null}
   {error?<Alert type="error" showIcon title={errorCopy} action={!snapshot?<Button onClick={()=>void reload()}>{copy("Retry")}</Button>:undefined}/>:null}
   {snapshot?.warnings.map(message=><Alert key={message} type="warning" showIcon title={copy("Configuration recovery")} description={message}/>)}
   {snapshot?.storageAvailable===false?<Alert type="warning" showIcon title={copy("OS encrypted storage is unavailable. General preferences remain editable; unlock your keychain to change credentials.")}/>:null}
   {issues.length?<div role="alert" className="owb-config-errors">{issues.map((issue,i)=><p key={`${issue.field}-${i}`}>{copy("Line ")} {issue.line}:{issue.column} · <code>{issue.field}</code> — {issue.message}</p>)}</div>:null}
   {category==='experiments'?<section id="settings-panel-experiments" role="tabpanel" aria-labelledby="settings-tab-experiments"><div className="owb-config-intro"><h2>{copy("Experiments")}</h2><p>{copy("Preview features apply only to the current project.")}</p></div><ExperimentalSettings {...scope} /></section>:null}
   {snapshot&&config?<>
    <section id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={category!=='general'}>
     <div className="owb-config-intro"><h2>{copy("General")}</h2><p>{copy("Manage appearance, project storage and notifications.")}</p></div>
     <fieldset disabled={busy||formBlocked}><legend><Palette aria-hidden="true" />{copy("Appearance and input")}</legend>
      <label className="owb-config-field"><span>{copy("Language")}</span><Select aria-label={copy("Language")} value={config.appearance.locale} options={[{value:'zh-CN',label:copy('Simplified Chinese')},{value:'en',label:'English'}]} onChange={v=>field(['appearance','locale'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-field"><span>{copy("Theme")}</span><Select aria-label={copy("Theme")} value={config.appearance.mode} options={[{value:'system',label:copy("System")},{value:'light',label:copy("Light")},{value:'dark',label:copy("Dark")}]} onChange={v=>field(['appearance','mode'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-field"><span>{copy("Send shortcut")}<small>{copy("Composing text with an IME never sends a message.")}</small></span><Select aria-label={copy("Send shortcut")} value={config.chat.sendShortcut} options={[{value:'enter',label:'Enter'},{value:'mod-enter',label:'⌘ / Ctrl + Enter'}]} onChange={v=>field(['chat','sendShortcut'],v)} disabled={busy||formBlocked}/></label>
     </fieldset>
     {category==='general'?<details className="owb-config-theme"><summary>{copy("More appearance options")}</summary><div className="owb-config-extra-appearance">
      <label className="owb-config-field"><span>{copy("Color profile")}</span><Select aria-label={copy("Color profile")} value={config.appearance.profile} options={[{value:'mint',label:copy('Mint')},{value:'default',label:copy('Ant Blue')}]} onChange={v=>field(['appearance','profile'],v)} disabled={busy||formBlocked}/></label>
      <label className="owb-config-checkbox"><input type="checkbox" checked={config.chat.rememberLayout} disabled={busy||formBlocked} onChange={e=>field(['chat','rememberLayout'],e.target.checked)}/>{copy("Remember workspace conversation layout")}</label>
      <ThemeSettings />
     </div></details>:null}
     <fieldset className="owb-config-storage" disabled={busy||formBlocked}><legend><HardDrive aria-hidden="true" />{copy("Storage")}</legend>
      <div className="owb-config-setting-row"><div><strong>{copy("System cache directory")}</strong><p>{copy("Managed by the system · contains client cache")}</p></div><Button onClick={()=>void window.owb.configuration!.openCache().then(result=>{if(!result.ok)setCacheError(true);}).catch(()=>setCacheError(true))}>{copy("Open directory")}</Button></div>
      <div className="owb-config-setting-row"><div><strong>{copy("Cache usage")}</strong><p role="status">{cacheError?copy("Could not read cache usage"):cacheBytes===null?copy("Not calculated yet"):formatCacheBytes(cacheBytes,english?'en':'zh-CN')}</p></div><Button loading={cacheBusy} onClick={()=>void readCache()}>{copy("Check usage")}</Button></div>
      <div className="owb-config-setting-row"><div><strong>{copy("Default project location")}</strong><p>{config.storage?.projectDirectory??copy("Use system default location")}</p><small>{copy("Only affects new projects. Existing projects stay in their current locations.")}</small></div><Button onClick={()=>{setSelectedLocation(config.storage?.projectDirectory??null);setLocationError(false);setLocationOpen(true);}}>{copy("Change")}</Button></div>
     </fieldset>
     <fieldset className="owb-config-storage" disabled={busy||formBlocked}><legend><Bell aria-hidden="true" />{copy("Notifications")}</legend>
      <label className="owb-config-setting-row"><span><strong>{copy("Client notifications")}</strong><p>{copy("Show a system notification when a task completes")}</p></span><input type="checkbox" checked={config.notifications?.taskComplete??false} onChange={e=>{const enabled=e.target.checked;field(['notifications','taskComplete'],enabled);if(enabled&&notificationPermission==='default'&&typeof Notification!=='undefined')void Notification.requestPermission().then(setNotificationPermission).catch(()=>setNotificationPermission('denied'));}} /></label>
      {config.notifications?.taskComplete&&notificationPermission!=='granted'?<p className="owb-settings-module__hint" role="status">{copy("System notification permission is not granted.")}</p>:null}
     </fieldset>
    </section>
    <section id="settings-panel-agents" role="tabpanel" aria-labelledby="settings-tab-agents" hidden={category!=='agents'}>
     <div className="owb-config-intro"><h2>{copy("Agent connections")}</h2><p>{copy("Manage runtime and encrypted Host credentials. Changes apply after restart.")}</p></div>
     <fieldset className="owb-config-card owb-config-runtime" disabled={busy||formBlocked}><legend><Terminal aria-hidden="true" />{copy("Project and Agent runtime")}</legend>
      {snapshot.platform==='win32'?<><label className="owb-config-field"><span>{copy("Runtime")}</span><Select aria-label={copy("Runtime")} value={config.runtime.mode??'default'} options={[{value:'default',label:copy("Launch default")},{value:'native',label:'Windows'},{value:'wsl',label:'WSL'}]} onChange={v=>field(['runtime','mode'],v==='default'?undefined:v)} disabled={busy||formBlocked}/></label>
       <div className="owb-config-runtime-fields">{input(copy('WSL distribution'),['runtime','distro'],config.runtime.distro,'Ubuntu')}{input(copy('WSL Node path'),['runtime','nodePath'],config.runtime.nodePath,'/usr/bin/node')}{input(copy('WSL home'),['runtime','homePath'],config.runtime.homePath,'/home/example')}</div>
       {Object.entries(snapshot.sources).filter(([key,v])=>key.startsWith('runtime.')&&v==='environment').map(([key])=><p key={key} className="owb-settings-module__hint"><code>{key}</code> · {copy("Environment override takes precedence")}</p>)}
      </>:<p>{copy("This platform uses the native runtime. WSL settings apply only on Windows.")}</p>}
      <p className="owb-settings-module__hint">{copy("Runtime and Host credentials apply after restart. Saving never interrupts a running task or changes an employee’s Agent binding.")}</p>
     </fieldset>
     <div className="owb-config-card owb-config-hosts"><h3><PlugZap aria-hidden="true" />{copy('Host connections')}</h3>
     {(['Qoder','Claude','Codex','Gemini'] as const).map(host=>{const id=hostKeys[host],hostConfig=(config.hosts[id]??{}) as Record<string,string|undefined>,configured=Object.keys(hostConfig).length>0,source=snapshot.sources[`hosts.${id}`],hostDirty=changes.some(change=>change.field.startsWith(`hosts.${id}`))||CREDENTIAL_FIELDS.some(f=>f.host===host&&(!!secretInputs.current.get(f.key)?.value||clearKeys.has(f.key)));return <details key={host} className="owb-config-host">
      <summary><span className="owb-config-host-label"><strong>{host}</strong><small>{source==='environment'?copy("Environment override"):configured?copy("Saved locally"):copy("Host default login")}</small></span><span className={`owb-config-host-status${hostDirty?'':source==='environment'?' is-environment':configured?' is-saved':''}`}>{hostDirty?copy('Unsaved changes'):source==='environment'?copy("Environment override"):configured?copy("Saved locally"):copy("Host default login")}</span><span className="owb-config-edit">{copy("Edit")}</span></summary>
      <fieldset disabled={busy||formBlocked}><legend className="owb-config-sr">{host}</legend>
       {source==='environment'?<p className="owb-settings-module__hint">{copy("The launch environment supplies this whole Host connection; saved credentials and endpoints are not mixed with it.")}</p>:null}
        {CREDENTIAL_FIELDS.filter(f=>f.host===host).map(f=>{const row=snapshot.credentials.find(v=>v.key===f.key),url=f.key.endsWith('_BASE_URL');if(url)return <div key={f.key}>{input(`${host} ${t(f.label)}`,['hosts',id,'baseUrl'],hostConfig.baseUrl,'https://api.example.com')}</div>;const path=['hosts',id,refFields[f.key]!],originalRef=(snapshot.config.hosts[id] as Record<string,string|undefined>)?.[refFields[f.key]!];return <div key={f.key} className="owb-config-secret"><label htmlFor={`config-${f.key}`}>{t(f.label)}</label><span className="owb-settings-module__hint">{row?.configured?copy('Configured · ••••{last4}').replace('{last4}',row.last4??''):copy("No saved credential")}</span><input id={`config-${f.key}`} ref={node=>{if(node)secretInputs.current.set(f.key,node);else secretInputs.current.delete(f.key);}} className="ant-input" type="password" autoComplete="new-password" spellCheck={false} maxLength={8192} disabled={busy||!snapshot.storageAvailable||formBlocked||clearKeys.has(f.key)} placeholder={copy("Leave blank to retain")} onInput={()=>secretChanged(f.key,path,`secret:host/${f.key}`,originalRef)}/>
        {row?.configured?<label className="owb-config-checkbox"><input type="checkbox" checked={clearKeys.has(f.key)} onChange={()=>clearSecret(f.key,path,(snapshot.config.hosts[id] as Record<string,string|undefined>)?.[refFields[f.key]!] ?? `secret:host/${f.key}`)}/>{copy("Explicitly clear this credential")}</label>:null}</div>;})}
       <p className="owb-settings-module__hint">{copy("Blank retains the saved value. Inputs clear only after a successful save. Saved locally does not verify remote authentication.")}</p>
      </fieldset>
     </details>;})}
     </div><p className="owb-config-info"><Info aria-hidden="true" />{copy("Credentials are stored encrypted. Saved settings do not verify remote authentication.")}</p>
    </section>
    <section id="settings-panel-services" role="tabpanel" aria-labelledby="settings-tab-services" hidden={category!=='services'}>
     <div className="owb-config-intro"><h2>{copy("Docs and memory")}</h2><p>{copy("Configure Doc and Mem connections and check their saved connection status.")}</p></div>
     <ServiceConnections actionsDisabled={dirty||busy||formBlocked} renderConnection={(kind,operations)=>{const entry=config.services[kind],name=kind==='doc'?'Doc':'Mem',key=`service:${kind}`,originalTokenRef=snapshot.config.services[kind]?.tokenRef;return <section className="owb-config-card owb-config-service"><h3><Files aria-hidden="true" />{name} {copy("Connection")}</h3><fieldset disabled={busy||formBlocked}><p className="owb-settings-module__hint">{snapshot.sources[`services.${kind}`]==='environment-after-restart'?copy('Launch defaults apply after restart; the current connection is retained'):snapshot.sources[`services.${kind}`]==='configuration'?copy("Saved connection settings"):copy("Launch environment defaults; enter an address to save an override")}</p>
       <label className="owb-config-field"><span>{name} API URL</span><Input value={entry?.apiUrl??''} onChange={e=>{if(e.target.value)field(['services',kind],{...(entry??{}),apiUrl:e.target.value});else field(['services',kind],null);}} placeholder={kind==='doc'?'http://localhost:3100':'http://localhost:8080'} spellCheck={false}/></label>
       {input(`${name} Web URL`,['services',kind,'webUrl'],entry?.webUrl)}{kind==='mem'?input('Mem workspace UUID',['services','mem','workspaceId'],entry?.workspaceId):null}
        <div className="owb-config-secret"><label htmlFor={`config-${kind}-token`}>{name} Token</label><span className="owb-settings-module__hint">{entry?.tokenRef?copy("Encrypted credential reference"):copy("No credential reference")}</span><input id={`config-${kind}-token`} ref={node=>{if(node)secretInputs.current.set(key,node);else secretInputs.current.delete(key);}} className="ant-input" type="password" autoComplete="new-password" maxLength={8192} disabled={busy||!snapshot.storageAvailable||clearKeys.has(key)||!entry||formBlocked} placeholder={copy("Leave blank to retain")} onInput={()=>secretChanged(key,['services',kind,'tokenRef'],`secret:service/${kind}`,originalTokenRef)}/>
         {snapshot.config.services[kind]?.tokenRef?<label className="owb-config-checkbox"><input type="checkbox" checked={clearKeys.has(key)} onChange={()=>clearSecret(key,['services',kind,'tokenRef'],snapshot.config.services[kind]?.tokenRef ?? `secret:service/${kind}`)}/>{copy("Explicitly clear token")}</label>:null}</div>
       {entry?<Button onClick={()=>{field(['services',kind],null);const secretInput=secretInputs.current.get(key);if(secretInput)secretInput.value='';setClearKeys(c=>{const n=new Set(c);n.delete(key);return n;});setSecretVersion(v=>v+1);}}>{copy('Disconnect {name} on save').replace('{name}',name)}</Button>:<Button onClick={()=>{field(['services',kind],undefined);const secretInput=secretInputs.current.get(key);if(secretInput)secretInput.value='';setClearKeys(c=>{const n=new Set(c);n.delete(key);return n;});setSecretVersion(v=>v+1);}}>{copy("Restore launch defaults after restart")}</Button>}
      </fieldset>{operations}</section>;}} />
      <p className="owb-config-info"><Info aria-hidden="true" />{copy("Service forms and the file view share this draft. Save before checking connectivity. Changing an API URL requires updating or clearing its token.")}</p>
    </section>
    <section id="settings-panel-updates" role="tabpanel" aria-labelledby="settings-tab-updates" hidden={category!=='updates'}><div className="owb-config-intro"><h2>{copy("Updates")}</h2><p>{copy("Check application updates and inspect the current runtime.")}</p></div>{updates}</section>
    <section id="settings-panel-advanced" role="tabpanel" aria-labelledby="settings-tab-advanced" hidden={category!=='advanced'}>
     <div className="owb-config-intro"><h2>{copy("Advanced")}</h2><p>{copy("Edit the same draft using the form overview or JSONC file.")}</p></div>
     <div className="owb-config-file-head"><div><h2>{copy("Application configuration")}</h2><p className="owb-settings-module__hint"><code>{snapshot.filePath}</code></p></div><Button onClick={()=>void window.owb.configuration!.openLocation()}>{copy("Open location")}</Button></div>
     <p className="owb-settings-module__hint">{copy("JSONC supports comments. It contains app preferences, non-secret connection fields and encrypted references. Workspaces continue to own business data.")}</p>
     <div className="owb-config-view"><Button type={view==='form'?'primary':'default'} onClick={()=>setView('form')}>{copy("Form")}</Button><Button type={view==='file'?'primary':'default'} onClick={()=>setView('file')}>{copy("Configuration file")}</Button></div>
     <div hidden={view!=='form'} className="owb-config-card"><h3><SlidersHorizontal aria-hidden="true" />{copy("Configuration overview")}</h3><dl className="owb-config-summary">{overview.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="owb-settings-module__hint">{copy("Use the categories above to edit this same configuration. Switching to the file view retains the draft and comments.")}</p></div>
     <div hidden={view!=='file'} className="owb-config-file-card"><label htmlFor="roleweave-configuration-editor" className="owb-config-editor-label">roleweave.config.jsonc</label><Input.TextArea id="roleweave-configuration-editor" aria-label="roleweave.config.jsonc" className="owb-config-editor" value={text} onChange={e=>{setText(e.target.value);setNotice(null);}} spellCheck={false} autoSize={false} disabled={busy} /></div>
     <div className="owb-config-file-actions"><Button disabled={busy} onClick={()=>{void window.owb.configuration!.validate(text).then(r=>{setIssues(r.ok?[]:r.errors??[]);setNotice(r.ok?'valid':null);}).catch(()=>setError('validate'));}}>{copy("Validate")}</Button><Button disabled={busy||dirty||!snapshot.canRestore} onClick={()=>Modal.confirm({className:"owb-config-modal",title:copy("Restore the previous configuration?"),content:copy("The current configuration becomes the backup. Credentials remain encrypted references; the app will not restart automatically."),okText:copy("Restore"),cancelText:copy("Cancel"),onOk:()=>restore()})}>{copy("Restore previous")}</Button></div>
    </section>
   </>:null}
  </div>
  {snapshot&&category!=='experiments'?<footer className="owb-config-savebar"><span role="status"><CircleCheck aria-hidden="true" size={16} />{notice==='services-restart'?copy('Saved · Launch default connections apply after restart; current connections are retained'):notice==='restart'?copy("Saved · Runtime / Host changes require restart"):notice==='services-pending'?copy("Saved. Live services are unavailable; check or retry the connection."):notice==='saved'?copy("Configuration saved"):notice==='valid'?copy("Configuration valid"):dirty?copy("Unsaved changes"):snapshot.servicesRestartRequired?copy('Saved · Launch default connections apply after restart; current connections are retained'):snapshot.pendingRestart?copy("Saved · Runtime / Host changes require restart"):copy("Configuration is up to date")}</span><Button disabled={busy||!dirty||formInvalid||validatedText!==text} onClick={()=>setPreview(true)}>{copy("Preview changes")}</Button><Button type="primary" disabled={busy||!dirty} loading={busy} onClick={()=>void save()}>{copy("Save configuration")}</Button></footer>:null}
  <Modal className="owb-config-modal" open={preview} title={copy("Preview changes")} onCancel={()=>setPreview(false)} footer={<Button onClick={()=>setPreview(false)}>{copy("Back to editing")}</Button>} width={720}>
   {changes.map(row=><div className="owb-config-diff" key={row.field}><code>{row.field}</code><span>{display(row.before)} → {display(row.after)}</span></div>)}
   {[...new Set([...secretInputs.current.keys(),...clearKeys])].filter(key=>clearKeys.has(key)||!!secretInputs.current.get(key)?.value).map(key=>{const secretInput=secretInputs.current.get(key);return <div key={key} className="owb-config-diff"><code>{key}</code><span>{clearKeys.has(key)?copy("Clear"):secretInput?.value?copy("Update"):copy("Retain")}</span></div>;})}
   {!changes.length&&!hasSecretChanges?<p>{copy("Only comments or formatting changed.")}</p>:null}
  </Modal>
  <Modal className="owb-config-modal" open={locationOpen} title={copy("Change default project location")} onCancel={()=>setLocationOpen(false)} footer={<><Button onClick={()=>setLocationOpen(false)}>{copy("Cancel")}</Button><Button type="primary" disabled={locationBusy||selectedLocation===(config?.storage?.projectDirectory??null)} onClick={()=>{field(['storage','projectDirectory'],selectedLocation??undefined);setLocationOpen(false);}}>{copy("Save location")}</Button></>} width={580}>
   <p>{copy("New projects will use the selected directory as the starting location. Existing projects will not move.")}</p>
   <div className="owb-config-location"><strong>{copy("Current default location")}</strong><span>{config?.storage?.projectDirectory??copy("Use system default location")}</span></div>
   <div className="owb-config-location"><strong>{copy("Choose a new location")}</strong><div><span>{selectedLocation??copy("No folder selected")}</span><Button loading={locationBusy} onClick={()=>void browseProjectDirectory()}>{copy("Browse…")}</Button></div></div>
   {selectedLocation?<Button type="link" onClick={()=>setSelectedLocation(null)}>{copy("Use system default location")}</Button>:null}
   {locationError?<p role="alert">{copy("Could not select a folder. Try again.")}</p>:null}
  </Modal>
  <Modal className="owb-config-modal" open={!!conflict} title={copy("Configuration changed on disk")} onCancel={()=>setConflict(null)} footer={<><Button onClick={()=>{if(conflict){accept(conflict);resetSecrets();}}}>{copy("Reload disk and discard draft")}</Button><Button danger loading={busy} onClick={()=>void save(conflict?.revision)}>{copy("Overwrite this version")}</Button><Button onClick={()=>setConflict(null)}>{copy("Keep editing")}</Button></>} width={720}>
   <p>{copy("Current disk values → your draft. Overwrite checks the disk revision again.")}</p>
   {conflict&&config?differences(conflict.config,config).map(row=><div key={row.field} className="owb-config-diff"><code>{row.field}</code><span>{display(row.before)} → {display(row.after)}</span></div>):null}
  </Modal>
  <Modal className="owb-config-modal" open={leaveOpen} title={copy("Unsaved settings")} onCancel={()=>{pendingAction.current=null;setLeaveOpen(false);}} footer={<><Button type="primary" loading={busy} onClick={()=>void saveAndProceed()}>{copy("Save and leave")}</Button><Button disabled={busy} danger onClick={discardAndProceed}>{copy("Discard and leave")}</Button><Button onClick={()=>{pendingAction.current=null;setLeaveOpen(false);}}>{copy("Keep editing")}</Button></>}>
   <p>{copy("Save, discard, or keep editing. Saving configuration does not interrupt running tasks.")}</p>
  </Modal>
 </section>;
}
