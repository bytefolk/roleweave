import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationSettings } from '../src/settings/ConfigurationSettings';
import { ThemeProvider } from '../src/theme-context';
import { useThemeMode } from '../src/theme-toggle';
import { applyConfiguration, initializeConfiguration } from '../src/configuration-preferences';
import type { ConfigurationSnapshot } from '../src/configuration-types';
const { createConfigurationStore, validateConfigurationText } = createRequire(import.meta.url)('../../src/configuration.cjs');
function AppearanceProbe(){return <output data-testid="saved-theme-mode">{useThemeMode()}</output>;}
function install(store: ReturnType<typeof createConfigurationStore>){
 const api={get:vi.fn(async()=>store.get()),validate:vi.fn(async(text:string)=>validateConfigurationText(text)),save:vi.fn(async(request:{text:string;revision:string})=>store.save(request)),setDirty:vi.fn().mockResolvedValue({ok:true})};
 Object.defineProperty(window,'owb',{configurable:true,value:{configuration:api,services:{list:vi.fn().mockResolvedValue({status:200,body:{connections:[]}})}}});
 return api;
}
async function show(){render(<ThemeProvider><ConfigurationSettings updates={<p>Updater fixture</p>}/></ThemeProvider>);await screen.findByRole('combobox',{name:'主题'});}
function footerSave(){return within(document.querySelector('.owb-config-savebar')!).getByRole('button',{name:'保存配置'});}
describe('disk-backed General theme mode (#555)',()=>{
 it.each([
  {mode:'light',label:'浅色',systemDark:true,resolved:'light'},
  {mode:'dark',label:'深色',systemDark:false,resolved:'dark'},
  {mode:'system',label:'跟随系统',systemDark:true,resolved:'dark'},
  {mode:'system',label:'跟随系统',systemDark:false,resolved:'light'},
 ])('saves General appearance $mode (system dark=$systemDark) and restores it from disk',async({mode,label,systemDark,resolved})=>{
  const media=vi.spyOn(window,'matchMedia').mockImplementation(query=>({matches:query==='(prefers-color-scheme: dark)'&&systemDark,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()}));
  const directory=mkdtempSync(join(tmpdir(),'roleweave-appearance-'));
  const options={userDataPath:directory,env:{},safeStorage:{isEncryptionAvailable:()=>false}};
  try{
   const store=createConfigurationStore(options),original=store.get();
   const config={...original.config,appearance:{...original.config.appearance,locale:'zh-CN',mode:mode==='dark'?'light':'dark'},migration:{rendererPreferences:true}};
   expect(store.save({text:JSON.stringify(config),revision:original.revision}).ok).toBe(true);
   let persisted=store.get() as ConfigurationSnapshot;
   const api=install(store);
   api.get.mockImplementation(async()=>store.get());
   api.save.mockImplementation(async request=>{const saved=store.save(request);if(saved.ok)persisted=saved;return saved;});
   applyConfiguration(persisted);
   const before=document.documentElement.getAttribute('data-theme');
   render(<AppearanceProbe/>);await show();
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'主题'}));
   fireEvent.click(await screen.findByText(label,{selector:'.ant-select-item-option-content'}));
   expect(document.documentElement).toHaveAttribute('data-theme',before);
   fireEvent.click(footerSave());await screen.findByText('配置已保存');
   expect(persisted.config.appearance.mode).toBe(mode);
   expect(document.documentElement).toHaveAttribute('data-theme',resolved);
   await waitFor(()=>expect(screen.getByTestId('saved-theme-mode')).toHaveTextContent(resolved));
   expect(window.localStorage.getItem('owb.theme-mode')).toBe(mode==='system'?null:mode);
   // Recreate the disk store and bridge with no renderer compatibility cache.
   window.localStorage.clear();
   document.documentElement.setAttribute('data-theme',resolved==='dark'?'light':'dark');
   const restarted=createConfigurationStore(options);
   const reloaded=install(restarted);
   const migratePreferences=vi.fn(async preferences=>restarted.migratePreferences(preferences));
   Object.assign(reloaded,{migratePreferences});
   await act(async()=>{await initializeConfiguration();});
   expect(migratePreferences).toHaveBeenCalledTimes(1);
   expect(document.documentElement).toHaveAttribute('data-theme',resolved);
   await waitFor(()=>expect(screen.getByTestId('saved-theme-mode')).toHaveTextContent(resolved));
   expect(window.localStorage.getItem('owb.theme-mode')).toBe(mode==='system'?null:mode);
  }finally{media.mockRestore();rmSync(directory,{recursive:true,force:true});}
 });
});
