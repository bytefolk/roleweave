import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Empty, Select } from "antd";
import { ArrowUpRight, Cloud, FileText, UserRound } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { PositionCardData } from "@roleweave/ui";
import type { ContextSourceSummary } from "@roleweave/shared";
import type { PositionMentionOption } from "../turns/types";
import { DocsModule } from "../docs/DocsModule";
import { DriveModule } from "../drive/DriveModule";

export type MemorySource = "docs" | "drive";

export interface MemoryModuleProps {
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  position?: PositionCardData | null;
  initialSource?: MemorySource;
}

function sourceKind(source: MemorySource): ContextSourceSummary["kind"] {
  return source === "docs" ? "workspace_docs" : "mem_drive";
}

function sourceTitle(source: MemorySource, t: ReturnType<typeof useT>): string {
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

function SourceCard({
  source,
  summary,
  active,
  onSelect,
}: {
  source: MemorySource;
  summary?: ContextSourceSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const Icon = source === "docs" ? FileText : Cloud;
  const count = summary?.itemCount === undefined
    ? null
    : t("memory.count", { count: summary.itemCount });
  return (
    <button
      type="button"
      className={`owb-memory-source-card is-${source}${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-label={t("memory.openSource", { name: sourceTitle(source, t) })}
      onClick={onSelect}
    >
      <span className="owb-memory-source-card__icon" aria-hidden="true"><Icon size={17} strokeWidth={1.8} /></span>
      <span className="owb-memory-source-card__main">
        <strong>{sourceTitle(source, t)}</strong>
        <span className="owb-memory-source-card__facts">
          {count ? <small>{count}</small> : null}
          {summary?.readOnly ? <small>{t("pos.readOnly")}</small> : null}
        </span>
      </span>
      <span className={`owb-memory-source-card__status is-${summary?.state ?? "unknown"}`}>
        <i aria-hidden="true" />
        {sourceStatus(summary, t)}
      </span>
      <ArrowUpRight aria-hidden="true" size={15} className="owb-memory-source-card__arrow" />
    </button>
  );
}

export function MemoryModule({
  workspaceOpen,
  positions,
  selectedPositionId,
  position,
  initialSource = "docs",
}: MemoryModuleProps) {
  const t = useT();
  const moduleRef = useRef<HTMLElement>(null);
  const [positionId, setPositionId] = useState<string | null>(selectedPositionId);
  const [positionData, setPositionData] = useState<PositionCardData | null>(
    position?.id === selectedPositionId ? position : null,
  );
  const [activeSource, setActiveSource] = useState<MemorySource>(initialSource);

  useEffect(() => {
    if (selectedPositionId !== null) setPositionId(selectedPositionId);
  }, [selectedPositionId]);

  useEffect(() => {
    let cancelled = false;
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
    });
    return () => {
      cancelled = true;
    };
  }, [position, positionId]);

  useEffect(() => {
    setActiveSource(initialSource);
  }, [initialSource]);

  // The memory surface owns the scroll container. Reset it when the user
  // changes the employee or source so the page heading never remains clipped
  // above the viewport after a deep scroll in another source.
  useLayoutEffect(() => {
    const node = moduleRef.current;
    if (!node) return;
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } else {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }
  }, [activeSource, positionId]);

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

  return (
    <section ref={moduleRef} className="owb-memory-module" aria-label={t("memory.moduleAria")}>
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
      </header>

      <section className="owb-memory-sources" aria-labelledby="owb-memory-sources-title">
        <div className="owb-memory-sources__heading">
          <h2 id="owb-memory-sources-title">{t("memory.sourcesTitle")}</h2>
        </div>
        <div className="owb-memory-sources__grid">
          {(["docs", "drive"] as const).map((source) => (
            <SourceCard
              key={source}
              source={source}
              summary={summaries.get(sourceKind(source))}
              active={activeSource === source}
              onSelect={() => setActiveSource(source)}
            />
          ))}
        </div>
      </section>

      <section className="owb-memory-workspace" aria-label={t("memory.detailAria")}>
        {activeSource === "docs" ? (
          <DocsModule
            embedded
            workspaceOpen={workspaceOpen}
            positions={positions}
            selectedPositionId={positionId}
          />
        ) : null}
        {activeSource === "drive" ? <DriveModule embedded workspaceOpen={workspaceOpen} /> : null}
      </section>
    </section>
  );
}
