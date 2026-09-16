import type { CredentialKey, CredentialView } from './settings/credential-settings';
export interface ApplicationConfiguration {
  schemaVersion: 1;
  appearance: { mode: 'system'|'light'|'dark'; profile: 'mint'|'default'; locale: 'zh-CN'|'en' };
  chat: { sendShortcut: 'enter'|'mod-enter'; rememberLayout: boolean };
  layouts: { focusByWorkspace: Record<string, boolean> };
  runtime: { mode?: 'native'|'wsl'; distro?: string; nodePath?: string; homePath?: string };
  hosts: { qoder: { personalAccessTokenRef?: string }; claude: { apiKeyRef?: string; authTokenRef?: string; baseUrl?: string }; codex: { apiKeyRef?: string; baseUrl?: string } };
  services: Partial<Record<'doc'|'mem', { apiUrl: string; webUrl?: string; workspaceId?: string; tokenRef?: string } | null>>;
  migration?: { rendererPreferences: boolean; pendingHostUrls?: Array<'claude'|'codex'> };
}
export type ConfigurationIssue = {field:string;line:number;column:number;message:string};
export type ConfigurationChange = {field:string;before:unknown;after:unknown};
export interface ConfigurationSnapshot {
  ok: true; config: ApplicationConfiguration; text: string; revision: string; filePath: string;
  warnings: string[]; errors: ConfigurationIssue[]; sources: Record<string,string>;
  repairRequired?: boolean; storageAvailable: boolean|null; credentials: CredentialView[]; platform: string; canRestore: boolean;
  changes?: ConfigurationChange[]; pendingRestart?: boolean; servicesChanged?: boolean; servicesApplied?: boolean; servicesRestartRequired?: boolean;
}
export type ConfigurationFailure = {ok:false;code:string;errors?:ConfigurationIssue[];current?:ConfigurationSnapshot};
export type ConfigurationResult = ConfigurationSnapshot | ConfigurationFailure;
export type ConfigurationSave = {text:string;revision:string;hostChanges?:Partial<Record<CredentialKey,string|null>>;serviceChanges?:Partial<Record<'doc'|'mem',string|null>>};
export interface ConfigurationBridge {
  get(): Promise<ConfigurationResult>;
  getPreferences?(): Promise<ConfigurationResult>;
  validate(text:string): Promise<{ok:true;config:ApplicationConfiguration}|ConfigurationFailure>;
  save(request:ConfigurationSave): Promise<ConfigurationResult>;
  preferences(patch:Partial<Pick<ApplicationConfiguration,'appearance'|'chat'|'layouts'>> | Record<string,unknown>): Promise<ConfigurationResult>;
  migratePreferences(legacy:Record<string,unknown>): Promise<ConfigurationResult>;
  restore(revision:string): Promise<ConfigurationResult>;
  openLocation(): Promise<{ok:boolean}>;
  setDirty(dirty:boolean): Promise<{ok:boolean}>;
  confirmClose(): Promise<{ok:boolean}>;
  onCloseRequested(callback:()=>void): ()=>void;
}
