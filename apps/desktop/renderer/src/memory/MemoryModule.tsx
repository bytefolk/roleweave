import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Select, Tooltip } from "antd";
import { Cloud, FileText, History, Library, UserRound, PanelLeftClose, PanelLeftOpen, Maximize2, Minimize2, Info } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { PositionCardData } from "@roleweave/ui";
import type { ContextSourceSummary } from "@roleweave/shared";
import type { PositionMentionOption } from "../turns/types";
import { DocsModule } from "../docs/DocsModule";
import { DriveModule } from "../drive/DriveModule";
import { SessionMemory } from "./SessionMemory";
import { ServiceLaunch } from "../settings/ServiceLaunch";
import { SERVICES_CHANGED } from "../settings/ServiceConnections";

export type MemorySource = "docs" | "shared" | "sessions" | "drive";

export interface MemoryModuleProps {
  onCollaborate?: () => void;
  onContinue?: (positionId: string, sessionId: string) => void;
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  position?: PositionCardData | null;
  initialSource?: MemorySource;
  resourceRequest?: { positionId: string; path: string; nonce: number } | null;
}

function sourceKind(source: MemorySource): ContextSourceSummary["kind"] {
  return source === "docs" ? "workspace_docs" : "mem_drive";
}

function sourceTitle(source: MemorySource, t: ReturnType<typeof useT>): string {
  if (source === "shared") return t("memory.shared");
  if (source === "sessions") return t("memory.sessions");
  if (source === "docs") return t("memory.docsTitle");
  return t("memory.driveTitle");
}

function sourceStatus(source: ContextSourceSummary | undefined, t: ReturnType<typeof useT>): string {
  if (!source) return t("memory.sourceNotLoaded");
  if (source.state === "ready") return source.binding === "bound" ? t("memory.sourceBound") : t("memory.sourceAvailable");
  if (source.state === "not_configured") return t("memory.sourceNotConfigured");
  if (source.state === "empty") return t("memory.sourceEmpty");
  return t("memory.sourceError");
}

function SourceItem({ source, summary, active, onSelect }: {
  source: MemorySource;
  summary?: ContextSourceSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const Icon = source === "docs" ? FileText : source === "shared" ? Library : source === "sessions" ? History : Cloud;
  const status = source === "shared" ? t("memory.teamScope") : source === "sessions" ? t("memory.sessionScope") : source === "drive" ? t("services.memSource") : sourceStatus(summary, t);
  return (
    <Tooltip title={`${sourceTitle(source, t)} · ${status}`} placement="right">
      <button
        type="button"
        className="owb-memory-source"
        aria-pressed={active}
        aria-label={t("memory.openSource", { name: sourceTitle(source, t) })}
        onClick={onSelect}
      >
        <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
        <span className="owb-memory-source__label">{sourceTitle(source, t)}</span>
      </button>
    </Tooltip>
  );
}

export function MemoryModule({
  workspaceOpen,
  positions,
  selectedPositionId,
  position,
  initialSource = "docs",
  onCollaborate,
  onContinue,
  resourceRequest,
}: MemoryModuleProps) {
  const t = useT();
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [readingFocus, setReadingFocus] = useState(false);
  const [positionId, setPositionId] = useState<string | null>(selectedPositionId);
  const [positionData, setPositionData] = useState<PositionCardData | null>(
    position?.id === selectedPositionId ? position : null,
  );
  const [activeSource, setActiveSource] = useState<MemorySource>(initialSource);
  const [sourceRevision, setSourceRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setSourceRevision((value) => value + 1);
    window.addEventListener(SERVICES_CHANGED, refresh);
    return () => window.removeEventListener(SERVICES_CHANGED, refresh);
  }, []);

  useEffect(() => {
    setPositionId(selectedPositionId);
  }, [selectedPositionId]);

  useEffect(() => {
    let cancelled = false;
    setPositionData(null);
    if (positionId === null) {
      setPositionData(null);
      return () => {
        cancelled = true;
      };
    }
    if (position?.id === positionId) {
      setPositionData(position);
      return () => {
        cancelled = true;
      };
    }
    if (typeof window.owb.position !== "function") {
      setPositionData(null);
      return () => {
        cancelled = true;
      };
    }
    void window.owb.position(positionId).then((response) => {
      if (cancelled || response.status !== 200) return;
      const body = response.body as { position?: PositionCardData };
      setPositionData(body.position ?? null);
    }).catch(() => { if (!cancelled) setPositionData(null); });
    return () => {
      cancelled = true;
    };
  }, [position, positionId]);

  useEffect(() => {
    setActiveSource(initialSource);
  }, [initialSource]);

  const selectedPosition = positionData?.id === positionId ? positionData : null;
  const contextSources = selectedPosition?.contextSources ?? [];
  const summaries = useMemo(() => {
    const byKind = new Map<ContextSourceSummary["kind"], ContextSourceSummary>();
    for (const source of contextSources) {
      byKind.set(source.kind, source);
    }
    return byKind;
  }, [contextSources]);
  if (!workspaceOpen) {
    return (
      <section className="owb-memory-module" aria-label={t("memory.moduleAria")}>
        <Empty description={t("tree.notOpened")} />
      </section>
    );
  }

  const isDocument = activeSource === "docs" || activeSource === "shared";
  const focused = isDocument && readingFocus;
  const activeSummary = activeSource === "docs" ? summaries.get(sourceKind(activeSource)) : undefined;
  return (
    <section className="owb-memory-module" data-sources-collapsed={sourcesCollapsed} data-reading-focus={focused} aria-label={t("memory.moduleAria")}>
      <header className="owb-memory-module__header">
        <div className="owb-memory-module__title">
          <h1>{t("memory.title")}</h1>
        </div>
        <label className="owb-memory-module__picker">
          <UserRound aria-hidden="true" size={14} />
          <Select
            aria-label={t("memory.pickEmployee")}
            placeholder={t("memory.pickEmployee")}
            showSearch
            optionFilterProp="label"
            allowClear
            value={positionId ?? undefined}
            onChange={(value) => setPositionId(value ?? null)}
            options={positions.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            popupMatchSelectWidth={false}
          />
        </label>
        {isDocument ? <Tooltip title={t(focused ? "memory.exitFocus" : "memory.focusReading")}>
          <Button aria-label={t(focused ? "memory.exitFocus" : "memory.focusReading")} aria-pressed={focused}
            icon={focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={() => setReadingFocus(!readingFocus)} />
        </Tooltip> : null}
        {onCollaborate ? <Button onClick={onCollaborate}>{t("memory.collaborate")}</Button> : null}
      </header>

      <div className="owb-memory-module__body">
        <aside className="owb-memory-sidebar">
          <div className="owb-memory-sidebar__heading">
            <span>{t("memory.sourcesTitle")}</span>
            <Tooltip title={t(sourcesCollapsed ? "memory.expandSources" : "memory.collapseSources")}>
              <Button type="text" size="small" aria-label={t(sourcesCollapsed ? "memory.expandSources" : "memory.collapseSources")}
                aria-expanded={!sourcesCollapsed} icon={sourcesCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                onClick={() => setSourcesCollapsed(!sourcesCollapsed)} />
            </Tooltip>
          </div>
          <nav aria-label={t("memory.sourcesTitle")}>
            {(["docs", "shared", "sessions", "drive"] as const).map((source) => (
              <SourceItem key={source} source={source}
                summary={source === "docs" ? summaries.get(sourceKind(source)) : undefined}
                active={activeSource === source} onSelect={() => setActiveSource(source)} />
            ))}
          </nav>
          <p className="owb-memory-sidebar__hint">{t("memory.sidebarHint")}</p>
        </aside>
        <section className="owb-memory-workspace" aria-label={t("memory.detailAria")}>
          <header className="owb-memory-location">
            <h2>{sourceTitle(activeSource, t)}</h2>
            {activeSummary ? <span className="owb-memory-location__status">{activeSource === "docs" && (activeSummary.state === "ready" || activeSummary.state === "empty") ? t("reading.docs.readOnlyCreate") : sourceStatus(activeSummary, t)}</span> : null}
            {activeSource === "shared" ? <ServiceLaunch kind="doc" /> : activeSource === "drive" ? <ServiceLaunch kind="mem" /> : null}
            <Tooltip title={t(`memory.scope.${activeSource}`)}>
              <Button type="text" size="small" aria-label={t("memory.sourceInfo")} icon={<Info size={14} />} />
            </Tooltip>
          </header>
          {activeSource === "docs" || activeSource === "shared" ? (
            <DocsModule
              key={`${activeSource}:${sourceRevision}`}
              surface={activeSource === "shared" ? "plane" : "position"}
              embedded
              workspaceOpen={workspaceOpen}
              positions={positions}
              selectedPositionId={positionId}
              resourceRequest={activeSource === "docs" ? resourceRequest : null}
            />
          ) : null}
          {activeSource === "sessions" ? <SessionMemory key={positionId} positionId={positionId} onContinue={onContinue} /> : null}
          {activeSource === "drive" ? <DriveModule key={sourceRevision} embedded workspaceOpen={workspaceOpen} /> : null}
        </section>
      </div>
    </section>
  );
}
