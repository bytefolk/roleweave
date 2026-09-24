import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  List,
  Modal,
  Segmented,
  Spin,
  message,
} from "antd";
import { Copy, FileCode2, FolderOpen, LoaderCircle } from "lucide-react";
import { formatDocRefUri } from "@roleweave/shared/docs";
import { useT } from "@roleweave/ui";
import type {
  DocsFileEntry,
  DocsFileListResponse,
  DocsFileResponse,
} from "@roleweave/shared";
import { DocViewer } from "./DocViewer";

/**
 * Document routing surface (#35 S2/S4, DS-35-001 rev-1 §3/§5): routes a
 * position's document files into the S1 DocViewer. Loaders are injected so
 * the surface stays testable without the preload bridge. S4 adds the
 * `reloadToken` re-list trigger and a per-file doc-ref copy action; the
 * reference shape stays the frozen doc-ref.v1alpha1.
 */
export interface DocsPanelProps {
  knowledgeFirst?: boolean;
  toolbar?: ReactNode;
  positionId: string | null;
  listDocs(positionId: string, options?: { archived?: boolean }): Promise<DocsFileListResponse>;
  readDoc(positionId: string, path: string, options?: { archived?: boolean }): Promise<DocsFileResponse>;
  writeDoc?(positionId: string, path: string, content: string): Promise<DocsFileResponse>;
  renameDoc?(positionId: string, from: string, to: string): Promise<{ to: string }>;
  archiveDoc?(positionId: string, path: string): Promise<void>;
  restoreDoc?(positionId: string, path: string): Promise<void>;
  deleteDoc?(positionId: string, path: string, options?: { archived?: boolean }): Promise<void>;
  /** Bumped by the creator to force a re-list after a successful create. */
  reloadToken?: number;
  requestedPath?: string | null;
}

function isKnowledgeFile(path: string): boolean {
  return path.startsWith("knowledge/");
}

export function DocsPanel({
  positionId,
  listDocs,
  readDoc,
  writeDoc,
  renameDoc,
  archiveDoc,
  restoreDoc,
  deleteDoc,
  reloadToken = 0,
  knowledgeFirst = false,
  toolbar,
  requestedPath,
}: DocsPanelProps) {
  const t = useT();
  const [files, setFiles] = useState<DocsFileEntry[]>([]);
  const [listing, setListing] = useState(positionId !== null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocsFileResponse | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fileScope, setFileScope] = useState("knowledge");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const lifecycleEnabled = Boolean(writeDoc || renameDoc || archiveDoc || restoreDoc || deleteDoc);
  const archivedView = fileScope === "archived";
  const readVersion = useRef(0);
  const [listRetry, setListRetry] = useState(0);
  const requestedSelection = useRef<string | null>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const readerRef = useRef<HTMLDivElement>(null);
  const visibleFiles = files.filter(
    (file) =>
      (!knowledgeFirst ||
        fileScope === "all" ||
        /\.(md|markdown|txt)$/i.test(file.path) ||
        file.path.startsWith("knowledge/")) &&
      file.path.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    readVersion.current += 1;
    setReading(false);
    setQuery("");
    setFiles([]);
    setSelected(null);
    setDoc(null);
    setReadError(null);
    setEditing(false);
    setRenameOpen(false);
    setDeleteOpen(false);
    return () => {
      readVersion.current += 1;
    };
  }, [positionId]);

  useEffect(() => {
    if (positionId === null) {
      setListError(null);
      setListing(false);
      return;
    }
    let cancelled = false;
    setListing(true);
    setListError(null);
    const listed = archivedView ? listDocs(positionId, { archived: true }) : listDocs(positionId);
    listed
      .then((response) => {
        if (!cancelled) setFiles(response.files);
      })
      .catch((error) => {
        if (!cancelled)
          setListError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setListing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [positionId, listDocs, reloadToken, listRetry, archivedView]);

  const openFile = useCallback(
    (path: string) => {
      if (positionId === null) return;
      setSelected(path);
      setDoc(null);
      setReadError(null);
      setEditing(false);
      setReading(true);
      const version = ++readVersion.current;
      const loaded = archivedView
        ? readDoc(positionId, path, { archived: true })
        : readDoc(positionId, path);
      loaded
        .then((response) => {
          if (version === readVersion.current) setDoc(response);
        })
        .catch((error) => {
          if (version === readVersion.current)
            setReadError(
              error instanceof Error ? error.message : String(error),
            );
        })
        .finally(() => {
          if (version === readVersion.current) setReading(false);
        });
    },
    [positionId, readDoc, archivedView],
  );

  useLayoutEffect(() => {
    if (doc && readerRef.current)
      readerRef.current.scrollTop =
        scrollPositions.current.get(`${positionId}:${selected}`) ?? 0;
  }, [doc, positionId, selected]);

  useEffect(() => {
    const key = `${positionId}:${reloadToken}:${requestedPath}`;
    if (requestedPath && requestedSelection.current !== key) {
      requestedSelection.current = key;
      setQuery("");
      setFileScope("all");
      openFile(requestedPath);
    }
  }, [positionId, requestedPath, reloadToken, openFile]);

  useEffect(() => {
    setSelected(null);
    setDoc(null);
    setReadError(null);
    setEditing(false);
  }, [archivedView]);

  const refreshList = () => setListRetry((value) => value + 1);

  const mutableSelected = selected !== null && isKnowledgeFile(selected);

  const saveEdit = async () => {
    if (positionId === null || selected === null || !writeDoc) return;
    setSaving(true);
    try {
      const updated = await writeDoc(positionId, selected, draft);
      setDoc(updated);
      setEditing(false);
      message.success(t("docs.saved"));
      refreshList();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("docs.editFail"));
    } finally {
      setSaving(false);
    }
  };

  const submitRename = async () => {
    if (positionId === null || selected === null || !renameDoc) return;
    const trimmed = renameValue.trim();
    if (trimmed === "") {
      message.error(t("docs.nameRequired"));
      return;
    }
    const parent = selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/") + 1) : "knowledge/";
    const nextPath = trimmed.includes("/") ? trimmed : `${parent}${trimmed}`;
    setSaving(true);
    try {
      const renamed = await renameDoc(positionId, selected, nextPath);
      setRenameOpen(false);
      message.success(t("docs.renamed", { path: renamed.to }));
      setSelected(renamed.to);
      refreshList();
      openFile(renamed.to);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("docs.renameFail"));
    } finally {
      setSaving(false);
    }
  };

  const submitArchive = async () => {
    if (positionId === null || selected === null || !archiveDoc) return;
    setSaving(true);
    try {
      await archiveDoc(positionId, selected);
      message.success(t("docs.archivedOk", { path: selected }));
      setSelected(null);
      setDoc(null);
      refreshList();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("docs.archiveFail"));
    } finally {
      setSaving(false);
    }
  };

  const submitRestore = async () => {
    if (positionId === null || selected === null || !restoreDoc) return;
    setSaving(true);
    try {
      await restoreDoc(positionId, selected);
      message.success(t("docs.restored", { path: selected }));
      setFileScope("knowledge");
      setSelected(null);
      setDoc(null);
      refreshList();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("docs.restoreFail"));
    } finally {
      setSaving(false);
    }
  };

  const submitDelete = async () => {
    if (positionId === null || selected === null || !deleteDoc) return;
    setSaving(true);
    try {
      if (archivedView) await deleteDoc(positionId, selected, { archived: true });
      else await deleteDoc(positionId, selected);
      message.success(t("docs.deleted", { path: selected }));
      setDeleteOpen(false);
      setSelected(null);
      setDoc(null);
      refreshList();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("docs.deleteFail"));
    } finally {
      setSaving(false);
    }
  };

  const copyRef = async (entry: DocsFileEntry) => {
    if (positionId === null) return;
    const ref = JSON.stringify({
      uri: formatDocRefUri(positionId, entry.path),
      version: entry.modifiedAt,
    });
    try {
      await navigator.clipboard.writeText(ref);
      message.success(t("docs.refCopied"));
    } catch {
      message.error(t("docs.clipboardUnavailable"));
    }
  };

  // Open useful knowledge immediately rather than an oversized empty reader.
  useEffect(() => {
    if (!knowledgeFirst || selected !== null || listing) return;
    const first =
      files.find((file) => file.path === "knowledge/README.md") ??
      files.find((file) => /\.(md|markdown|txt)$/i.test(file.path));
    if (first) openFile(first.path);
  }, [files, knowledgeFirst, selected, listing, openFile]);

  const formatSize = (size: number): string => {
    if (size < 1024) return t("docs.sizeBytes", { size });
    if (size < 1024 * 1024) return t("docs.sizeKB", { size: (size / 1024).toFixed(1) });
    if (size < 1024 * 1024 * 1024) return t("docs.sizeMB", { size: (size / (1024 * 1024)).toFixed(1) });
    return t("docs.sizeGB", { size: (size / (1024 * 1024 * 1024)).toFixed(1) });
  };

  const fileTypeLabel = (path: string): string => {
    const extension = path.split(".").pop()?.toLowerCase();
    if (!extension || extension === path) return t("docs.fileType.unknown");
    const key = `docs.fileType.${extension}`;
    const label = t(key);
    return label !== key ? label : t("docs.fileType.unknown");
  };

  const stripExtension = (filename: string): string => {
    const dotIndex = filename.lastIndexOf(".");
    return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  };

  const renderFilePath = (path: string) => {
    const separator = path.lastIndexOf("/");
    const fullName = separator < 0 ? path : path.slice(separator + 1);
    const displayName = stripExtension(fullName);
    if (separator < 0)
      return <span className="owb-docs-panel__file-name">{displayName}</span>;
    return (
      <>
        <span className="owb-docs-panel__file-name">
          {displayName}
        </span>
        <span className="owb-docs-panel__file-parent">
          {path.slice(0, separator)}/
        </span>
      </>
    );
  };

  return (
    <section className="owb-docs-panel" aria-label={t("docs.panelAria")}>
      {positionId === null ? (
        <Empty description={t("docs.pickFromTree")} />
      ) : (
        <>
          <div className="owb-docs-panel__workspace">
            <div className="owb-docs-panel__list-pane">
              <header className="owb-docs-panel__header">
                <span
                  className="owb-docs-panel__count"
                  aria-label={t("docs.fileCount", {
                    count: visibleFiles.length,
                  })}
                >
                  {t("docs.fileCount", { count: visibleFiles.length })}
                </span>
                {toolbar ?? <h2>{t("docs.listTitle")}</h2>}
              </header>
              <div className="owb-docs-filter">
                {knowledgeFirst || lifecycleEnabled ? (
                  <Segmented
                    aria-label={t("memory.fileScope")}
                    value={fileScope}
                    onChange={setFileScope}
                    options={[
                      { value: "knowledge", label: t("memory.knowledge") },
                      { value: "all", label: t("memory.allFiles") },
                      ...(lifecycleEnabled
                        ? [{ value: "archived", label: t("docs.archived") }]
                        : []),
                    ]}
                  />
                ) : null}
                <Input
                  allowClear
                  aria-label={t("memory.search")}
                  placeholder={t("memory.search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {listing ? (
                <div className="owb-docs-panel__loading" role="status">
                  <LoaderCircle aria-hidden="true" size={15} />
                  <span>{t("docs.syncingList")}</span>
                  <Spin aria-label={t("docs.listing")} size="small" />
                </div>
              ) : null}
              {listError !== null ? (
                <Alert
                  className="owb-docs-panel__error"
                  type="error"
                  showIcon
                  message={listError}
                  action={
                    <Button onClick={() => setListRetry((value) => value + 1)}>
                      {t("hire.retry")}
                    </Button>
                  }
                />
              ) : null}
              {!listing && listError === null ? (
                <List
                  className="owb-docs-panel__list"
                  size="small"
                  dataSource={visibleFiles}
                  locale={{
                    emptyText: (
                      <div className="owb-docs-panel__empty">
                        <span
                          className="owb-docs-panel__empty-icon"
                          aria-hidden="true"
                        >
                          <FolderOpen size={18} strokeWidth={1.7} />
                        </span>
                        <strong>
                          {query
                            ? t("reading.docs.searchNone", { query })
                            : t("docs.empty")}
                        </strong>
                        {query ? (
                          <Button onClick={() => setQuery("")}>
                            {t("reading.clearFilters")}
                          </Button>
                        ) : (
                          <span>{t("docs.emptyHint")}</span>
                        )}
                      </div>
                    ),
                  }}
                  renderItem={(entry) => (
                    <List.Item
                      key={entry.path}
                      className="owb-docs-panel__item"
                    >
                      <div className="owb-docs-panel__item-main">
                        <span
                          className="owb-docs-panel__file-icon"
                          aria-hidden="true"
                        >
                          <FileCode2 size={17} strokeWidth={1.8} />
                        </span>
                        <button
                          type="button"
                          className="owb-docs-panel__file"
                          title={entry.path}
                          aria-label={entry.path}
                          aria-pressed={selected === entry.path}
                          onClick={() => openFile(entry.path)}
                        >
                          {renderFilePath(entry.path)}
                        </button>
                      </div>
                      <div
                        className="owb-docs-panel__item-meta"
                        aria-hidden="true"
                      >
                        <span className="owb-docs-panel__file-type">
                          {fileTypeLabel(entry.path)}
                        </span>
                        <span>{formatSize(entry.size)}</span>
                      </div>
                      <button
                        type="button"
                        className="owb-docs-panel__copy-ref"
                        aria-label={t("docs.copyRefAria", { path: entry.path })}
                        title={t("docs.copyRefAria", { path: entry.path })}
                        onClick={() => copyRef(entry)}
                      >
                        <Copy aria-hidden="true" size={14} strokeWidth={1.9} />
                        <span>{t("docs.copyRef")}</span>
                      </button>
                    </List.Item>
                  )}
                />
              ) : null}
            </div>
            <div
              ref={readerRef}
              onScroll={() => {
                if (doc && selected && readerRef.current)
                  scrollPositions.current.set(
                    `${positionId}:${selected}`,
                    readerRef.current.scrollTop,
                  );
              }}
              className="owb-docs-panel__reader-pane"
              aria-label={t("docs.readerAria")}
            >
              {reading ? (
                <div className="owb-docs-panel__reader-state" role="status">
                  <Spin aria-label={t("docs.reading")} size="small" />
                  <span>{t("docs.openingDoc")}</span>
                </div>
              ) : null}
              {readError !== null ? (
                <Alert
                  className="owb-docs-panel__error"
                  type="error"
                  showIcon
                  message={t("docs.readFail")}
                  description={readError}
                  action={
                    <Button onClick={() => selected && openFile(selected)}>
                      {t("hire.retry")}
                    </Button>
                  }
                />
              ) : null}
              {doc !== null && editing ? (
                <div className="owb-docs-panel__editor">
                  <Input.TextArea
                    aria-label={t("docs.editorAria")}
                    value={draft}
                    rows={18}
                    disabled={saving}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <div className="owb-docs-panel__editor-actions">
                    <Button onClick={() => setEditing(false)} disabled={saving}>
                      {t("dlg.cancel")}
                    </Button>
                    <Button type="primary" loading={saving} onClick={() => void saveEdit()}>
                      {t("docs.save")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {doc !== null && !editing ? (
                <DocViewer
                  source={doc.content}
                  version={doc.version}
                  updatedAt={doc.modifiedAt}
                  title={doc.path}
                  path={doc.path}
                  actions={
                    <>
                      {mutableSelected && !archivedView && writeDoc ? (
                        <Button
                          onClick={() => {
                            setDraft(doc.content);
                            setEditing(true);
                          }}
                        >
                          {t("docs.edit")}
                        </Button>
                      ) : null}
                      {mutableSelected && !archivedView && renameDoc ? (
                        <Button
                          onClick={() => {
                            setRenameValue(selected.slice(selected.lastIndexOf("/") + 1));
                            setRenameOpen(true);
                          }}
                        >
                          {t("docs.rename")}
                        </Button>
                      ) : null}
                      {mutableSelected && !archivedView && archiveDoc ? (
                        <Button onClick={() => void submitArchive()}>{t("docs.archive")}</Button>
                      ) : null}
                      {mutableSelected && archivedView && restoreDoc ? (
                        <Button onClick={() => void submitRestore()}>{t("docs.restore")}</Button>
                      ) : null}
                      {mutableSelected && deleteDoc ? (
                        <Button danger onClick={() => setDeleteOpen(true)}>
                          {t("docs.delete")}
                        </Button>
                      ) : null}
                      {selected !== null && !isKnowledgeFile(selected) ? (
                        <span className="owb-docs-panel__bound">{t("docs.boundReadOnly")}</span>
                      ) : null}
                      <Button
                        icon={<Copy size={14} />}
                        onClick={() =>
                          void copyRef({
                            path: doc.path,
                            modifiedAt: doc.version,
                            size: doc.size,
                            kind: "file",
                          })
                        }
                      >
                        {t("docs.copyRef")}
                      </Button>
                    </>
                  }
                />
              ) : null}
              {doc === null && !reading && readError === null ? (
                <div className="owb-docs-panel__reader-empty">
                  <FileCode2 aria-hidden="true" size={24} strokeWidth={1.6} />
                  <strong>{t("docs.readerEmpty")}</strong>
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
      <Modal
        title={t("docs.rename")}
        open={renameOpen}
        confirmLoading={saving}
        okText={t("docs.rename")}
        cancelText={t("dlg.cancel")}
        onOk={() => void submitRename()}
        onCancel={() => {
          if (!saving) setRenameOpen(false);
        }}
      >
        <Input
          aria-label={t("docs.renameAria")}
          value={renameValue}
          disabled={saving}
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={() => void submitRename()}
        />
      </Modal>
      <Modal
        title={t("docs.delete")}
        open={deleteOpen}
        confirmLoading={saving}
        okText={t("docs.deleteConfirmOk")}
        okButtonProps={{ danger: true }}
        cancelText={t("dlg.cancel")}
        onOk={() => void submitDelete()}
        onCancel={() => {
          if (!saving) setDeleteOpen(false);
        }}
      >
        <p>{t("docs.deleteConfirm", { path: selected ?? "" })}</p>
      </Modal>
    </section>
  );
}
