import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import { OwbI18nProvider } from '@roleweave/ui';
import { ConfigurationSettings } from '../src/settings/ConfigurationSettings';
import { App } from '../src/App';
import { ThemeProvider } from '../src/theme-context';
import { readStoredPresetId, readStoredTheme } from '../src/theme-storage';
import { applyConfiguration, initializeConfiguration, requestSettingsLeave } from '../src/configuration-preferences';
import { useThemeMode } from '../src/theme-toggle';
import type { ApplicationConfiguration, ConfigurationSnapshot } from '../src/configuration-types';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createConfigurationStore } = createRequire(import.meta.url)('../../src/configuration.cjs');
function SettingsFixture(props: React.ComponentProps<typeof ConfigurationSettings>) { return <ThemeProvider><ConfigurationSettings {...props}/></ThemeProvider>; }
function AppearanceProbe(){return <output data-testid="saved-theme-mode">{useThemeMode()}</output>;}
const initial=():ApplicationConfiguration=>({schemaVersion:1,appearance:{mode:'system',profile:'mint',locale:'zh-CN'},chat:{sendShortcut:'enter',rememberLayout:true},layouts:{focusByWorkspace:{}},runtime:{},hosts:{qoder:{},claude:{},codex:{}},services:{},migration:{rendererPreferences:true}});
function snapshot(config=initial(),revision='v1'):ConfigurationSnapshot{return{ok:true,config,text:'// keep this comment\n'+JSON.stringify(config,null,2),revision,filePath:'/test-user-data/roleweave.config.jsonc',warnings:[],errors:[],sources:{},storageAvailable:true,credentials:[],platform:'darwin',canRestore:true};}
function install(start=snapshot()){
 const validate=vi.fn(async(text:string)=>{try{const c=parse(text);if(!c?.appearance||!c?.hosts?.codex)return{ok:false as const,code:'invalid_configuration',errors:[{field:'appearance',line:2,column:1,message:'Required field'}]};return{ok:true as const,config:c};}catch{return{ok:false as const,code:'invalid_configuration'};}});
 const api={get:vi.fn().mockResolvedValue(start),validate,save:vi.fn(async(request:{text:string;revision:string})=>({...start,config:parse(request.text),text:request.text,revision:'v2'})),setDirty:vi.fn().mockResolvedValue({ok:true}),openLocation:vi.fn().mockResolvedValue({ok:true}),restore:vi.fn().mockResolvedValue(start)};
 Object.defineProperty(window,'owb',{configurable:true,value:{configuration:api,services:{list:vi.fn().mockResolvedValue({status:200,body:{connections:[]}})}}});
 return api;
}
async function show(){render(<SettingsFixture updates={<p>Updater fixture</p>}/>);await screen.findByRole('combobox',{name:'发送快捷键'});fireEvent.click(screen.getByText('更多外观选项'));}
function footerSave(){return within(document.querySelector('.owb-config-savebar')!).getByRole('button',{name:'保存配置'});}
async function fileView(){fireEvent.click(screen.getByRole('tab',{name:'高级配置'}));fireEvent.click(screen.getByRole('button',{name:'配置文件',exact:true}));return screen.getByRole('textbox',{name:'roleweave.config.jsonc'});}
beforeEach(()=>{window.localStorage.clear();});
describe('shared settings draft',()=>{
 it.each([
  {mode:'light',label:'浅色',systemDark:true,resolved:'light'},
  {mode:'dark',label:'深色',systemDark:false,resolved:'dark'},
  {mode:'system',label:'跟随系统',systemDark:true,resolved:'dark'},
  {mode:'system',label:'跟随系统',systemDark:false,resolved:'light'},
 ])('saves General appearance $mode (system dark=$systemDark) and restores it on bootstrap',async({mode,label,systemDark,resolved})=>{
  const media=vi.spyOn(window,'matchMedia').mockImplementation(query=>({matches:query==='(prefers-color-scheme: dark)'&&systemDark,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()}));
  const directory=mkdtempSync(join(tmpdir(),'roleweave-appearance-'));
  const options={userDataPath:directory,env:{},safeStorage:{isEncryptionAvailable:()=>false}};
  try{
   const store=createConfigurationStore(options),original=store.get();
   const config={...original.config,appearance:{...initial().appearance,mode:mode==='dark'?'light':'dark'},migration:{rendererPreferences:true}};
   expect(store.save({text:JSON.stringify(config),revision:original.revision}).ok).toBe(true);
   let persisted=store.get() as ConfigurationSnapshot;
   const api=install(persisted);
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
   // Recreate the store and bridge so bootstrap reads the actual saved JSONC,
   // even if the renderer's pre-paint compatibility cache is lost.
   window.localStorage.clear();
   document.documentElement.setAttribute('data-theme',resolved==='dark'?'light':'dark');
   const restarted=createConfigurationStore(options);
   const reloaded=install(restarted.get());
   const migratePreferences=vi.fn(async preferences=>restarted.migratePreferences(preferences));
   Object.assign(reloaded,{migratePreferences});
   await act(async()=>{await initializeConfiguration();});
   expect(migratePreferences).toHaveBeenCalledTimes(1);
   expect(document.documentElement).toHaveAttribute('data-theme',resolved);
   await waitFor(()=>expect(screen.getByTestId('saved-theme-mode')).toHaveTextContent(resolved));
   expect(window.localStorage.getItem('owb.theme-mode')).toBe(mode==='system'?null:mode);
  }finally{media.mockRestore();rmSync(directory,{recursive:true,force:true});}
 });
 it('keeps a credential draft when its Host is collapsed and reopened, then saves it',async()=>{
  const api=install();await show();fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  const host=document.querySelectorAll<HTMLDetailsElement>('.owb-config-host')[1]!;
  expect(host.open).toBe(false);fireEvent.click(host.querySelector('summary')!);
  const input=document.getElementById('config-ANTHROPIC_API_KEY') as HTMLInputElement;
  fireEvent.input(input,{target:{value:'temporary-test-credential'}});
  fireEvent.click(host.querySelector('summary')!);fireEvent.click(host.querySelector('summary')!);
  expect(input.value).toBe('temporary-test-credential');
  expect(within(host).getByText('有未保存的修改')).toBeInTheDocument();
  fireEvent.click(footerSave());await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(1));
  expect((api.save.mock.calls[0]![0] as unknown as {hostChanges:{ANTHROPIC_API_KEY:string}}).hostChanges.ANTHROPIC_API_KEY).toBe('temporary-test-credential');
  await waitFor(()=>expect(input.value).toBe(''));
 });
 it('checks only a saved service and reenables checking after the shared draft is saved',async()=>{
  const api=install(snapshot({...initial(),services:{doc:{apiUrl:'https://doc.example'}}}));
  const probe=vi.fn().mockResolvedValue({status:200,body:{kind:'doc',state:'ready',version:'1.0',checkedAt:'2026-09-30T00:00:00Z'}});
  Object.assign(window.owb.services,{probe,list:vi.fn().mockResolvedValue({status:200,body:{connections:[{kind:'doc',configured:true,apiUrl:'https://doc.example',tokenConfigured:false,webUrl:null,workspaceId:null}]}})});
  await show();fireEvent.click(screen.getByRole('tab',{name:'文档与记忆'}));
  const card=document.querySelectorAll('.owb-config-service')[0]!;
  const check=within(card as HTMLElement).getByRole('button',{name:'检查连接'});
  await waitFor(()=>expect(check).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox',{name:'Doc Web URL'}),{target:{value:'https://doc.example/web'}});
  expect(check).toBeDisabled();fireEvent.click(check);expect(probe).not.toHaveBeenCalled();
  fireEvent.click(footerSave());await waitFor(()=>expect(check).toBeEnabled());
  fireEvent.click(check);await waitFor(()=>expect(probe).toHaveBeenCalledWith('doc'));
  expect(within(card as HTMLElement).getByText('服务 API 可访问，授权有效')).toBeInTheDocument();
  expect(api.save).toHaveBeenCalledTimes(1);
 });

 it('offers working preset and custom colours inside General without dropping the shared draft',async()=>{
  const api=install();await show();
  expect(screen.getByRole('heading',{name:'主题设置'})).toBeVisible();
  expect(screen.queryByRole('button',{name:'AI 生成'})).toBeNull();
  expect(screen.queryByText('提示音',{exact:true})).toBeNull();
  fireEvent.click(screen.getByRole('checkbox',{name:'记住工作区对话布局'}));
  fireEvent.click(screen.getByRole('button',{name:/One Dark/}));
  expect(readStoredPresetId()).toBe('one-dark');
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'自定义配色'}));
  const color=screen.getByRole('textbox',{name:'primary'});
  fireEvent.change(color,{target:{value:'#123456'}});fireEvent.blur(color);
  expect(readStoredTheme()).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'保存配色'}));
  expect(readStoredTheme()?.light.primary).toBe('#123456');
  expect(api.save).not.toHaveBeenCalled();
  expect(screen.getByRole('checkbox',{name:'记住工作区对话布局'})).not.toBeChecked();
  fireEvent.click(footerSave());await screen.findByText('配置已保存');
  expect(parse(api.save.mock.calls[0]![0].text).chat.rememberLayout).toBe(false);
 });
 it('uses the native picker for a draft default project location and saves it only with the shared configuration',async()=>{
  const api=install();
  Object.assign(api,{pickProjectDirectory:vi.fn().mockResolvedValue({ok:true,path:'/tmp/team-projects'}),cacheInfo:vi.fn().mockResolvedValueOnce({ok:true,bytes:512}).mockResolvedValue({ok:true,bytes:1048576}),openCache:vi.fn().mockResolvedValue({ok:true})});
  await show();
  fireEvent.click(screen.getByRole('button',{name:'查看占用'}));
  expect(await screen.findByText(/512\s*B/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'查看占用'}));
  expect(await screen.findByText(/1\s*MB/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/更\s*改/}));
  fireEvent.click(screen.getByRole('button',{name:'浏览…'}));
  expect(await screen.findByText('/tmp/team-projects')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'保存位置'}));
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(footerSave());
  await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(1));
  expect(parse(api.save.mock.calls[0]![0].text).storage.projectDirectory).toBe('/tmp/team-projects');
 });
 it('guards the global workspace hub before any picker or creation can mutate the workspace',async()=>{
  const api=install();
  Object.assign(api,{migratePreferences:vi.fn().mockResolvedValue(snapshot()),onCloseRequested:vi.fn().mockReturnValue(()=>{})});
  const openWorkspace=vi.fn().mockResolvedValue({canceled:true});
  Object.assign(window.owb,{
   status:vi.fn().mockResolvedValue({running:true,health:{status:'ok',api:'v0',engine:{available:true},workspace:{open:false}}}),
   workspace:vi.fn().mockResolvedValue({status:200,body:{open:false}}),
   reports:vi.fn().mockResolvedValue({status:200,body:{streams:{escalations:[],audits:[],evidence:[]},budgets:[],page:{cursor:null,hasMore:false}}}),
   openWorkspace,createWorkspace:vi.fn(),onEvent:vi.fn().mockReturnValue(()=>{}),onSseStatus:vi.fn().mockReturnValue(()=>{}),
   sseStatus:vi.fn().mockResolvedValue('connected'),onFallbackNotice:vi.fn().mockReturnValue(()=>{}),
   onUpdateState:vi.fn().mockReturnValue(()=>{}),update:{status:vi.fn().mockResolvedValue({version:'0.3.0',state:'unavailable',available:false,requiresConfirmation:false,signed:false,updateVerified:false,platform:'darwin'})},
  });
  render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'设置'}));
  fireEvent.click(await screen.findByText('更多外观选项'));
  fireEvent.click(screen.getByRole('checkbox',{name:'记住工作区对话布局'}));
  fireEvent.click(screen.getByRole('button',{name:'项目入口'}));
  await waitFor(()=>expect(screen.getByText('设置有未保存的修改')).toBeVisible());
  expect(document.querySelector('.owb-project-dialog__chooser')).toBeNull();
  expect(openWorkspace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));
  expect(document.querySelector('.owb-project-dialog__chooser')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'项目入口'}));
  fireEvent.click(screen.getByRole('button',{name:'放弃并离开'}));
  await waitFor(()=>expect(document.querySelector('.owb-project-dialog__chooser')).toBeVisible());
  expect(openWorkspace).not.toHaveBeenCalled();
 });
 it('keeps project experiments separate from the application configuration draft',async()=>{
  const api=install(); render(<SettingsFixture updates={<p>Updater fixture</p>} initialCategory="experiments"/>);
  await screen.findByText('请先打开一个项目，再设置实验功能。');
  expect(screen.getByRole('tab',{name:'实验功能'})).toHaveAttribute('aria-selected','true');
  expect(document.querySelector('.owb-config-savebar')).toBeNull();
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab',{name:'常规'})); await screen.findByRole('combobox',{name:'发送快捷键'});
  expect(footerSave()).toBeDisabled();
 });
 it('retains comments and one draft when switching categories and JSONC/form views; saves typed values',async()=>{
  const api=install();await show();
  fireEvent.mouseDown(screen.getByRole('combobox',{name:'发送快捷键'}));fireEvent.click(await screen.findByText('⌘ / Ctrl + Enter'));
  let editor=await fileView();expect((editor as HTMLTextAreaElement).value).toContain('// keep this comment');expect((editor as HTMLTextAreaElement).value).toContain('mod-enter');
  const value=parse((editor as HTMLTextAreaElement).value);value.chat.rememberLayout=false;
  fireEvent.change(editor,{target:{value:'// edited comment\n'+JSON.stringify(value,null,2)}});
  fireEvent.click(screen.getByRole('tab',{name:'常规'}));expect(screen.getByRole('checkbox',{name:'记住工作区对话布局'})).not.toBeChecked();
  fireEvent.click(footerSave());await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(1));expect(api.save.mock.calls[0]![0].text).toContain('// edited comment');
  await screen.findByText('配置已保存');
 });
 it('keeps failed grouped credential input and redacts preview; only successful save clears it',async()=>{
  const api=install();api.save.mockResolvedValueOnce({ok:false,code:'storage_unavailable'} as never);await show();fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  const password=document.getElementById('config-OPENAI_API_KEY') as HTMLInputElement;fireEvent.input(password,{target:{value:'dummy-settings-secret'}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'预览修改'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'预览修改'}));expect(screen.getByText('更新',{exact:true})).toBeInTheDocument();expect(screen.queryByText('dummy-settings-secret')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'返回编辑'}));
  fireEvent.click(footerSave());await screen.findByText('配置未能读取或保存。草稿已保留，请重试。');expect(password.value).toBe('dummy-settings-secret');
  fireEvent.click(footerSave());await screen.findByText('配置已保存');expect(password.value).toBe('');
  expect((api.save.mock.calls[1]![0] as unknown as {hostChanges:Record<string,string>}).hostChanges.OPENAI_API_KEY).toBe('dummy-settings-secret');
 });
 it('invalid JSONC can be fixed without losing text or disabling the editor',async()=>{
  const api=install();await show();const editor=await fileView();fireEvent.change(editor,{target:{value:'{ "hosts": {} }'}});fireEvent.click(footerSave());
  await screen.findByText(/Required field/);expect(editor).toHaveValue('{ "hosts": {} }');expect(api.save).not.toHaveBeenCalled();
  fireEvent.change(editor,{target:{value:JSON.stringify(initial())}});fireEvent.click(footerSave());await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(1));
 });
 it('external conflict requires explicit reload or overwrite using the freshly observed revision',async()=>{
  const disk=snapshot({...initial(),chat:{sendShortcut:'mod-enter',rememberLayout:true}},'external');
  const api=install();api.save.mockResolvedValueOnce({ok:false,code:'conflict',current:disk} as never);await show();const editor=await fileView();fireEvent.change(editor,{target:{value:(editor as HTMLTextAreaElement).value+'\n// edit'}});
  fireEvent.click(footerSave());await screen.findByText('配置文件已被外部修改');expect(api.save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'明确覆盖此版本'}));await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(2));expect(api.save.mock.calls[1]![0].revision).toBe('external');
 });
 it('leaving a dirty draft offers save/discard/keep and never navigates before the decision',async()=>{
  const api=install();await show();fireEvent.click(screen.getByRole('checkbox',{name:'记住工作区对话布局'}));const next=vi.fn();act(()=>requestSettingsLeave(next));
  expect(next).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));expect(next).not.toHaveBeenCalled();
  act(()=>requestSettingsLeave(next));fireEvent.click(screen.getByRole('button',{name:'保存并离开'}));await waitFor(()=>expect(next).toHaveBeenCalledTimes(1));expect(api.save).toHaveBeenCalledTimes(1);
 });
 it('retains an unsaved service token through temporarily invalid JSONC and category changes',async()=>{
  const api=install();await show();fireEvent.click(screen.getByRole('tab',{name:'文档与记忆'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Doc API URL'}),{target:{value:'https://doc.example'}});
  const token=document.getElementById('config-doc-token') as HTMLInputElement;fireEvent.input(token,{target:{value:'dummy-uncommitted-token'}});
  const editor=await fileView(),valid=(editor as HTMLTextAreaElement).value;
  fireEvent.change(editor,{target:{value:'{ broken'}});expect(document.getElementById('config-doc-token')).toBe(token);expect(token.value).toBe('dummy-uncommitted-token');
  fireEvent.change(editor,{target:{value:valid}});fireEvent.click(screen.getByRole('tab',{name:'文档与记忆'}));expect(token.value).toBe('dummy-uncommitted-token');
  fireEvent.click(footerSave());await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(1));expect((api.save.mock.calls[0]![0] as unknown as {serviceChanges:{doc:string}}).serviceChanges.doc).toBe('dummy-uncommitted-token');
 });
 it('updates category reactively when initialCategory changes after mount',async()=>{
  install();
  const {rerender}=render(<SettingsFixture updates={<p>Updater fixture</p>}/>);
  await screen.findByRole('combobox',{name:'发送快捷键'});
  expect(screen.getByRole('tab',{name:'常规'})).toHaveAttribute('aria-selected','true');
  rerender(<SettingsFixture updates={<p>Updater fixture</p>} initialCategory="experiments"/>);
  await screen.findByText('请先打开一个项目，再设置实验功能。');
  expect(screen.getByRole('tab',{name:'实验功能'})).toHaveAttribute('aria-selected','true');
  rerender(<SettingsFixture updates={<p>Updater fixture</p>} initialCategory={undefined}/>);
  await screen.findByRole('combobox',{name:'发送快捷键'});
  expect(screen.getByRole('tab',{name:'常规'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('tab',{name:'实验功能'})).toHaveAttribute('aria-selected','false');
  rerender(<SettingsFixture updates={<p>Updater fixture</p>} initialCategory="agents"/>);
  await waitFor(()=>expect(screen.getByRole('tab',{name:'Agent 连接'})).toHaveAttribute('aria-selected','true'));
 });
 it('preserves manual tab selection when initialCategory does not change across re-renders',async()=>{
  install();
  const {rerender}=render(<SettingsFixture updates={<p>Updater fixture</p>}/>);
  await screen.findByRole('combobox',{name:'发送快捷键'});
  fireEvent.click(screen.getByRole('tab',{name:'文档与记忆'}));
  expect(screen.getByRole('tab',{name:'文档与记忆'})).toHaveAttribute('aria-selected','true');
  rerender(<SettingsFixture updates={<p>Updater fixture updated</p>}/>);
  expect(screen.getByRole('tab',{name:'文档与记忆'})).toHaveAttribute('aria-selected','true');
 });
 it('removes uncommitted credential reference when secret input is erased back to empty',async()=>{
  install();
  await show();
  fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  const password=document.getElementById('config-GEMINI_API_KEY') as HTMLInputElement;
  fireEvent.input(password,{target:{value:'temp-key'}});
  let editor=await fileView();
  expect((editor as HTMLTextAreaElement).value).toContain('secret:host/GEMINI_API_KEY');
  fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  fireEvent.input(password,{target:{value:''}});
  editor=await fileView();
  expect((editor as HTMLTextAreaElement).value).not.toContain('secret:host/GEMINI_API_KEY');
  expect(password.value).toBe('');
 });
 it('allows form view editing when non-essential host entries are omitted in JSONC',async()=>{
  const noQoder=snapshot({...initial(),hosts:{claude:{},codex:{}} as never});
  install(noQoder);
  await show();
  expect(screen.getByRole('combobox',{name:'发送快捷键'})).toBeEnabled();
  expect(screen.getByRole('checkbox',{name:'记住工作区对话布局'})).toBeEnabled();
 });
 it('safely restores credential reference when clearing is unchecked even without prior config text reference',async()=>{
  const emptyHostConfig=snapshot({...initial(),hosts:{qoder:{},claude:{},codex:{}}});
  emptyHostConfig.credentials=[{key:'OPENAI_API_KEY',configured:true,last4:'9999'}];
  install(emptyHostConfig);
  await show();
  fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  fireEvent.click(document.querySelectorAll('.owb-config-host summary')[2]!);
  const clearCheckbox=await screen.findByRole('checkbox',{name:'明确清除此凭据'});
  expect(clearCheckbox).not.toBeChecked();
  fireEvent.click(clearCheckbox);
  expect(clearCheckbox).toBeChecked();
  let editor=await fileView();
  expect((editor as HTMLTextAreaElement).value).not.toContain('secret:host/OPENAI_API_KEY');
  fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  fireEvent.click(clearCheckbox);
  expect(clearCheckbox).not.toBeChecked();
  editor=await fileView();
  expect((editor as HTMLTextAreaElement).value).toContain('secret:host/OPENAI_API_KEY');
 });
 it('localizes color profile option labels according to active locale',async()=>{
  install();
  await show();
  expect(screen.getByRole('combobox',{name:'色彩偏好'})).toBeInTheDocument();
  expect(screen.getByText('薄荷绿')).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole('combobox',{name:'色彩偏好'}));
  expect(await screen.findByText('经典蓝')).toBeInTheDocument();
 });
 it('respects ambient application locale during initial load before configuration is ready',async()=>{
  const api=install();
  let resolveGet!:(val:ConfigurationSnapshot)=>void;
  api.get.mockReturnValueOnce(new Promise(resolve=>{resolveGet=resolve;}));
  render(
   <OwbI18nProvider locale="en">
    <SettingsFixture updates={<p>Updater fixture</p>}/>
   </OwbI18nProvider>
  );
  expect(await screen.findByText('Loading settings…')).toBeInTheDocument();
  expect(screen.queryByText('读取设置…')).not.toBeInTheDocument();
  act(()=>{resolveGet(snapshot());});
  await screen.findByRole('tab',{name:'General'});
 });
 it('sends hostChanges with null when credential is explicitly cleared and saved',async()=>{
  const credConfig=snapshot();
  credConfig.credentials=[{key:'OPENAI_API_KEY',configured:true,last4:'1234'}];
  const api=install(credConfig);
  await show();
  fireEvent.click(screen.getByRole('tab',{name:'Agent 连接'}));
  fireEvent.click(document.querySelectorAll('.owb-config-host summary')[2]!);
  const clearCheckbox=await screen.findByRole('checkbox',{name:'明确清除此凭据'});
  fireEvent.click(clearCheckbox);
  fireEvent.click(footerSave());
  await waitFor(()=>expect(api.save).toHaveBeenCalledTimes(1));
  expect((api.save.mock.calls[0]![0] as unknown as {hostChanges:Record<string,unknown>}).hostChanges.OPENAI_API_KEY).toBeNull();
  await screen.findByText('配置已保存');
 });
});
