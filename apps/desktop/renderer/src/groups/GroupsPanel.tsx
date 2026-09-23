import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button as AntButton, Input, Select as AntSelect } from "antd";
import { ArrowUp, Plus, Search, Trash2, UserRound, UserRoundPlus, UsersRound } from "lucide-react";
import { useOwbLocale, useT } from "@roleweave/ui";
import { PositionAvatar } from "../PositionAvatar";
import { DiagnosticNotice, type AvailabilityCheck } from "../DiagnosticNotice";
import { ProgressTrail, TypingIndicator } from "../turns/TurnThread";
import type { GroupConversation, GroupConversationList, GroupTimeline } from "@roleweave/shared";
import { useEngineLabel } from "../turns/engine-select";
import { EngineIcon } from "../turns/engine-icon";
import { adaptTurnRecord } from "../turns/adapter";
import type { LiveRunState } from "../turns/turnStream";
import { Markdown } from "../markdown/Markdown";
import type { PositionMentionOption, TurnEngine, TurnEngineAvailability } from "../turns/types";

/** Expandable output block for group bubbles. Uses native <details>/<summary>
 *  for the toggle, with React-controlled conditional rendering so only one copy
 *  of the text exists in the DOM at any time — preventing duplicate-text matches
 *  in Testing Library. (#237) */
function GroupBubbleExpand({ summaryClassName, summaryTitle, summaryChildren, bodyChildren, "aria-label": ariaLabel }: {
  summaryClassName: string;
  summaryTitle: string;
  summaryChildren: React.ReactNode;
  bodyChildren: React.ReactNode;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="owb-bubble__expand" aria-label={ariaLabel} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={summaryClassName} title={summaryTitle}>
        {open ? null : <span className="owb-bubble__expand-text">{summaryChildren}</span>}
      </summary>
      {open && (
        <div className="owb-bubble__expand-body owb-tc__out owb-tc__out--markdown">
          {bodyChildren}
        </div>
      )}
    </details>
  );
}

export interface GroupsPanelProps {
  availabilityCheck?: AvailabilityCheck;
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  positionNames: Record<string, string>;
  /** Avatar background colors keyed by position id (metadata.color); positions
   * without one get the same deterministic hue the org tree uses (#53). */
  positionColors?: Record<string, string>;
  /** Render-ready per-employee portraits, shared with tree and chat. */
  avatarUrls?: Record<string, string>;
  /** Prefilled group draft from the org-tree entry (#53, DS-34-001 §1.3):
   * opens the create panel with these members checked. The nonce re-fires
   * repeated entries on the same member set. Explicit draft only — creation
   * still requires the operator to confirm ≥2 members. */
  draftSeed?: { members: string[]; nonce: number } | null;
  /**
   * Legacy fall-back used only while an older control plane is in use. New
   * requests carry an engine per mentioned employee, so an operator never
   * selects a shared host for a group conversation.
   */
  engine: TurnEngine;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  /** The durable Agent binding for a position, resolved by App from its org data. */
  engineForPosition?: (positionId: string) => TurnEngine;
  /** Shared SSE projection; group runs carry groupRef and are filtered here. */
  liveRuns: Record<string, LiveRunState>;
  /**
   * Kept optional while callers migrate. It deliberately has no UI effect:
   * Agent choice belongs to employee creation, not to a group message.
   */
  onSelectEngine?: (engine: TurnEngine) => void;
  /** 202 spawn list, reported upward so the shared stream seeds live buffers. */
  onSpawnRuns: (
    groupRef: string,
    messageId: string,
    spawns: Array<{ turnId: string; positionId: string; engine?: TurnEngine }>,
    input: string,
    engine: TurnEngine,
  ) => void;
  /** Persisted timeline reconciliation clears missed/late SSE live markers. */
  onReconcileTimeline: (timeline: GroupTimeline) => void;
}

const GROUP_RECONCILE_INTERVAL_MS = 1_000;
const GROUP_RECONCILE_MAX_READS = 180;

function filterPositionOption(input: string, option?: { label?: unknown; value?: unknown }): boolean {
  return `${String(option?.label ?? "")} ${String(option?.value ?? "")}`
    .toLocaleLowerCase()
    .includes(input.toLocaleLowerCase());
}

/** @mention highlight inside operator bubble text (spec §1/§6). */
function renderMentionText(input: string) {
  return input.split(/(@[\w-]+)/g).map((part, index) =>
    part.startsWith("@") ? (
      <mark key={index} className="owb-mention">{part}</mark>
    ) : (
      part
    ),
  );
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

/** Design-spec §3.2: timestamps read as HH:MM in the mono lane; the full
 * datetime stays reachable through the element's title. */
function timeShort(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}


/**
 * S2 group chat surface (#52, DS-34-001 rev-1 §1.2): explicit @mention
 * routing spawns one turn per mentioned member — never broadcast. The
 * conversationRef is a workbench-local uuid (缺口① transition debt; cleared
 * when v1alpha2 conversation refs land).
 */
export function GroupsPanel({
  availabilityCheck,
  workspaceOpen,
  positions,
  positionNames,
  positionColors,
  avatarUrls,
  draftSeed,
  engine,
  engineAvailability,
  engineForPosition,
  liveRuns,
  onSpawnRuns,
  onReconcileTimeline,
}: GroupsPanelProps) {
  const t = useT();
  const locale = useOwbLocale();
  const engineLabel = useEngineLabel();
  const displayPositionName = (id: string): string => positionNames[id] ?? t("org.unknownPosition");
  /** #146：成员名单是数据面（岗位名原文），连接符与「等 N 人」词面随 locale。 */
  const nameSep = locale === "en" ? ", " : "、";
  const groupLabel = (group: GroupConversation): string =>
    group.members.slice(0, 3).map(displayPositionName).join(nameSep) +
    (group.members.length > 3 ? ` ${t("grp.more", { count: group.members.length })}` : "");
  // Requests belong to one mounted workspace panel. An abandoned request may
  // finish after unmount (or StrictMode remount); it must not seed App state.
  const lifecycle = useRef({ mounted: false, generation: 0 });
  const groupsRequestRef = useRef(0);
  useEffect(() => {
    lifecycle.current = { mounted: true, generation: lifecycle.current.generation + 1 };
    return () => { lifecycle.current.mounted = false; lifecycle.current.generation += 1; };
  }, []);
  const captureScope = useCallback(() => {
    const generation = lifecycle.current.generation;
    return () => lifecycle.current.mounted && lifecycle.current.generation === generation;
  }, []);
  const [groups, setGroups] = useState<GroupConversation[]>([]);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const selectedRefRef = useRef<string | null>(null);
  const timelineRequestRef = useRef(0);
  const foregroundTimelineRequestRef = useRef(0);
  const [timeline, setTimeline] = useState<GroupTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftMembers, setDraftMembers] = useState<ReadonlySet<string>>(new Set());
  const draftKey = selectedRef ?? "";
  const [drafts, setDrafts] = useState<Record<string, { input: string; mentions: string[]; mode: "parallel" | "relay" }>>({});
  const emptyDraft = { input: "", mentions: [] as string[], mode: "parallel" as const };
  const draft = drafts[draftKey] ?? emptyDraft;
  const input = draft.input;
  const mentions = useMemo(() => new Set(draft.mentions), [draft.mentions]);
  const mentionedPositionIds = useMemo(() => [...mentions], [mentions]);
  /** Each recipient retains the Agent chosen when that employee was created.
   * `engine` is intentionally only the pre-binding/older-server fall-back. */
  const mentionEngines = useMemo(
    () => Object.fromEntries(
      mentionedPositionIds.map((positionId) => [positionId, engineForPosition?.(positionId) ?? engine]),
    ) as Record<string, TurnEngine>,
    [engine, engineForPosition, mentionedPositionIds],
  );
  const unavailableMention = useMemo(
    () => mentionedPositionIds
      .map((positionId) => ({ positionId, engine: mentionEngines[positionId]! }))
      .find(({ engine: mentionEngine }) => engineAvailability[mentionEngine]?.ready !== true),
    [engineAvailability, mentionEngines, mentionedPositionIds],
  );
  const mentionsReady = unavailableMention === undefined;
  const dispatchMode = draft.mode;
  const setInput = (input: string) => setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? emptyDraft), input } }));
  const setMentions = (mentions: ReadonlySet<string>) => setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? emptyDraft), mentions: [...mentions] } }));
  const setDispatchMode = (mode: "parallel" | "relay") => setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? emptyDraft), mode } }));
  const [sendingGroups, setSendingGroups] = useState<Record<string, boolean>>({});
  const sendingGroupsRef = useRef(new Set<string>());
  const sending = sendingGroups[draftKey] === true;
  const [panelError, setPanelError] = useState<string | null>(null);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    selectedRefRef.current = selectedRef;
  }, [selectedRef]);

  const loadGroups = useCallback(async () => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const request = ++groupsRequestRef.current;
    if (!workspaceOpen) {
      setGroups([]);
      setSelectedRef(null);
      return;
    }
    try {
      const res = await window.owb.groups();
      if (!isCurrent() || request !== groupsRequestRef.current) return;
      if (res.status !== 200) {
        setGroups([]);
        setGroupsError(apiErrorMessage(res.body, t("grp.listFail")));
        return;
      }
      const list = res.body as GroupConversationList;
      setGroups(list.groups);
      setGroupsError(null);
      setSelectedRef((current) =>
        current !== null && list.groups.some((group) => group.conversationRef === current)
          ? current
          : list.groups[0]?.conversationRef ?? null,
      );
    } catch {
      if (isCurrent() && request === groupsRequestRef.current) setGroupsError(t("grp.listFailOffline"));
    }
  }, [captureScope, t, workspaceOpen]);

  const loadTimeline = useCallback(async (conversationRef: string, background = false) => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const request = ++timelineRequestRef.current;
    if (!background) {
      foregroundTimelineRequestRef.current = request;
      setTimelineLoading(true);
    }
    try {
      const res = await window.owb.groupTimeline(conversationRef);
      if (!isCurrent() || selectedRefRef.current !== conversationRef || request !== timelineRequestRef.current) return;
      if (res.status !== 200) {
        setTimeline(null);
        setPanelError(apiErrorMessage(res.body, t("grp.timelineFail")));
        return;
      }
      const next = res.body as GroupTimeline;
      setTimeline(next);
      onReconcileTimeline(next);
      setPanelError(null);
    } catch {
      if (isCurrent() && selectedRefRef.current === conversationRef && request === timelineRequestRef.current) {
        setPanelError(t("grp.timelineFailOffline"));
      }
    } finally {
      if (
        isCurrent() && !background && selectedRefRef.current === conversationRef &&
        request === foregroundTimelineRequestRef.current
      ) {
        setTimelineLoading(false);
      }
    }
  }, [captureScope, onReconcileTimeline, t]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (selectedRef === null) {
      setTimeline(null);
      return;
    }
    void loadTimeline(selectedRef);
  }, [loadTimeline, selectedRef]);

  // Org-tree group entry (#53): seed the draft with known positions only —
  // a stale seed must never check phantom members.
  useEffect(() => {
    if (draftSeed === null || draftSeed === undefined) return;
    const known = draftSeed.members.filter((id) => positions.some((position) => position.id === id));
    if (known.length === 0) return;
    setDraftMembers(new Set(known));
    setCreateOpen(true);
  }, [draftSeed, positions]);

  // Terminal SSE is the refresh hint; the timeline reload is authoritative.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.owb.onEvent((event) => {
      const envelope = event as { type?: string; payload?: unknown };
      if (!["turn.completed", "turn.failed", "turn.indeterminate"].includes(envelope?.type ?? "")) return;
      const payload = envelope.payload as { groupRef?: unknown } | null;
      const groupRef = typeof payload?.groupRef === "string" ? payload.groupRef : null;
      if (groupRef === null || groupRef !== selectedRefRef.current) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void loadTimeline(groupRef, true), 100);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, [loadTimeline]);

  // SSE: remove dismissed groups from the list immediately.
  useEffect(() => {
    const off = window.owb.onEvent((event) => {
      const envelope = event as { type?: string; payload?: unknown };
      if (envelope?.type !== "group.updated") return;
      const payload = envelope.payload as { conversationRef?: unknown; deleted?: unknown } | null;
      if (payload?.deleted !== true || typeof payload.conversationRef !== "string") return;
      const ref = payload.conversationRef;
      setGroups((current) => current.filter((group) => group.conversationRef !== ref));
      if (selectedRefRef.current === ref) setSelectedRef(null);
    });
    return off;
  }, []);

  const selectedReconcileSignature = useMemo(() => {
    const live = Object.values(liveRuns)
      .filter((run) => run.groupRef === selectedRef)
      .map((run) => ["live", run.messageId ?? "", run.turnId ?? "", run.positionId, run.engine].join(":"));
    const persisted = timeline?.conversationRef === selectedRef
      ? timeline.items
          .flatMap((item) => item.kind === "member" && item.turn.status === "running"
            ? [["persisted", item.turn.turnId, item.turn.positionId, item.turn.engine].join(":")]
            : [])
      : [];
    return [...live, ...persisted]
      .sort((left, right) => left.localeCompare(right, "en"))
      .join("|");
  }, [liveRuns, selectedRef, timeline]);

  // SSE is a hint, not the source of truth. While this exact dispatch still
  // has live markers, retry a bounded number of authoritative timeline reads
  // so a dropped or late listener cannot leave the group permanently busy.
  useEffect(() => {
    if (selectedRef === null || selectedReconcileSignature === "") return;
    const conversationRef = selectedRef;
    let cancelled = false;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled || reads >= GROUP_RECONCILE_MAX_READS) return;
      reads += 1;
      await loadTimeline(conversationRef, true);
      if (!cancelled && reads < GROUP_RECONCILE_MAX_READS) {
        timer = setTimeout(() => void poll(), GROUP_RECONCILE_INTERVAL_MS);
      }
    };
    timer = setTimeout(() => void poll(), GROUP_RECONCILE_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [loadTimeline, selectedReconcileSignature, selectedRef]);

  const selectedGroup = groups.find((group) => group.conversationRef === selectedRef) ?? null;

  const createGroup = useCallback(async () => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const members = [...draftMembers];
    if (members.length < 2 || creating) return;
    setCreating(true);
    setPanelError(null);
    try {
      const res = await window.owb.createGroup({ memberPositionIds: members });
      if (!isCurrent()) return;
      if (res.status !== 201) {
        setPanelError(apiErrorMessage(res.body, t("grp.createFail")));
        return;
      }
      const created = res.body as GroupConversation;
      setDraftMembers(new Set());
      setCreateOpen(false);
      await loadGroups();
      if (isCurrent()) setSelectedRef(created.conversationRef);
    } catch {
      if (isCurrent()) setPanelError(t("grp.createFailOffline"));
    } finally {
      if (isCurrent()) setCreating(false);
    }
  }, [captureScope, creating, draftMembers, loadGroups, t]);

  const addMember = useCallback(async (positionId: string) => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const ref = selectedRefRef.current;
    if (ref === null || !positionId) return;
    try {
      const res = await window.owb.addGroupMember({ conversationRef: ref, positionId });
      if (!isCurrent()) return;
      if (res.status !== 200) {
        if (selectedRefRef.current === ref) setPanelError(apiErrorMessage(res.body, t("grp.addFail")));
        return;
      }
      setPanelError(null);
      await loadGroups();
      if (isCurrent()) void loadTimeline(ref);
    } catch {
      if (isCurrent() && selectedRefRef.current === ref) setPanelError(t("grp.addFailOffline"));
    }
  }, [captureScope, loadGroups, loadTimeline, t]);

  const dismissGroup = useCallback(async () => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const ref = selectedRefRef.current;
    if (ref === null || dismissing) return;
    setDismissing(true);
    setPanelError(null);
    try {
      const res = await window.owb.dismissGroup(ref);
      if (!isCurrent()) return;
      if (res.status !== 200) {
        const body = res.body as { code?: string } | null;
        if (body?.code === "group_busy") {
          setPanelError(t("grp.busy"));
        } else {
          setPanelError(apiErrorMessage(res.body, t("grp.dismissFail")));
        }
        return;
      }
      setDismissOpen(false);
      setGroups((current) => current.filter((group) => group.conversationRef !== ref));
      if (selectedRefRef.current === ref) setSelectedRef(null);
    } catch {
      if (isCurrent()) setPanelError(t("grp.dismissFailOffline"));
    } finally {
      if (isCurrent()) setDismissing(false);
    }
  }, [captureScope, dismissing, t]);

  const send = useCallback(async () => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const ref = selectedRefRef.current;
    const trimmed = input.trim();
    if (
      ref === null || trimmed.length === 0 || mentions.size === 0 || !mentionsReady ||
      sendingGroupsRef.current.has(ref)
    ) return;
    const requestEngine = mentionEngines[mentionedPositionIds[0]!] ?? engine;
    sendingGroupsRef.current.add(ref);
    setSendingGroups((current) => ({ ...current, [ref]: true }));
    setPanelError(null);
    try {
      const res = await window.owb.createGroupTurn({
        conversationRef: ref,
        input: trimmed,
        // The legacy scalar keeps older desktop/control-plane pairs working;
        // `engines` is authoritative for an up-to-date server.
        engine: requestEngine,
        engines: mentionEngines,
        mentions: mentionedPositionIds,
        mode: dispatchMode,
      });
      if (!isCurrent()) return;
      if (res.status !== 202) {
        if (selectedRefRef.current === ref) setPanelError(apiErrorMessage(res.body, t("grp.turnFail")));
        return;
      }
      const body = res.body as {
        conversationRef: string;
        messageId: string;
        spawns: Array<{ turnId: string; positionId: string; engine?: TurnEngine }>;
      };
      onSpawnRuns(ref, body.messageId, body.spawns, trimmed, requestEngine);
      setDrafts((current) => current[ref]?.input === input ? { ...current, [ref]: { ...current[ref]!, input: "", mentions: [] } } : current);
      void loadTimeline(ref);
    } catch {
      if (isCurrent() && selectedRefRef.current === ref) setPanelError(t("grp.turnFailOffline"));
    } finally {
      if (isCurrent()) {
        sendingGroupsRef.current.delete(ref);
        setSendingGroups((current) => ({ ...current, [ref]: false }));
      }
    }
  }, [
    captureScope,
    dispatchMode,
    engine,
    input,
    loadTimeline,
    mentionEngines,
    mentionedPositionIds,
    mentions,
    mentionsReady,
    onSpawnRuns,
    sending,
    t,
  ]);

  const unrenderableOutput = t("turn.unrenderableOutput");

  /** Merge persisted timeline with live SSE buffers for this group into a single
   *  render list keyed by turnId. A live run whose turnId is already persisted
   *  is suppressed — the record wins. Using a single array with stable keys
   *  ensures React preserves DOM nodes (and <details open> state) when a live
   *  run transitions to persisted. (#237) */
  const timelineItems = useMemo(() => {
    const persisted = timeline?.items ?? [];
    const persistedTurnIds = new Set(
      persisted.filter((item) => item.kind === "member").map((item) => item.turn.turnId),
    );
    const liveEntries = Object.entries(liveRuns)
      .filter(([runId, run]) =>
        run.groupRef === selectedRef && !persistedTurnIds.has(run.turnId ?? runId),
      )
      .map(([runId, run]) => {
        const turnId = run.turnId ?? runId;
        return {
          kind: "member" as const,
          key: turnId,
          isLive: true,
          turn: {
            id: turnId,
            positionId: run.positionId,
            positionName: displayPositionName(run.positionId),
            engine: run.engine,
            input: run.input,
            status: "running" as const,
            createdAt: run.startedAt,
            errorCode: undefined,
            ...(run.text !== "" ? { output: run.text } : {}),
            ...(run.totalTokens !== null ? { totalTokens: run.totalTokens } : {}),
            ...(run.trace && run.trace.length > 0 ? { trace: run.trace } : {}),
          },
        };
      });
    const persistedEntries = persisted.map((item) => {
      if (item.kind === "user") {
        return { kind: "user" as const, key: item.messageId, item };
      }
      const turn = adaptTurnRecord(item.turn, displayPositionName(item.turn.positionId), unrenderableOutput);
      return { kind: "member" as const, key: turn.id, isLive: false, turn };
    });
    return [...persistedEntries, ...liveEntries];
  }, [liveRuns, positionNames, selectedRef, t, timeline, unrenderableOutput]);

  /** Members with an in-flight run in this group — drives the roster LED and
   * the header 状态灯 (设计稿 .roster .rdot / .src)。 */
  const runningMembers = useMemo(() => {
    const persistedTurnIds = new Set(
      timeline?.items.filter((item) => item.kind === "member").map((item) => item.turn.turnId) ?? [],
    );
    const ids = new Set<string>();
    for (const item of timeline?.items ?? []) {
      if (item.kind === "member" && item.turn.status === "running") {
        ids.add(item.turn.positionId);
      }
    }
    for (const [runId, run] of Object.entries(liveRuns)) {
      if (run.groupRef === selectedRef && !persistedTurnIds.has(run.turnId ?? runId)) {
        ids.add(run.positionId);
      }
    }
    return ids;
  }, [liveRuns, selectedRef, timeline]);

  const nonMembers = positions.filter(
    (position) => selectedGroup !== null && !selectedGroup.members.includes(position.id),
  );

  if (!workspaceOpen) {
    return <p className="owb-muted">{t("tree.notOpened")}</p>;
  }

  return (
    <section className="owb-groups" aria-label={t("rail.groups")}>
      <div className="owb-groups__list">
        <header className="owb-groups__list-header">
          <h2><UsersRound aria-hidden="true" size={12} />{t("rail.groups")}</h2>
        </header>
        {groupsError ? <p className="owb-groups__error" role="alert">{groupsError}</p> : null}
        <ul className="owb-groups__items">
          {groups.map((group) => (
            <li key={group.conversationRef}>
              <button
                type="button"
                className={group.conversationRef === selectedRef ? "is-active" : undefined}
                onClick={() => setSelectedRef(group.conversationRef)}
              >
                <span className="owb-groups__item-name">
                  <span className="owb-groups__avatar-stack" aria-hidden="true">
                    {group.members.slice(0, 3).map((memberId) => (
                      <PositionAvatar
                        key={memberId}
                        colors={positionColors ?? {}}
                        sources={avatarUrls}
                        id={memberId}
                        name={displayPositionName(memberId)}
                        className="owb-groups__avatar owb-groups__avatar--xs"
                      />
                    ))}
                  </span>
                  {groupLabel(group)}
                </span>
                <span className="owb-groups__item-meta">
                  {t("grp.members", { count: group.members.length })} · {timeShort(group.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <details
          className="owb-groups__create"
          open={createOpen}
          onToggle={(event) => setCreateOpen(event.currentTarget.open)}
        >
          <summary><Plus aria-hidden="true" size={13} />{t("grp.createCta")}</summary>
          <div className="owb-groups__create-body">
            <div className="owb-groups__create-field">
              <div className="owb-groups__field-label">
                <UserRoundPlus aria-hidden="true" size={13} />
                <span>{t("grp.selectMembers")}</span>
                <span className="owb-groups__selection-count">
                  {t("grp.selectedCount", { count: draftMembers.size })}
                </span>
              </div>
              <AntSelect
                classNames={{ popup: { root: "owb-conversation-select-popup" } }}
                mode="multiple"
                aria-label={t("grp.createSearchAria")}
                placeholder={t("grp.createSearchPh")}
                showSearch
                optionFilterProp="label"
                filterOption={filterPositionOption}
                value={[...draftMembers]}
                disabled={creating}
                maxTagCount="responsive"
                popupMatchSelectWidth={false}
                onChange={(values) => setDraftMembers(new Set(values as string[]))}
                options={positions.map((position) => ({
                  value: position.id,
                  label: position.name,
                }))}
              />
            </div>
            <AntButton
              size="small"
              type="primary"
              disabled={draftMembers.size < 2 || creating || positions.length < 2}
              onClick={() => void createGroup()}
            >
              {t("grp.create")}
            </AntButton>
          </div>
        </details>
      </div>

      <div className="owb-groups__panel">
        {/* #116 REQ-003: the alert must be reachable before a group exists —
         * a rejected create has no selection to hide behind. */}
        {panelError ? <p className="owb-groups__error" role="alert">{panelError}</p> : null}
        {selectedGroup === null ? (
          <p className="owb-panel__notice">{t("grp.pickOrCreate")}</p>
        ) : (
          <>
            <header className="owb-groups__panel-header">
              <div className="owb-groups__avatar-stack" aria-label={t("grp.rosterAria", { count: selectedGroup.members.length })}>
                {selectedGroup.members.slice(0, 6).map((memberId) => (
                  <PositionAvatar
                    key={memberId}
                    colors={positionColors ?? {}}
                    sources={avatarUrls}
                    id={memberId}
                    name={displayPositionName(memberId)}
                    className="owb-groups__avatar"
                  />
                ))}
                {selectedGroup.members.length > 6 ? (
                  <span className="owb-groups__avatar owb-groups__avatar--more">
                    +{selectedGroup.members.length - 6}
                  </span>
                ) : null}
              </div>
              <div className="owb-groups__panel-title">
                <h3>{groupLabel(selectedGroup)}</h3>
                <span className="owb-groups__panel-ref">{t("grp.memberWord", { count: selectedGroup.members.length })}</span>
              </div>
              <span className="owb-src">
                {runningMembers.size > 0 ? (
                  <>
                    <span className="owb-led owb-led--running" aria-hidden="true" />
                    <span className="owb-src__text">{t("grp.nRunning", { count: runningMembers.size })}</span>
                  </>
                ) : (
                  <span className="owb-groups__member-count">
                    {t("grp.nMembers", { count: selectedGroup.members.length })}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="owb-dismiss"
                onClick={() => setDismissOpen(true)}
                disabled={runningMembers.size > 0}
                title={t("grp.dismissAction")}
              >
                <Trash2 aria-hidden="true" size={13} />
                {t("grp.dismissAction")}
              </button>
            </header>

            <div className="owb-groups__panel-body">
              <aside className="owb-groups__roster" aria-label={t("grp.roster")}>
                <h4>{t("grp.membersHead")}</h4>
                <ul className="owb-groups__roster-items">
                  {selectedGroup.members.map((memberId) => {
                    const running = runningMembers.has(memberId);
                    return (
                      <li key={memberId} className="owb-groups__roster-item">
                        <span
                          className={running ? "owb-led owb-led--running" : "owb-led"}
                          {...(running ? { "aria-label": t("grp.turnInProgress") } : { "aria-hidden": true })}
                        />
                        <PositionAvatar
                          colors={positionColors ?? {}}
                          sources={avatarUrls}
                          id={memberId}
                          name={displayPositionName(memberId)}
                          className="owb-groups__avatar owb-groups__avatar--sm"
                        />
                        <span className="owb-groups__roster-name">{displayPositionName(memberId)}</span>
                      </li>
                    );
                  })}
                </ul>
                {nonMembers.length > 0 ? (
                  <label className="owb-groups__add-member">
                    <UserRoundPlus aria-hidden="true" size={13} />
                    <AntSelect
                      classNames={{ popup: { root: "owb-conversation-select-popup" } }}
                      aria-label={t("grp.addMember")}
                      value={undefined}
                      placeholder={t("grp.addMemberPh")}
                      showSearch
                      optionFilterProp="label"
                      filterOption={filterPositionOption}
                      suffixIcon={<Search aria-hidden="true" size={13} />}
                      popupMatchSelectWidth={false}
                      listHeight={240}
                      onChange={(next) => {
                        if (next) void addMember(next);
                      }}
                      options={nonMembers.map((position) => ({
                        value: position.id,
                        label: position.name,
                      }))}
                    />
                  </label>
                ) : null}
              </aside>

              <div className="owb-groups__timeline" aria-label={t("grp.timeline")} aria-busy={timelineLoading}>
              {timelineItems.map((entry) => {
                if (entry.kind === "user") {
                  const item = entry.item;
                  return (
                    <div className="owb-bubble-turn" key={entry.key}>
                      <div className="owb-bubble-row owb-bubble-row--operator">
                        <article className="owb-bubble owb-bubble--operator">
                          <header className="owb-bubble__header">
                            <span className="owb-bubble__avatar owb-bubble__avatar--operator" title={t("grp.operator")} aria-hidden="true">
                              <UserRound size={11} />
                            </span>
                            <b className="owb-bubble__name">{t("grp.you")}</b>
                            <span className="owb-bubble__role">{t("grp.operator")}</span>
                            <time className="owb-bubble__time" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
                              {timeShort(item.createdAt)}
                            </time>
                          </header>
                          <p className="owb-bubble__text">{renderMentionText(item.input)}</p>
                          <p className="owb-turn-composer__hint">{t(item.mode === "relay" ? "grp.modeRelay" : "grp.modeParallel")} · {item.mentions.map(displayPositionName).join(item.mode === "relay" ? " → " : nameSep)}</p>
                        </article>
                      </div>
                    </div>
                  );
                }
                const { turn, isLive } = entry;
                return (
                  <div className="owb-bubble-row owb-bubble-row--employee" key={entry.key} {...(isLive ? { "aria-live": "polite" } : {})}>
                    <article className={`owb-bubble owb-bubble--employee ${isLive ? "is-running" : `is-${turn.status}`}`}>
                      <header className="owb-bubble__header">
                        <PositionAvatar
                          colors={positionColors}
                          sources={avatarUrls}
                          id={turn.positionId}
                          name={turn.positionName}
                          className="owb-bubble__avatar"
                        />
                        <b className="owb-bubble__name">@{turn.positionName}</b>
                        <span className="owb-bubble__eng">
                          <EngineIcon engine={turn.engine} />
                          {engineLabel(turn.engine)}
                        </span>
                        {isLive ? (
                          <span className="owb-led owb-led--running" aria-label={t("grp.turnInProgress")} />
                        ) : (
                          <time className="owb-bubble__time" dateTime={turn.createdAt} title={new Date(turn.createdAt).toLocaleString()}>
                            {timeShort(turn.createdAt)}
                          </time>
                        )}
                      </header>
                      {isLive ? <ProgressTrail turn={turn} /> : turn.errorCode !== "group_relay_blocked" ? <ProgressTrail turn={turn} /> : null}
                      {turn.output ? (
                        <GroupBubbleExpand
                          summaryClassName="owb-turn__output owb-clamp-2"
                          summaryTitle={turn.output}
                          summaryChildren={turn.output}
                          aria-label={t("grp.expandOutput")}
                          bodyChildren={<Markdown content={turn.output} />}
                        />
                      ) : isLive ? (
                        <TypingIndicator />
                      ) : null}
                      {!isLive && (turn.status === "failed" || turn.status === "indeterminate") && turn.error ? (
                        <GroupBubbleExpand
                          summaryClassName="owb-turn__error owb-clamp-2"
                          summaryTitle={turn.error}
                          summaryChildren={turn.error}
                          aria-label={t("grp.expandOutput")}
                          bodyChildren={<Markdown content={turn.error} />}
                        />
                      ) : null}
                      {!isLive && turn.status === "indeterminate" ? (
                        <p className="owb-turn__warning owb-clamp-2">{t(turn.errorCode === "group_relay_blocked" ? "grp.relayBlocked" : "grp.untrustedWarning")}</p>
                      ) : null}
                    </article>
                  </div>
                );
              })}
              {!timelineLoading && timelineItems.length === 0 ? (
                <p className="owb-muted">{t("grp.emptyTimeline")}</p>
              ) : null}
              </div>
            </div>

            <form
              className="owb-turn-composer owb-groups__composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div className="owb-groups__mention-picker" aria-label={t("grp.mentionAria")}>
                <span className="owb-groups__mention-label">
                  <UsersRound aria-hidden="true" size={13} />
                  {t("grp.recipientLabel")}
                </span>
                <AntSelect
                  classNames={{ popup: { root: "owb-conversation-select-popup" } }}
                  mode="multiple"
                  aria-label={t("grp.mentionAria")}
                  placeholder={t("grp.mentionPh")}
                  showSearch
                  optionFilterProp="label"
                  filterOption={filterPositionOption}
                  value={[...mentions]}
                  maxTagCount="responsive"
                  popupMatchSelectWidth={false}
                  onChange={(values) => setMentions(new Set(values as string[]))}
                  options={selectedGroup.members.map((memberId) => ({
                    value: memberId,
                    label: `@${displayPositionName(memberId)}`,
                  }))}
                />
              </div>
              <label className="owb-group-dispatch-mode">
                <span>{t("grp.dispatchMode")}</span>
                <AntSelect classNames={{ popup: { root: "owb-conversation-select-popup" } }}
                  aria-label={t("grp.dispatchMode")} value={dispatchMode} disabled={sending}
                  onChange={(value) => setDispatchMode(value as "parallel" | "relay")}
                  options={[{ value: "parallel", label: t("grp.modeParallel") }, { value: "relay", label: t("grp.modeRelay") }]} />
              </label>
              {dispatchMode === "relay" ? <p className="owb-turn-composer__hint">{t("grp.relayOrder", { order: [...mentions].map(displayPositionName).join(" → ") })}</p> : null}
              <div className="owb-turn-composer__surface">
                <Input.TextArea
                  value={input}
                  rows={3}
                  aria-label={t("grp.messageAria")}
                  placeholder={mentions.size > 0
                    ? t("grp.sendTo", { list: [...mentions].map((id) => `@${displayPositionName(id)}`).join(nameSep) })
                    : t("grp.routePh")}
                  disabled={sending || (mentionedPositionIds.length > 0 && !mentionsReady)}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    const native = event.nativeEvent as KeyboardEvent;
                    if (native.isComposing || native.keyCode === 229) return;
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <AntButton
                  type="primary"
                  htmlType="submit"
                  disabled={sending || input.trim().length === 0 || mentions.size === 0 || !mentionsReady}
                  aria-label={t("grp.send")}
                  icon={<ArrowUp aria-hidden="true" size={15} />}
                />
              </div>
              <DiagnosticNotice className="owb-turn-composer__hint"
                message={mentions.size === 0
                  ? t("grp.hintRoute")
                  : mentionsReady
                    ? t("grp.hintMentions", { count: mentions.size })
                    : t("turn.engineNotReady", { engine: engineLabel(unavailableMention!.engine) })}
                availabilityCheck={mentions.size > 0 && !mentionsReady ? availabilityCheck : undefined}
                diagnostic={mentions.size > 0 && !mentionsReady ? engineAvailability[unavailableMention!.engine]?.reason : undefined}
                diagnosticKey={`${selectedGroup?.conversationRef}:${unavailableMention?.positionId}:${unavailableMention?.engine}`} />
            </form>
          </>
        )}
      </div>
      {selectedGroup !== null && (
        <DismissGroupModal
          open={dismissOpen}
          groupName={groupLabel(selectedGroup)}
          busy={dismissing}
          onOpenChange={setDismissOpen}
          onConfirm={dismissGroup}
        />
      )}
    </section>
  );
}

function DismissGroupModal({
  open,
  groupName,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  groupName: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  if (!open) return null;
  return (
    <div className="owb-modal" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onOpenChange(false);
    }}>
      <section
        className="owb-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="owb-modal__header">
          <div>
            <h2 id={titleId}>{t("grp.dismissTitle", { name: groupName })}</h2>
            <p id={descriptionId}>{t("grp.dismissDesc")}</p>
          </div>
          <button type="button" className="owb-modal__close" aria-label={t("dlg.close")} onClick={() => onOpenChange(false)}>×</button>
        </header>
        <footer className="owb-modal__footer">
          <AntButton disabled={busy} onClick={() => onOpenChange(false)}>{t("grp.dismissCancel")}</AntButton>
          <AntButton danger disabled={busy} onClick={onConfirm}>{t("grp.dismissConfirm")}</AntButton>
        </footer>
      </section>
    </div>
  );
}
