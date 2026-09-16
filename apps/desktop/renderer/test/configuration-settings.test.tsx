import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import { ConfigurationSettings } from '../src/settings/ConfigurationSettings';
import { requestSettingsLeave } from '../src/configuration-preferences';
import type { ApplicationConfiguration, ConfigurationSnapshot } from '../src/configuration-types';
const initial=():ApplicationConfiguration=>({schemaVersion:1,appearance:{mode:'system',profile:'mint',locale:'zh-CN'},chat:{sendShortcut:'enter',rememberLayout:true},layouts:{focusByWorkspace:{}},runtime:{},hosts:{qoder:{},claude:{},codex:{}},services:{},migration:{rendererPreferences:true}});
function snapshot(config=initial(),revision='v1'):ConfigurationSnapshot{return{ok:true,config,text:'// keep this comment\n'+JSON.stringify(config,null,2),revision,filePath:'/test-user-data/roleweave.config.jsonc',warnings:[],errors:[],sources:{},storageAvailable:true,credentials:[],platform:'darwin',canRestore:true};}
function install(start=snapshot()){
 const validate=vi.fn(async(text:string)=>{try{const c=parse(text);if(!c?.appearance||!c?.hosts?.codex)return{ok:false as const,code:'invalid_configuration',errors:[{field:'appearance',line:2,column:1,message:'Required field'}]};return{ok:true as const,config:c};}catch{return{ok:false as const,code:'invalid_configuration'};}});
 const api={get:vi.fn().mockResolvedValue(start),validate,save:vi.fn(async(request:{text:string;revision:string})=>({...start,config:parse(request.text),text:request.text,revision:'v2'})),setDirty:vi.fn().mockResolvedValue({ok:true}),openLocation:vi.fn().mockResolvedValue({ok:true}),restore:vi.fn().mockResolvedValue(start)};
 Object.defineProperty(window,'owb',{configurable:true,value:{configuration:api,services:{list:vi.fn().mockResolvedValue({status:200,body:{connections:[]}})}}});
 return api;
}
async function show(){render(<ConfigurationSettings updates={<p>Updater fixture</p>}/>);await screen.findByRole('combobox',{name:'发送快捷键'});}
function footerSave(){return within(document.querySelector('.owb-config-savebar')!).getByRole('button',{name:'保存配置'});}
async function fileView(){fireEvent.click(screen.getByRole('tab',{name:'高级配置'}));fireEvent.click(screen.getByRole('button',{name:'配置文件',exact:true}));return screen.getByRole('textbox',{name:'roleweave.config.jsonc'});}
beforeEach(()=>{window.localStorage.clear();});
describe('shared settings draft',()=>{
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

});
