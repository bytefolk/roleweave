import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button as AntButton, Input, Select as AntSelect } from "antd";
import { ArrowUp, Plus, Search, UserRound, UserRoundPlus, UsersRound } from "lucide-react";
import { useOwbLocale, useT } from "@roleweave/ui";
import { PositionAvatar } from "../PositionAvatar";
import { TypingIndicator } from "../turns/TurnThread";
import type { GroupConversation, GroupConversationList, GroupTimeline } from "@roleweave/shared";
import { EngineSelect, useEngineLabel } from "../turns/TurnPanel";
import { EngineIcon } from "../turns/engine-icon";
import { adaptTurnRecord } from "../turns/adapter";
import type { LiveRunState } from "../turns/turnStream";
import type { PositionMentionOption, TurnEngine, TurnEngineAvailability } from "../turns/types";

export interface GroupsPanelProps {
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  positionNames: Record<string, string>;
  /** Avatar background colors keyed by position id (metadata.color); positions
   * without one get the same deterministic hue the org tree uses (#53). */
  positionColors?: Record<string, string>;
  /** Prefilled group draft from the org-tree entry (#53, DS-34-001 §1.3):
   * opens the create panel with these members checked. The nonce re-fires
   * repeated entries on the same member set. Explicit draft only — creation
   * still requires the operator to confirm ≥2 members. */
  draftSeed?: { members: string[]; nonce: number } | null;
  engine: TurnEngine;
  engineAvailability: Record<TurnEngine, TurnEngineAvailability>;
  /** Shared SSE projection; group runs carry groupRef and are filtered here. */
  liveRuns: Record<string, LiveRunState>;
  onSelectEngine: (engine: TurnEngine) => void;
  /** 202 spawn list, reported upward so the shared stream seeds live buffers. */
  onSpawnRuns: (
    groupRef: string,
    messageId: string,
    spawns: Array<{ turnId: string; positionId: string }>,
    input: string,
    engine: TurnEngine,
  ) => void;
  /** Persisted timeline reconciliation clears missed/late SSE live markers. */
  onReconcileTimeline: (timeline: GroupTimeline) => void;
}

const GROUP_ENGINES: TurnEngine[] = ["qoder", "claude-code", "claude-local"];
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
  workspaceOpen,
  positions,
  positionNames,
  positionColors,
  draftSeed,
  engine,
  engineAvailability,
  liveRuns,
  onSelectEngine,
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
  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  useEffect(() => {
    selectedRefRef.current = selectedRef;
  }, [selectedRef]);

  const loadGroups = useCallback(async () => {
    if (!workspaceOpen) {
      setGroups([]);
      setSelectedRef(null);
      return;
    }
    try {
      const res = await window.owb.groups();
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
      setGroupsError(t("grp.listFailOffline"));
    }
  }, [t, workspaceOpen]);

  const loadTimeline = useCallback(async (conversationRef: string, background = false) => {
    const request = ++timelineRequestRef.current;
    if (!background) {
      foregroundTimelineRequestRef.current = request;
      setTimelineLoading(true);
    }
    try {
      const res = await window.owb.groupTimeline(conversationRef);
      if (selectedRefRef.current !== conversationRef || request !== timelineRequestRef.current) return;
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
      if (selectedRefRef.current === conversationRef && request === timelineRequestRef.current) {
        setPanelError(t("grp.timelineFailOffline"));
      }
    } finally {
      if (
        !background && selectedRefRef.current === conversationRef &&
        request === foregroundTimelineRequestRef.current
      ) {
        setTimelineLoading(false);
      }
    }
  }, [onReconcileTimeline, t]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (selectedRef === null) {
      setTimeline(null);
      return;
    }
    setMentions(new Set());
    setInput("");
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
    const members = [...draftMembers];
    if (members.length < 2 || creating) return;
    setCreating(true);
    setPanelError(null);
    try {
      const res = await window.owb.createGroup({ memberPositionIds: members });
      if (res.status !== 201) {
        setPanelError(apiErrorMessage(res.body, t("grp.createFail")));
        return;
      }
      const created = res.body as GroupConversation;
      setDraftMembers(new Set());
      setCreateOpen(false);
      await loadGroups();
      setSelectedRef(created.conversationRef);
    } catch {
      setPanelError(t("grp.createFailOffline"));
    } finally {
      setCreating(false);
    }
  }, [creating, draftMembers, loadGroups, t]);

  const addMember = useCallback(async (positionId: string) => {
    const ref = selectedRefRef.current;
    if (ref === null || !positionId) return;
    try {
      const res = await window.owb.addGroupMember({ conversationRef: ref, positionId });
      if (res.status !== 200) {
        setPanelError(apiErrorMessage(res.body, t("grp.addFail")));
        return;
      }
      setPanelError(null);
      await loadGroups();
      void loadTimeline(ref);
    } catch {
      setPanelError(t("grp.addFailOffline"));
    }
  }, [loadGroups, loadTimeline, t]);

  const send = useCallback(async () => {
    const ref = selectedRefRef.current;
    const trimmed = input.trim();
    if (ref === null || trimmed.length === 0 || mentions.size === 0 || sending) return;
    setSending(true);
    setPanelError(null);
    try {
      const res = await window.owb.createGroupTurn({
        conversationRef: ref,
        input: trimmed,
        engine,
        mentions: [...mentions],
      });
      if (res.status !== 202) {
        setPanelError(apiErrorMessage(res.body, t("grp.turnFail")));
        return;
      }
      const body = res.body as { conversationRef: string; messageId: string; spawns: Array<{ turnId: string; positionId: string }> };
      onSpawnRuns(ref, body.messageId, body.spawns, trimmed, engine);
      setInput("");
      setMentions(new Set());
      void loadTimeline(ref);
    } catch {
      setPanelError(t("grp.turnFailOffline"));
    } finally {
      setSending(false);
    }
  }, [engine, input, loadTimeline, mentions, onSpawnRuns, sending, t]);

  /** Merge persisted timeline with live SSE buffers for this group. A run
   * whose turnId is already persisted is suppressed — the record wins. */
  const displayItems = useMemo(() => {
    const persistedTurnIds = new Set(
      timeline?.items.filter((item) => item.kind === "member").map((item) => item.turn.turnId) ?? [],
    );
    const live = Object.entries(liveRuns)
      .filter(([runId, run]) =>
        run.groupRef === selectedRef && !persistedTurnIds.has(run.turnId ?? runId),
      )
      .map(([runId, run]) => ({
        key: `live-${runId}`,
        turn: {
          id: runId,
          positionId: run.positionId,
          positionName: displayPositionName(run.positionId),
          engine: run.engine,
          input: run.input,
          status: "running" as const,
          createdAt: run.startedAt,
          ...(run.text !== "" ? { output: run.text } : {}),
          ...(run.totalTokens !== null ? { totalTokens: run.totalTokens } : {}),
        },
      }));
    const persisted = timeline?.items ?? [];
    return { persisted, live };
  }, [liveRuns, positionNames, selectedRef, t, timeline]);
  const unrenderableOutput = t("turn.unrenderableOutput");

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
            </header>

            <div className="owb-groups__panel-sub">
              <label className="owb-turn-engine">
                <span className="owb-turn-control__label">Agent Host</span>
                <EngineSelect
                  engines={GROUP_ENGINES}
                  engineAvailability={engineAvailability}
                  value={engine}
                  onChange={onSelectEngine}
                />
              </label>
            </div>

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
              {displayItems.persisted.map((item) =>
                item.kind === "user" ? (
                  <div className="owb-bubble-turn" key={item.messageId}>
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
                      </article>
                    </div>
                  </div>
                ) : (
                  (() => {
                    const turn = adaptTurnRecord(
                      item.turn,
                      displayPositionName(item.turn.positionId),
                      unrenderableOutput,
                    );
                    return (
                      <div className="owb-bubble-row owb-bubble-row--employee" key={turn.id}>
                        <article className={`owb-bubble owb-bubble--employee is-${turn.status}`}>
                          <header className="owb-bubble__header">
                            <PositionAvatar
                              colors={positionColors}
                              id={turn.positionId}
                              name={turn.positionName}
                              className="owb-bubble__avatar"
                            />
                            <b className="owb-bubble__name">@{turn.positionName}</b>
                            <span className="owb-bubble__eng">
                              <EngineIcon engine={turn.engine} />
                              {engineLabel(turn.engine)}
                            </span>
                            <time className="owb-bubble__time" dateTime={turn.createdAt} title={new Date(turn.createdAt).toLocaleString()}>
                              {timeShort(turn.createdAt)}
                            </time>
                          </header>
                          {turn.output ? (
                            <p className="owb-turn__output owb-clamp-2" title={turn.output}>{turn.output}</p>
                          ) : null}
                          {turn.status === "failed" && turn.error ? (
                            <p className="owb-turn__error owb-clamp-2" title={turn.error}>{turn.error}</p>
                          ) : null}
                          {turn.status === "indeterminate" ? (
                            <p className="owb-turn__warning owb-clamp-2">{t("grp.untrustedWarning")}</p>
                          ) : null}
                        </article>
                      </div>
                    );
                  })()
                ),
              )}
              {displayItems.live.map(({ key, turn }) => (
                <div className="owb-bubble-row owb-bubble-row--employee" key={key} aria-live="polite">
                  <article className="owb-bubble owb-bubble--employee is-running">
                    <header className="owb-bubble__header">
                      <PositionAvatar
                        colors={positionColors}
                        id={turn.positionId}
                        name={turn.positionName}
                        className="owb-bubble__avatar"
                      />
                      <b className="owb-bubble__name">@{turn.positionName}</b>
                      <span className="owb-bubble__eng">
                        <EngineIcon engine={turn.engine} />
                        {engineLabel(turn.engine)}
                      </span>
                      <span className="owb-led owb-led--running" aria-label={t("grp.turnInProgress")} />
                    </header>
                    {turn.output ? (
                      <p className="owb-turn__output owb-clamp-2" title={turn.output}>{turn.output}</p>
                    ) : (
                      <TypingIndicator />
                    )}
                  </article>
                </div>
              ))}
              {!timelineLoading && displayItems.persisted.length === 0 && displayItems.live.length === 0 ? (
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
              <div className="owb-turn-composer__surface">
                <Input.TextArea
                  value={input}
                  rows={3}
                  aria-label={t("grp.messageAria")}
                  placeholder={mentions.size > 0
                    ? t("grp.sendTo", { list: [...mentions].map((id) => `@${displayPositionName(id)}`).join(nameSep) })
                    : t("grp.routePh")}
                  disabled={sending || !engineAvailability[engine].ready}
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
                  disabled={sending || input.trim().length === 0 || mentions.size === 0 || !engineAvailability[engine].ready}
                  aria-label={t("grp.send")}
                  icon={<ArrowUp aria-hidden="true" size={15} />}
                />
              </div>
              <p className="owb-turn-composer__hint" role="status">
                {engineAvailability[engine].ready
                  ? mentions.size === 0
                    ? t("grp.hintRoute")
                    : t("grp.hintMentions", { count: mentions.size })
                  : engineAvailability[engine].reason ?? t("turn.engineNotReady", { engine: engineLabel(engine) })}
              </p>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
