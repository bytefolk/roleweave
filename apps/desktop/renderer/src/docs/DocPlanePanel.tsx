import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Button, Empty, Input, List, Space, Spin, Tag, Tooltip } from "antd";
import { FileText, Search, Files } from "lucide-react";
import { useT } from "@roleweave/ui";
import type {
  DocPlaneDetailResponse,
  DocPlaneListEntry,
  DocPlaneListResponse,
} from "@roleweave/shared";
import { DocViewer } from "./DocViewer";
import "./doc-plane-empty.css";

/**
 * External doc-plane surface (#35 R2 MVP): browses documents from an
 * upstream `bytefolk/doc` deployment through the shell-owned proxy.
 *
 * The renderer never touches bytefolk/doc directly — the shell owns the
 * origin, the PAT and the CORS boundary. When the shell has no upstream
 * configured the proxy returns `doc_plane_unconfigured` (503) and this
 * panel surfaces the unconfigured state instead of pretending there are
 * shared documents.
 */

export interface DocPlanePanelProps {
  /** Shell-owned connection/open action, shown once in the relevant surface. */
  serviceAction?: ReactNode;
  /** Loader for the list surface; injected so tests can stub the bridge. */
  listDocs(query: string): Promise<DocPlaneListLoadResult>;
  /** Loader for the detail surface; injected so tests can stub the bridge. */
  readDoc(id: string): Promise<DocPlaneDetailLoadResult>;
}

export type DocPlaneListLoadResult =
  | { kind: "ok"; response: DocPlaneListResponse }
  | { kind: "unconfigured"; message: string }
  | { kind: "error"; message: string };

export type DocPlaneDetailLoadResult =
  | { kind: "ok"; response: DocPlaneDetailResponse }
  | { kind: "error"; message: string };

export function DocPlanePanel({ listDocs, readDoc, serviceAction }: DocPlanePanelProps) {
  const t = useT();
  const readerRef = useRef<HTMLDivElement>(null);
  const listVersion = useRef(0);
  const readVersion = useRef(0);
  const scrollPositions = useRef(new Map<string, number>());
  useEffect(
    () => () => {
      listVersion.current += 1;
      readVersion.current += 1;
    },
    [],
  );
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<DocPlaneListEntry[]>([]);
  const [source, setSource] = useState<"upstream" | "mock" | null>(null);
  const [listing, setListing] = useState(true);
  const [listStatus, setListStatus] = useState<
    | { kind: "idle" }
    | { kind: "unconfigured"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocPlaneDetailResponse | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const runList = useCallback(
    async (search: string) => {
      const version = ++listVersion.current;
      setListing(true);
      setListStatus({ kind: "idle" });
      try {
        const result = await listDocs(search);
        if (version !== listVersion.current) return;
        if (result.kind === "ok") {
          setEntries(result.response.entries);
          setSource(result.response.source);
        } else if (result.kind === "unconfigured") {
          readVersion.current += 1;
          setDetail(null);
          setSelectedId(null);
          setReading(false);
          setReadError(null);
          setEntries([]);
          setSource(null);
          setListStatus({ kind: "unconfigured", message: result.message });
        } else {
          setEntries([]);
          setSource(null);
          setListStatus({ kind: "error", message: result.message });
        }
      } catch (error) {
        if (version === listVersion.current)
          setListStatus({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (version === listVersion.current) setListing(false);
      }
    },
    [listDocs],
  );

  useEffect(() => {
    void runList("");
  }, [runList]);

  const openEntry = (id: string) => {
    setSelectedId(id);
    const version = ++readVersion.current;
    setDetail(null);
    setReadError(null);
    setReading(true);
    readDoc(id)
      .then((result) => {
        if (version !== readVersion.current) return;
        if (result.kind === "ok") setDetail(result.response);
        else setReadError(result.message);
      })
      .catch((error) => {
        if (version === readVersion.current)
          setReadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (version === readVersion.current) setReading(false);
      });
  };

  useLayoutEffect(() => {
    if (detail && readerRef.current && selectedId)
      readerRef.current.scrollTop =
        scrollPositions.current.get(selectedId) ?? 0;
  }, [detail, selectedId]);

  if (listStatus.kind === "unconfigured") {
    return <section className="owb-doc-plane owb-doc-plane--disconnected" aria-label={t("docs.planeAria")}>
      <div className="owb-doc-plane__connection-empty" role="status">
        <span className="owb-doc-plane__connection-icon"><Files size={30} aria-hidden="true" strokeWidth={1.5} /></span>
        <h2>{t("docs.planeDisconnectedTitle")}</h2>
        <p>{t("docs.planeDisconnectedPurpose")}</p>
        <p className="owb-doc-plane__connection-scope">{t("docs.planeDisconnectedScope")}</p>
        <p className="owb-doc-plane__connection-setup">{t("docs.planeDisconnectedSetup")}</p>
        <div className="owb-doc-plane__connection-actions">
          {serviceAction}
          <Button type="text" onClick={() => void runList("")}>{t("hire.retry")}</Button>
        </div>
      </div>
    </section>;
  }

  return (
    <section className="owb-doc-plane" aria-label={t("docs.planeAria")}>
      <div className="owb-doc-plane__workspace">
        <div className="owb-doc-plane__list-pane">
          <div className="owb-doc-plane__toolbar">
            {serviceAction ? <div className="owb-doc-plane__service-action">{serviceAction}</div> : null}
            <Space.Compact style={{ width: "100%" }}>
              <Input
                aria-label={t("docs.planeSearchAria")}
                prefix={<Search aria-hidden="true" size={14} />}
                placeholder={t("docs.planeSearchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onPressEnter={() => runList(query.trim())}
                allowClear
                onClear={() => {
                  setQuery("");
                  void runList("");
                }}
              />
              <Tooltip title={t("docs.planeSearchAction")} trigger={["hover", "focus"]}>
                <Button aria-label={t("docs.planeSearchAction")} icon={<Search aria-hidden="true" size={15} />}
                  onClick={() => runList(query.trim())} loading={listing} />
              </Tooltip>
            </Space.Compact>
            {source !== null ? (
              <div className="owb-doc-plane__source" role="status">
                <span>{t("docs.planeSource")}</span>
                <Tag color={source === "upstream" ? "green" : "gold"}>
                  {source === "upstream"
                    ? t("docs.planeSourceUpstream")
                    : t("docs.planeSourceMock")}
                </Tag>
              </div>
            ) : null}
          </div>
          {listStatus.kind === "error" ? (
            <Alert
              type="error"
              message={listStatus.message}
              action={
                <Button onClick={() => void runList(query.trim())}>
                  {t("hire.retry")}
                </Button>
              }
            />
          ) : null}
          {listing ? <Spin aria-label={t("docs.planeListLoading")} /> : null}
          {!listing && listStatus.kind === "idle" ? (
            <List
              className="owb-doc-plane__list"
              size="small"
              dataSource={entries}
              locale={{
                emptyText: query ? (
                  <div>
                    <p>{t("reading.docs.searchNone", { query })}</p>
                    <Button
                      onClick={() => {
                        setQuery("");
                        void runList("");
                      }}
                    >
                      {t("reading.clearFilters")}
                    </Button>
                  </div>
                ) : (
                  t("docs.planeEmpty")
                ),
              }}
              renderItem={(entry) => (
                <List.Item
                  key={entry.id}
                  actions={
                    entry.starred
                      ? [
                          <Tag key="starred" color="gold">
                            {t("docs.planeStarred")}
                          </Tag>,
                        ]
                      : []
                  }
                >
                  <Tooltip placement="right" title={t("docs.sharedDocumentTitle", { title: entry.title })} trigger={["hover", "focus"]}>
                    <button
                      type="button"
                      className="owb-doc-plane__entry"
                      aria-pressed={selectedId === entry.id}
                      onClick={() => openEntry(entry.id)}
                    >
                      <span className="owb-doc-plane__entry-icon" aria-hidden="true">{entry.icon ?? <FileText size={15} strokeWidth={1.7} />}</span>
                      <span className="owb-doc-plane__entry-title">{entry.title}</span>
                    </button>
                  </Tooltip>
                </List.Item>
              )}
            />
          ) : null}
        </div>
        <div
          ref={readerRef}
          onScroll={() => {
            if (detail && selectedId && readerRef.current)
              scrollPositions.current.set(
                selectedId,
                readerRef.current.scrollTop,
              );
          }}
          className="owb-doc-plane__reader-pane"
          aria-label={t("docs.readerAria")}
        >
          {reading ? <Spin aria-label={t("docs.planeLoading")} /> : null}
          {readError !== null ? (
            <Alert
              type="error"
              message={t("docs.readFail")}
              description={readError}
              action={
                <Button onClick={() => selectedId && openEntry(selectedId)}>
                  {t("hire.retry")}
                </Button>
              }
            />
          ) : null}
          {detail !== null ? (
            <DocViewer
              source={detail.content}
              updatedAt={detail.updatedAt}
              title={detail.title}
            />
          ) : null}
          {detail === null && !reading && readError === null ? (
            <Empty
              image={
                <FileText aria-hidden="true" size={28} strokeWidth={1.5} />
              }
              description={t("docs.readerEmpty")}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
