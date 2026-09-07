import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, List, Space, Spin, Tag } from "antd";
import { FileText } from "lucide-react";
import { useT } from "@roleweave/ui";
import type {
  DocPlaneDetailResponse,
  DocPlaneListEntry,
  DocPlaneListResponse,
} from "@roleweave/shared";
import { DocViewer } from "./DocViewer";

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

export function DocPlanePanel({ listDocs, readDoc }: DocPlanePanelProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<DocPlaneListEntry[]>([]);
  const [source, setSource] = useState<"upstream" | "mock" | null>(null);
  const [listing, setListing] = useState(false);
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
      setListing(true);
      setListStatus({ kind: "idle" });
      try {
        const result = await listDocs(search);
        if (result.kind === "ok") {
          setEntries(result.response.entries);
          setSource(result.response.source);
        } else if (result.kind === "unconfigured") {
          setEntries([]);
          setSource(null);
          setListStatus({ kind: "unconfigured", message: result.message });
        } else {
          setEntries([]);
          setSource(null);
          setListStatus({ kind: "error", message: result.message });
        }
      } finally {
        setListing(false);
      }
    },
    [listDocs],
  );

  useEffect(() => {
    void runList("");
  }, [runList]);

  const openEntry = (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setReadError(null);
    setReading(true);
    readDoc(id)
      .then((result) => {
        if (result.kind === "ok") setDetail(result.response);
        else setReadError(result.message);
      })
      .finally(() => setReading(false));
  };

  return (
    <section className="owb-doc-plane" aria-label={t("docs.planeAria")}>
      <div className="owb-doc-plane__workspace">
        <div className="owb-doc-plane__list-pane">
          <div className="owb-doc-plane__toolbar">
            <Space.Compact style={{ width: "100%" }}>
              <Input
                aria-label={t("docs.planeSearchAria")}
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
              <Button onClick={() => runList(query.trim())} loading={listing}>
                {t("docs.planeSearchAction")}
              </Button>
            </Space.Compact>
            {source !== null ? (
              <div className="owb-doc-plane__source" role="status">
                <span>{t("docs.planeSource")}</span>
                <Tag color={source === "upstream" ? "green" : "gold"}>
                  {source === "upstream" ? t("docs.planeSourceUpstream") : t("docs.planeSourceMock")}
                </Tag>
              </div>
            ) : null}
          </div>
          {listStatus.kind === "unconfigured" ? (
            <div className="owb-doc-plane__unconfigured" role="status">
              <i aria-hidden="true" />
              <strong>{t("docs.planeUnconfigured")}</strong>
            </div>
          ) : null}
          {listStatus.kind === "error" ? (
            <Alert type="error" message={listStatus.message} />
          ) : null}
          {listing ? <Spin aria-label={t("docs.planeListLoading")} /> : null}
          {!listing && listStatus.kind === "idle" ? (
            <List
              className="owb-doc-plane__list"
              size="small"
              dataSource={entries}
              locale={{ emptyText: t("docs.planeEmpty") }}
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
                  <button
                    type="button"
                    className="owb-doc-plane__entry"
                    aria-pressed={selectedId === entry.id}
                    onClick={() => openEntry(entry.id)}
                  >
                    <span aria-hidden="true">{entry.icon ?? "📄"}</span> {entry.title}
                  </button>
                </List.Item>
              )}
            />
          ) : null}
        </div>
        <div className="owb-doc-plane__reader-pane" aria-label={t("docs.readerAria")}>
          {reading ? <Spin aria-label={t("docs.planeLoading")} /> : null}
          {readError !== null ? <Alert type="error" message={readError} /> : null}
          {detail !== null ? (
            <DocViewer source={detail.content} version={detail.updatedAt} title={detail.title} />
          ) : null}
          {detail === null && !reading && readError === null ? (
            <Empty image={<FileText aria-hidden="true" size={28} strokeWidth={1.5} />} description={t("docs.readerEmpty")} />
          ) : null}
        </div>
      </div>
    </section>
  );
}
