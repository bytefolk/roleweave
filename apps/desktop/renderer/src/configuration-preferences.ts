import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ApplicationConfiguration, ConfigurationSnapshot, ConfigurationBridge } from './configuration-types';
export const CONFIGURATION_APPLIED = 'owb:configuration-applied';
export const CONFIGURATION_ERROR = 'owb:configuration-error';
let current: ApplicationConfiguration | null = null;
let bridge: ConfigurationBridge | undefined;
let boot: Promise<void> | null = null;
let edits: Promise<unknown> = Promise.resolve();
const listeners = new Set<()=>void>();
let leaveHandler: ((proceed:()=>void)=>void) | null = null;
const temporaryFocus = new Map<string,boolean>();
const subscribe = (listener:()=>void) => {listeners.add(listener);return()=>{listeners.delete(listener);};};
function notify() {for(const listener of listeners)listener();}
function legacyPreferences() {
  try {return {mode:window.localStorage.getItem('owb.theme-mode')??'system',profile:window.localStorage.getItem('owb.theme-profile')??'mint',locale:window.localStorage.getItem('owb-locale')??'zh-CN'};}
  catch{return {};}
}
export function applyConfiguration(snapshot:ConfigurationSnapshot):void {
  current=snapshot.config;
  const appearance=current.appearance;
  const mode=appearance.mode==='system'?(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light'):appearance.mode;
  document.documentElement.setAttribute('data-theme',mode);
  document.documentElement.setAttribute('data-ui-theme',appearance.profile);
  // Compatibility cache for pre-paint boot and older previews. The main-process
  // JSONC is authoritative; this cache is updated only after a successful save.
  try {
    if(appearance.mode==='system')window.localStorage.removeItem('owb.theme-mode');else window.localStorage.setItem('owb.theme-mode',appearance.mode);
    window.localStorage.setItem('owb.theme-profile',appearance.profile);
    window.localStorage.setItem('owb-locale',appearance.locale);
  }catch{ /* A disabled renderer cache must not prevent durable preferences. */ }
  notify();window.dispatchEvent(new CustomEvent(CONFIGURATION_APPLIED,{detail:snapshot.config}));
}
export async function initializeConfiguration():Promise<void> {
  if(bridge!==window.owb?.configuration){bridge=window.owb?.configuration;boot=null;current=null;temporaryFocus.clear();}
  if(!bridge)return;
  const api=bridge;
  if(!boot)boot=(async()=>{
    const result=await api.migratePreferences(legacyPreferences());
    if(!result.ok)throw Error('Configuration could not be loaded.');
    applyConfiguration(result);
  })().catch(()=>{window.dispatchEvent(new Event(CONFIGURATION_ERROR));boot=null;});
  return boot;
}
export function persistApplicationPreference(patch:Record<string,unknown>):Promise<void> {
  const task=async()=>{
    await initializeConfiguration();const api=window.owb?.configuration;if(!api)return;
    const result=await api.preferences(patch);
    if(!result.ok)throw Error('Configuration could not be saved.');applyConfiguration(result);
  };
  const next=edits.then(task,task);edits=next.catch(()=>{});return next;
}
export function preferenceError():void {window.dispatchEvent(new Event(CONFIGURATION_ERROR));}
export function useConfigurationBootstrap(onLocale:(locale:'zh-CN'|'en')=>void):void {
  useEffect(()=>{
    const locale=()=>{if(current)onLocale(current.appearance.locale);};
    const off=subscribe(locale);void initializeConfiguration().then(locale);
    const close=window.owb?.configuration?.onCloseRequested(()=>requestSettingsLeave(()=>{void window.owb.configuration?.confirmClose();}));
    return()=>{off();close?.();};
  },[onLocale]);
}
export function useSendShortcut():'enter'|'mod-enter' {
  useEffect(()=>{void initializeConfiguration();},[]);
  return useSyncExternalStore(subscribe,()=>current?.chat.sendShortcut??'enter',()=>'enter');
}
export function useWorkspaceFocus(workspaceId:string):[boolean,(focused:boolean)=>void] {
  useEffect(()=>{void initializeConfiguration();},[]);
  const focused=useSyncExternalStore(subscribe,()=>temporaryFocus.get(workspaceId)??current?.layouts.focusByWorkspace[workspaceId]??false,()=>false);
  const setFocused=(value:boolean)=>{
    if(!workspaceId)return;
    if(!window.owb.configuration||current?.chat.rememberLayout===false){temporaryFocus.set(workspaceId,value);notify();return;}
    // Apply a single entry using the current disk snapshot, preserving layouts
    // from other workspaces. A failed disk save keeps the current layout.
    edits=edits.then(async()=>{
      const api=window.owb.configuration;if(!api)return;
      const snapshot=await (api.getPreferences?.()??api.get());if(!snapshot.ok)throw Error();
      const entries={...snapshot.config.layouts.focusByWorkspace,[workspaceId]:value};
      const keys=Object.keys(entries);for(const key of keys.slice(0,Math.max(0,keys.length-256)))delete entries[key];
      const result=await api.preferences({layouts:{focusByWorkspace:entries}});
      if(!result.ok)throw Error();temporaryFocus.delete(workspaceId);applyConfiguration(result);
    }).catch(preferenceError);
  };
  return[focused,setFocused];
}
export function registerSettingsLeave(handler:(proceed:()=>void)=>void):()=>void {
  leaveHandler=handler;return()=>{if(leaveHandler===handler)leaveHandler=null;};
}
export function requestSettingsLeave(proceed:()=>void):void {if(leaveHandler)leaveHandler(proceed);else proceed();}
export function usePreferenceSaveError():boolean {
  const[failed,setFailed]=useState(false);
  useEffect(()=>{const fail=()=>setFailed(true),ok=()=>setFailed(false);window.addEventListener(CONFIGURATION_ERROR,fail);window.addEventListener(CONFIGURATION_APPLIED,ok);return()=>{window.removeEventListener(CONFIGURATION_ERROR,fail);window.removeEventListener(CONFIGURATION_APPLIED,ok);};},[]);
  return failed;
}
