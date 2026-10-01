import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty, Spin, Tag } from "antd";
import { FileText, Folder, GitBranch, LayoutList, Users } from "lucide-react";
import { useT } from "@roleweave/ui";
import {
  parseSpaceDoc,
  renderSpaceDoc,
  type AcceptanceDecision,
  type AcceptanceRecord,
  type DocsFileEntry,
  type SpaceDoc,
  type SpaceDocCriterion,
  type SpaceDocTask,
} from "@roleweave/shared";
import { Markdown } from "../markdown/Markdown.js";
import { AcceptanceGate } from "./AcceptanceGate.js";
import { buildAcceptanceRecord, type GateDraft } from "./acceptance-gate-model.js";
import "./space.css";

/** The spine file of a space. Every other file in the folder is supporting. */
export const SPACE_SPINE_FILE = "目标.md";

export interface SpaceAgent {
  positionId: string;
  name: string;
  /** Exactly one participant is the owner; it comes from the org, not a space field. */
  owner: boolean;
}

export interface SpaceModuleProps {
  workspaceOpen: boolean;
  /** Name of the space (the folder). */
  spaceName?: string;
  files: DocsFileEntry[];
  /** Injected loader, mirroring DocsPanel's contract so this stays testable. */
  readFile: (path: string) => Promise<{ content: string; version: string }>;
  writeFile?: (path: string, content: string, expectedVersion: string) => Promise<{ version: string }>;
  participants?: SpaceAgent[];
  onOpenBoundSession?: (positionId: string) => void;
  onAccept?: (record: AcceptanceRecord) => void | Promise<void>;
  /** Which file the space is currently focused on; defaults to the spine. */
  requestedPath?: string | null;
}

type SpaceView = "document" | "structure";

function statusTone(status: SpaceDocTask["status"]): string {
  switch (status) {
    case "done":
      return "success";
    case "in_progress":
      return "processing";
    case "blocked":
      return "error";
    case "review":
      return "warning";
    default:
      return "default";
  }
}

export function SpaceModule(props: SpaceModuleProps) {
  const t = useT();
  const [view, setView] = useState<SpaceView>("document");
  const [activePath, setActivePath] = useState<string>(props.requestedPath ?? SPACE_SPINE_FILE);
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<AcceptanceRecord | null>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const file = await props.readFile(path);
        setSource(file.content);
        setVersion(file.version);
      } catch {
        setError(t("space.error.read", { path }));
        setSource("");
      } finally {
        setLoading(false);
      }
    },
    [props, t],
  );

  useEffect(() => {
    if (!props.workspaceOpen) return;
    void load(activePath);
  }, [props.workspaceOpen, activePath, load]);

  const parsed = useMemo(() => parseSpaceDoc(source), [source]);
  const doc = parsed.doc;
  const isSpine = activePath === SPACE_SPINE_FILE;

  const owner = props.participants?.find((agent) => agent.owner);
  const others = props.participants?.filter((agent) => !agent.owner) ?? [];

  const gateDraft: GateDraft = useMemo(
    () => ({
      spaceId: props.spaceName ?? "space",
      positionId: owner?.positionId ?? "operator",
      artifactPath: activePath,
      decidedBy: "operator",
    }),
    [props.spaceName, owner?.positionId, activePath],
  );

  const handleDecide = useCallback(
    async (decision: AcceptanceDecision, record: AcceptanceRecord) => {
      setDecided(record);
      await props.onAccept?.(record);
      if (decision === "accepted" && props.writeFile && isSpine) {
        // Acceptance is the only thing allowed to mark criteria done.
        const next: SpaceDoc = {
          ...doc,
          criteria: doc.criteria.map((criterion) => ({ ...criterion, done: true })),
        };
        const content = renderSpaceDoc(next, source);
        try {
          const result = await props.writeFile(activePath, content, version);
          setSource(content);
          setVersion(result.version);
        } catch {
          setError(t("space.error.write", { path: activePath }));
        }
      }
    },
    [props, doc, source, version, activePath, isSpine, t],
  );

  if (!props.workspaceOpen) {
    return (
      <div className="owb-space-module">
        <Empty description={t("space.emptyWorkspace")} />
      </div>
    );
  }

  return (
    <div className="owb-space-module" data-view={view}>
      <header className="owb-space-header">
        <div className="owb-space-header__title">
          <Folder size={16} aria-hidden="true" />
          <h2>{props.spaceName ?? t("space.untitled")}</h2>
          <Tag className="owb-space-header__root" bordered={false}>
            {t("space.rootHint")}
          </Tag>
        </div>
        <div className="owb-space-header__view">
          <button
            type="button"
            className={view === "document" ? "is-active" : ""}
            onClick={() => setView("document")}
          >
            <FileText size={14} aria-hidden="true" />
            {t("space.view.document")}
          </button>
          <button
            type="button"
            className={view === "structure" ? "is-active" : ""}
            onClick={() => setView("structure")}
          >
            <LayoutList size={14} aria-hidden="true" />
            {t("space.view.structure")}
          </button>
        </div>
      </header>

      <div className="owb-space-body">
        <aside className="owb-space-files">
          <div className="owb-space-files__head">{t("space.filesTitle")}</div>
          <ul className="owb-space-files__list">
            {props.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className={file.path === activePath ? "is-active" : ""}
                  onClick={() => setActivePath(file.path)}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span className="owb-space-files__name">{file.path}</span>
                  {file.path === SPACE_SPINE_FILE ? (
                    <Tag bordered={false} className="owb-space-files__spine">
                      {t("space.spineTag")}
                    </Tag>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="owb-space-files__head">{t("space.participantsTitle")}</div>
          <ul className="owb-space-agents">
            {owner ? (
              <li className="owb-space-agents__item owb-space-agents__item--owner">
                <Users size={13} aria-hidden="true" />
                <span>{owner.name}</span>
                <Tag color="blue" bordered={false}>
                  {t("space.ownerTag")}
                </Tag>
              </li>
            ) : null}
            {others.map((agent) => (
              <li key={agent.positionId} className="owb-space-agents__item">
                <button
                  type="button"
                  onClick={() => props.onOpenBoundSession?.(agent.positionId)}
                  disabled={!props.onOpenBoundSession}
                >
                  {agent.name}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="owb-space-content">
          {loading ? (
            <div className="owb-space-content__loading">
              <Spin />
            </div>
          ) : error ? (
            <div className="owb-space-content__error">{error}</div>
          ) : view === "document" ? (
            <article className="owb-space-doc" data-path={activePath}>
              <Markdown content={source} />
            </article>
          ) : (
            <SpaceStructure doc={doc} decided={decided} />
          )}
        </main>
      </div>

      {isSpine && !loading ? (
        <footer className="owb-space-gate-host">
          <AcceptanceGate draft={gateDraft} criteria={doc.criteria} onDecide={handleDecide} />
        </footer>
      ) : null}
    </div>
  );
}

interface SpaceStructureProps {
  doc: SpaceDoc;
  decided: AcceptanceRecord | null;
}

/** The structural rendering of the same file — never a second copy of it. */
function SpaceStructure({ doc, decided }: SpaceStructureProps) {
  const t = useT();
  const columns: Array<{ id: SpaceDocTask["status"]; label: string }> = [
    { id: "todo", label: t("space.status.todo") },
    { id: "in_progress", label: t("space.status.in_progress") },
    { id: "blocked", label: t("space.status.blocked") },
    { id: "review", label: t("space.status.review") },
    { id: "done", label: t("space.status.done") },
  ];

  return (
    <div className="owb-space-structure">
      <section className="owb-space-structure__section">
        <h3>{t("space.structure.criteria")}</h3>
        {doc.criteria.length === 0 ? (
          <p className="owb-space-structure__hint">{t("space.structure.noCriteria")}</p>
        ) : (
          <ul className="owb-space-criteria-list">
            {doc.criteria.map((criterion: SpaceDocCriterion) => (
              <li key={criterion.criteriaIndex} data-done={criterion.done}>
                <span className="owb-space-criteria-list__box" aria-hidden="true">
                  {criterion.done ? "✓" : ""}
                </span>
                <span>{criterion.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="owb-space-structure__section">
        <h3>{t("space.structure.board")}</h3>
        {doc.tasksUnparseable ? (
          <p className="owb-space-structure__warn">{t("space.structure.unparseable")}</p>
        ) : null}
        <div className="owb-space-board">
          {columns.map((column) => {
            const tasks = doc.tasks.filter((task) => task.status === column.id);
            return (
              <div key={column.id} className="owb-space-board__column">
                <div className="owb-space-board__column-head">
                  <span>{column.label}</span>
                  <Tag bordered={false}>{tasks.length}</Tag>
                </div>
                <ul>
                  {tasks.map((task, index) => (
                    <li key={`${task.title}-${index}`} className="owb-space-board__card">
                      <div className="owb-space-board__card-title">{task.title}</div>
                      {task.assigneePositionId ? (
                        <div className="owb-space-board__card-meta">{task.assigneePositionId}</div>
                      ) : null}
                      {task.dueDate ? (
                        <Tag bordered={false} color={statusTone(task.status)}>
                          {task.dueDate}
                        </Tag>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {decided ? (
        <section className="owb-space-structure__section owb-space-structure__decision">
          <h3>
            <GitBranch size={14} aria-hidden="true" />
            {t("space.structure.lastDecision")}
          </h3>
          <p>
            {decided.decision === "accepted" ? t("space.decision.accepted") : t("space.decision.rejected")}
            {" · "}
            {decided.decidedAt}
          </p>
          {decided.note ? <p className="owb-space-structure__hint">{decided.note}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

export { buildAcceptanceRecord };
