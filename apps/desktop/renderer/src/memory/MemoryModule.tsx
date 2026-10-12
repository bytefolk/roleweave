import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Select, Tooltip } from "antd";
import { Maximize2, Minimize2, Info, UserRound, BookOpen, Files, MessagesSquare, HardDrive } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { PositionCardData } from "@roleweave/ui";
import type { ContextSourceSummary } from "@roleweave/shared";
import type { VaultSourceRef } from "@roleweave/shared";
import type { PositionMentionOption } from "../turns/types";
import { VaultModule } from "./VaultModule";
import { DriveModule } from "../drive/DriveModule";
import { ServiceLaunch } from "../settings/ServiceLaunch";
import { SERVICES_CHANGED } from "../settings/ServiceConnections";

export type MemorySource = "notes" | "docs" | "shared" | "sessions" | "drive";

export interface MemoryModuleProps {
  workspaceKey?: string;
  onContinue?: (positionId: string, sessionId: string) => void;
  onOpenSource?: (source: VaultSourceRef) => void;
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  /** Hide when the enclosing employee workspace owns the selection. */
  showEmployeePicker?: boolean;
  position?: PositionCardData | null;
  initialSource?: MemorySource;
  resourceRequest?: { positionId: string; path: string; nonce: number } | null;
}

function sourceTitle(source: MemorySource, t: ReturnType<typeof useT>): string {
  if (source === "notes") return t("vault.notes");
  if (source === "drive") return t("vault.drive");
  return t(`resources.${source}.title`);
}
function normalizeSource(source: MemorySource): "notes" | "drive" { return source === "drive" ? "drive" : "notes"; }

const sourceGroups = [
  { key: "documents", sources: ["notes"] },
  { key: "storage", sources: ["drive"] },
] as const;
const sourceScopes: Record<MemorySource, string> = { notes: "workspace", docs: "personal", shared: "team", sessions: "process", drive: "files" };
const sourceIcons = { notes: BookOpen, docs: BookOpen, shared: Files, sessions: MessagesSquare, drive: HardDrive };

function sourceStatus(source: ContextSourceSummary | undefined, t: ReturnType<typeof useT>): string {
  if (!source) return t("memory.sourceNotLoaded");
  if (source.state === "ready") return source.binding === "bound" ? t("memory.sourceBound") : t("memory.sourceAvailable");
  if (source.state === "not_configured") return t("memory.sourceNotConfigured");
  if (source.state === "empty") return t("memory.sourceEmpty");
  return t("memory.sourceError");
}

export function MemoryModule({
  workspaceKey,
  workspaceOpen,
  positions,
  selectedPositionId,
  showEmployeePicker = true,
  position,
  initialSource = "docs",
  onContinue,
  onOpenSource,
  resourceRequest,
}: MemoryModuleProps) {
  const t = useT();
  const [readingFocus, setReadingFocus] = useState(false);
  const [positionId, setPositionId] = useState<string | null>(selectedPositionId);
  const [positionData, setPositionData] = useState<PositionCardData | null>(
    position?.id === selectedPositionId ? position : null,
  );
  const [activeSource, setActiveSource] = useState<MemorySource>(normalizeSource(initialSource));
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
    setActiveSource(normalizeSource(initialSource));
  }, [initialSource]);

  useEffect(() => {
    if (!resourceRequest) return;
    // Resource links are commands, not a default tab preference. A fresh nonce
    // must reveal the requested role file even if initialSource is still docs.
    setActiveSource("notes");
    setPositionId(resourceRequest.positionId);
  }, [resourceRequest?.nonce, resourceRequest?.positionId, resourceRequest?.path]);

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
      <section className="owb-memory-module" aria-label={t("vault.moduleAria")}>
        <Empty description={t("tree.notOpened")} />
      </section>
    );
  }

  const isDocument = activeSource === "notes";
  const focused = isDocument && readingFocus;
  const activeSummary = activeSource === "docs" ? summaries.get("workspace_docs") : undefined;
  const scopeLabel = activeSource === "notes" ? t("vault.scope") : t(`resources.scope.${sourceScopes[activeSource]}`);
  const navigationOptions = sourceGroups.map(group => ({ label: t(`resources.group.${group.key}`),
    options: group.sources.map(source => ({ value: source,
      label: `${sourceTitle(source, t)} · ${source === "notes" ? t("vault.scope") : t(`resources.scope.${sourceScopes[source]}`)}` })) }));
  return (
    <section className="owb-memory-module" data-reading-focus={focused} aria-label={t("vault.moduleAria")}>
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
        <nav className="owb-memory-navigation" aria-label={t("vault.navigation")}>
          {sourceGroups.map(group => <div key={group.key} className="owb-memory-navigation__group" role="group" aria-label={t(`resources.group.${group.key}`)}>
            <h3>{t(`resources.group.${group.key}`)}</h3>
            {group.sources.map(source => {
              const Icon = sourceIcons[source];
              return <Button key={source} type="text" className="owb-memory-navigation__source"
                aria-current={activeSource === source ? "page" : undefined}
                aria-pressed={activeSource === source}
                aria-label={sourceTitle(source, t)}
                onClick={() => setActiveSource(source)}>
                <Icon size={16} aria-hidden="true" /><span><strong>{sourceTitle(source, t)}</strong><small>{source === "notes" ? t("vault.scope") : t(`resources.scope.${sourceScopes[source]}`)}</small></span>
              </Button>;
            })}
          </div>)}
        </nav>
        <section className="owb-memory-workspace" aria-label={t("memory.detailAria")}>
          <div className="owb-memory-navigation__compact">
            <Select aria-label={t("resources.selectSource")} value={activeSource}
              options={navigationOptions} onChange={setActiveSource} popupMatchSelectWidth={false} />
          </div>
          <header className="owb-memory-tabs">
            <div className="owb-memory-workspace__identity"><div><h2>{sourceTitle(activeSource, t)}</h2><span>{scopeLabel}</span></div>
              <p>{activeSource === "notes" ? t("vault.purpose") : t(`resources.${activeSource}.purpose`)}</p></div>
            <div className="owb-memory-tabs__actions">
              {activeSummary ? <span className="owb-memory-tabs__status">{sourceStatus(activeSummary, t)}</span> : null}
              {isDocument ? <Tooltip trigger={["hover", "focus"]} title={t(focused ? "memory.exitFocus" : "memory.focusReading")}>
                <Button type="text" size="small" aria-label={t(focused ? "memory.exitFocus" : "memory.focusReading")} aria-pressed={focused}
                  icon={focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={() => setReadingFocus(!readingFocus)} />
              </Tooltip> : null}
              <Tooltip trigger={["hover", "focus"]} title={`${scopeLabel} · ${activeSource === "notes" ? t("vault.purpose") : t(`resources.${activeSource}.purpose`)}${activeSummary ? ` · ${sourceStatus(activeSummary, t)}` : ""}`}>
                <Button type="text" size="small" aria-label={t("memory.sourceInfo")} icon={<Info size={14} />} />
              </Tooltip>
            </div>
          </header>
          <div className="owb-memory-workspace__content">
          {activeSource === "notes" ? <VaultModule key={workspaceKey} workspaceKey={workspaceKey ?? ""} positions={positions} selectedPositionId={positionId}
            resourceRequest={resourceRequest} onOpenSource={onOpenSource ?? (onContinue ? (source) => { if (source.positionId && source.sessionId) onContinue(source.positionId, source.sessionId); } : undefined)} /> : null}
          {activeSource === "drive" ? <DriveModule key={sourceRevision} embedded workspaceOpen={workspaceOpen} workspaceKey={workspaceKey} serviceAction={<ServiceLaunch kind="mem" connectLabel={t("resources.drive.connect")} openLabel={t("resources.drive.open")} />} /> : null}
          </div>
        </section>
      </div>
    </section>
  );
}
