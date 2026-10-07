import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Select, Tooltip } from "antd";
import { Maximize2, Minimize2, Info, UserRound } from "lucide-react";
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
  onContinue?: (positionId: string, sessionId: string) => void;
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  /** Hide when the enclosing employee workspace owns the selection. */
  showEmployeePicker?: boolean;
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

function sourceTabStatus(source: MemorySource, summary: ContextSourceSummary | undefined, t: ReturnType<typeof useT>): string {
  if (source === "shared") return t("memory.teamScope");
  if (source === "sessions") return t("memory.sessionScope");
  if (source === "drive") return t("services.memSource");
  return sourceStatus(summary, t);
}

export function MemoryModule({
  workspaceOpen,
  positions,
  selectedPositionId,
  showEmployeePicker = true,
  position,
  initialSource = "docs",
  onContinue,
  resourceRequest,
}: MemoryModuleProps) {
  const t = useT();
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
    <section className="owb-memory-module" data-reading-focus={focused} aria-label={t("memory.moduleAria")}>
      {showEmployeePicker ? (
        <header className="owb-memory-module__header">
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
        </header>
      ) : null}

      <div className="owb-memory-module__body">
        <section className="owb-memory-workspace" aria-label={t("memory.detailAria")}>
          <header className="owb-memory-tabs">
            <nav className="owb-context-tabs owb-context-tabs--subtle" aria-label={t("memory.sourcesTitle")}>
              {(["docs", "shared", "sessions", "drive"] as const).map((source) => (
                <Tooltip key={source} trigger={["hover", "focus"]} title={`${sourceTitle(source, t)} · ${sourceTabStatus(source, source === "docs" ? summaries.get(sourceKind(source)) : undefined, t)}`}>
                  <Button type="text"
                    aria-pressed={activeSource === source}
                    aria-label={t("memory.openSource", { name: sourceTitle(source, t) })}
                    onClick={() => setActiveSource(source)}>
                    {sourceTitle(source, t)}
                  </Button>
                </Tooltip>
              ))}
            </nav>
            <div className="owb-memory-tabs__actions">
              {activeSummary ? <span className="owb-memory-tabs__status">{sourceStatus(activeSummary, t)}</span> : null}
              {activeSource === "shared" ? <ServiceLaunch kind="doc" /> : activeSource === "drive" ? <ServiceLaunch kind="mem" /> : null}
              {isDocument ? <Tooltip trigger={["hover", "focus"]} title={t(focused ? "memory.exitFocus" : "memory.focusReading")}>
                <Button type="text" size="small" aria-label={t(focused ? "memory.exitFocus" : "memory.focusReading")} aria-pressed={focused}
                  icon={focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={() => setReadingFocus(!readingFocus)} />
              </Tooltip> : null}
              <Tooltip trigger={["hover", "focus"]} title={`${t(`memory.scope.${activeSource}`)} · ${sourceTabStatus(activeSource, activeSummary, t)}`}>
                <Button type="text" size="small" aria-label={t("memory.sourceInfo")} icon={<Info size={14} />} />
              </Tooltip>
            </div>
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
