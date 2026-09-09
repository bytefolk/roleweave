import { useEffect, useState } from "react";
import { Alert, Empty, List, Spin, message } from "antd";
import { Copy, FileCode2, FolderOpen, LoaderCircle } from "lucide-react";
import { formatDocRefUri } from "@roleweave/shared/docs";
import { useT } from "@roleweave/ui";
import type { DocsFileEntry, DocsFileListResponse, DocsFileResponse } from "@roleweave/shared";
import { DocViewer } from "./DocViewer";

/**
 * Document routing surface (#35 S2/S4, DS-35-001 rev-1 §3/§5): routes a
 * position's document files into the S1 DocViewer. Loaders are injected so
 * the surface stays testable without the preload bridge. S4 adds the
 * `reloadToken` re-list trigger and a per-file doc-ref copy action; the
 * reference shape stays the frozen doc-ref.v1alpha1.
 */
export interface DocsPanelProps {
  positionId: string | null;
  listDocs(positionId: string): Promise<DocsFileListResponse>;
  readDoc(positionId: string, path: string): Promise<DocsFileResponse>;
  /** Bumped by the creator to force a re-list after a successful create. */
  reloadToken?: number;
}

export function DocsPanel({ positionId, listDocs, readDoc, reloadToken = 0 }: DocsPanelProps) {
  const t = useT();
  const [files, setFiles] = useState<DocsFileEntry[]>([]);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocsFileResponse | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(null);
    setDoc(null);
    setReadError(null);
    if (positionId === null) {
      setFiles([]);
      setListError(null);
      return;
    }
    let cancelled = false;
    setListing(true);
    setListError(null);
    listDocs(positionId)
      .then((response) => {
        if (cancelled) return;
        setFiles(response.files);
      })
      .catch((error) => {
        if (cancelled) return;
        setFiles([]);
        setListError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setListing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [positionId, listDocs, reloadToken]);

  const openFile = (path: string) => {
    if (positionId === null) return;
    setSelected(path);
    setDoc(null);
    setReadError(null);
    setReading(true);
    readDoc(positionId, path)
      .then((response) => setDoc(response))
      .catch((error) => setReadError(error instanceof Error ? error.message : String(error)))
      .finally(() => setReading(false));
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

  const formatSize = (size: number): string => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fileExtension = (path: string): string => {
    const extension = path.split(".").pop();
    return extension && extension !== path ? extension.toUpperCase() : "FILE";
  };

  const renderFilePath = (path: string) => {
    const separator = path.lastIndexOf("/");
    if (separator < 0) return <span className="owb-docs-panel__file-name">{path}</span>;
    return (
      <>
        <span className="owb-docs-panel__file-parent">{path.slice(0, separator)}/</span>
        <span className="owb-docs-panel__file-name">{path.slice(separator + 1)}</span>
      </>
    );
  };

  return (
    <section className="owb-docs-panel" aria-label={t("docs.panelAria")}>
      {positionId === null ? (
        <Empty description={t("docs.pickFromTree")} />
      ) : (
        <>
          <header className="owb-docs-panel__header">
            <div>
              <h2>{t("docs.listTitle")}</h2>
            </div>
            <span className="owb-docs-panel__count" aria-label={t("docs.fileCount", { count: files.length })}>
              {files.length.toString().padStart(2, "0")} <small>FILES</small>
            </span>
          </header>
          <div className="owb-docs-panel__workspace">
            <div className="owb-docs-panel__list-pane">
              {listing ? (
                <div className="owb-docs-panel__loading" role="status">
                  <LoaderCircle aria-hidden="true" size={15} />
                  <span>{t("docs.syncingList")}</span>
                  <Spin aria-label={t("docs.listing")} size="small" />
                </div>
              ) : null}
              {listError !== null ? <Alert className="owb-docs-panel__error" type="error" showIcon message={listError} /> : null}
              {!listing && listError === null ? (
                <List
                  className="owb-docs-panel__list"
                  size="small"
                  dataSource={files}
                  locale={{
                    emptyText: (
                      <div className="owb-docs-panel__empty">
                        <span className="owb-docs-panel__empty-icon" aria-hidden="true">
                          <FolderOpen size={18} strokeWidth={1.7} />
                        </span>
                        <strong>{t("docs.empty")}</strong>
                        <span>{t("docs.emptyHint")}</span>
                      </div>
                    ),
                  }}
                  renderItem={(entry) => (
                    <List.Item
                      key={entry.path}
                      className="owb-docs-panel__item"
                    >
                      <div className="owb-docs-panel__item-main">
                        <span className="owb-docs-panel__file-icon" aria-hidden="true">
                          <FileCode2 size={17} strokeWidth={1.8} />
                        </span>
                        <button
                          type="button"
                          className="owb-docs-panel__file"
                          aria-label={entry.path}
                          aria-pressed={selected === entry.path}
                          onClick={() => openFile(entry.path)}
                        >
                          {renderFilePath(entry.path)}
                        </button>
                      </div>
                      <div className="owb-docs-panel__item-meta" aria-hidden="true">
                        <span className="owb-docs-panel__file-type">{fileExtension(entry.path)}</span>
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
            <div className="owb-docs-panel__reader-pane" aria-label={t("docs.readerAria")}>
              {reading ? (
                <div className="owb-docs-panel__reader-state" role="status">
                  <Spin aria-label={t("docs.reading")} size="small" />
                  <span>{t("docs.openingDoc")}</span>
                </div>
              ) : null}
              {readError !== null ? <Alert className="owb-docs-panel__error" type="error" showIcon message={readError} /> : null}
              {doc !== null ? <DocViewer source={doc.content} version={doc.version} title={doc.path} /> : null}
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
    </section>
  );
}
