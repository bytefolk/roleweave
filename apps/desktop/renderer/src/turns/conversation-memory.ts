export interface ConversationViewport { top: number; anchor?: string; offset?: number; atBottom: boolean; }
/** Owned by App for this runtime only. Workspace data and disk are never touched. */
export interface ConversationMemory { drafts: Map<string, string>; viewports: Map<string, ConversationViewport>; stopping: Set<string>; }
export function createConversationMemory(): ConversationMemory { return { drafts: new Map(), viewports: new Map(), stopping: new Set() }; }
export function conversationKey(workspace: string, employee: string | null, session: string | null): string {
  return JSON.stringify([workspace, employee, session]);
}
