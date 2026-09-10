/**
 * S2 group-chat contracts (DS-34-001 rev-1 §1.2, issue #52). Additive,
 * workbench-local: a group is a bound WorkbenchSession plus a member roster.
 *
 * 过渡债（显式登记）：conversationRef 目前是工作台侧本地标识（uuid），缺口①
 * de issue（turn-envelope 契约级 conversationRef，v1alpha2）合入后切换为契约级
 * 回链并清账；在此之前群内多 turn 经本地映射回链同一会话。
 *
 * 发言路由 = @mention 显式制：群消息必须 @至少一名成员，每个被 @成员各自
 * spawn 一条 turn-envelope.v1（复用既有 spawn 面），禁止无目标广播。
 */

import type { TurnEngine, TurnRecord } from "./turns.js";

export const GROUP_CONVERSATION_SCHEMA_VERSION = "conversation-group.v1" as const;
export const GROUP_LIST_SCHEMA_VERSION = "conversation-group-list.v1" as const;
export const GROUP_MESSAGE_SCHEMA_VERSION = "group-message.v1" as const;
export const GROUP_TIMELINE_SCHEMA_VERSION = "group-timeline.v1" as const;
export type GroupExecutionMode = "parallel" | "relay";
export interface GroupSpawn {
  turnId: string;
  positionId: string;
}

export interface GroupConversation {
  schemaVersion: typeof GROUP_CONVERSATION_SCHEMA_VERSION;
  /** Local transition ref; becomes the contract-level conversationRef after 缺口①. */
  conversationRef: string;
  /** The #14 session bound to this group (AC-004 dual-form recall). */
  sessionId: string;
  /** Member positionIds (>= 2, unique); roster is the collaboration fact. */
  members: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GroupConversationList {
  schemaVersion: typeof GROUP_LIST_SCHEMA_VERSION;
  groups: GroupConversation[];
}

/** A user message in the group timeline; fans out to `mentions` member turns. */
export interface GroupMessage {
  schemaVersion: typeof GROUP_MESSAGE_SCHEMA_VERSION;
  messageId: string;
  conversationRef: string;
  input: string;
  /** The @mentioned member positionIds that were spawned for this message. */
  mentions: string[];
  /** Missing in legacy messages means parallel; relay follows mentions order. */
  mode?: GroupExecutionMode;
  /** Persisted before acceptance; lets recovery settle work that never started. */
  spawns?: GroupSpawn[];
  /** Host chosen for these persisted spawn identities. */
  engine?: TurnEngine;
  createdAt: string;
}

export type GroupTimelineItem =
  | ({ kind: "user" } & GroupMessage)
  | ({ kind: "member"; turn: TurnRecord });

export interface GroupTimeline {
  schemaVersion: typeof GROUP_TIMELINE_SCHEMA_VERSION;
  conversationRef: string;
  /** User messages + member turn records, ordered by createdAt. */
  items: GroupTimelineItem[];
}
