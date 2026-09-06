import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, List, Spin } from "antd";
import { Cloud, File, Image, Music2, RefreshCw, Search, X } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { DriveObject, DriveObjectDetailResponse, DriveObjectListResponse } from "@roleweave/shared";

export interface DriveModuleProps {
  workspaceOpen: boolean;
  /** When composed by employee memory, the parent owns the page heading. */
  embedded?: boolean;
}

type DriveConnectionState = "checking" | "connected" | "unconfigured" | "unavailable";

function apiErrorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  return fallback;
}

function apiErrorCode(body: unknown): string | null {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const code = (body as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function objectIcon(mime: string) {
  if (mime.startsWith("image/")) return Image;
  if (mime.startsWith("audio/")) return Music2;
  return File;
}

function objectKindLabel(mime: string, t: ReturnType<typeof useT>): string {
  if (mime === "application/pdf") return t("drive.typePdf");
  if (mime === "text/markdown" || mime === "text/plain" || mime === "application/json") return t("drive.typeDocument");
  if (mime.startsWith("image/")) return t("drive.typeImage");
  if (mime.startsWith("audio/")) return t("drive.typeAudio");
  if (mime.startsWith("video/")) return t("drive.typeVideo");
  return t("drive.typeFile");
}

/**
 * Workbench-owned drive surface. mem remains the data plane; this module is
 * the one in-app management surface and only consumes the narrow whitelisted
 * bridge, never mem's private UI or storage.
 */
export function DriveModule({ workspaceOpen, embedded = false }: DriveModuleProps) {
  const t = useT();
  const [objects, setObjects] = useState<DriveObject[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<DriveConnectionState>("checking");
  const [selected, setSelected] = useState<DriveObject | null>(null);
  const [detail, setDetail] = useState<DriveObject | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadObjects = useCallback(async (needle = "") => {
    setLoading(true);
    setListError(null);
    setConnectionState("checking");
    try {
      const response = await window.owb.drive.list(needle);
      if (response.status >= 400 || !response.body) {
        if (apiErrorCode(response.body) === "drive_not_configured") {
          setObjects([]);
          setConnectionState("unconfigured");
          return;
        }
        throw new Error(apiErrorMessage(response.body, t("drive.listFail")));
      }
      const body = response.body as DriveObjectListResponse;
      setObjects(body.objects);
      setConnectionState("connected");
    } catch (error) {
      setObjects([]);
      setListError(error instanceof Error ? error.message : String(error));
      setConnectionState("unavailable");
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setConnectionState("checking");
    if (!workspaceOpen) {
      setObjects([]);
      setListError(null);
      return;
    }
    void loadObjects();
  }, [loadObjects, workspaceOpen]);

  const openObject = async (object: DriveObject) => {
    setSelected(object);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await window.owb.drive.detail(object.id);
      if (response.status >= 400 || !response.body) {
        throw new Error(apiErrorMessage(response.body, t("drive.detailFail")));
      }
      setDetail((response.body as DriveObjectDetailResponse).object);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  if (!workspaceOpen) {
    return (
      <section className="owb-drive-module" aria-label={t("drive.moduleAria")}>
        <Empty description={t("tree.notOpened")} />
      </section>
    );
  }

  return (
    <section className={`owb-drive-module${embedded ? " owb-drive-module--embedded" : ""}`} aria-label={t("drive.moduleAria")}>
      {!embedded ? (
        <header className="owb-drive-module__header">
          <h1>{t("drive.title")}</h1>
          <span className={`owb-drive-module__scope${connectionState === "unconfigured" ? " is-unconfigured" : ""}`}>
            <span className="owb-drive-module__scope-dot" aria-hidden="true" />
            {connectionState === "checking"
              ? t("drive.scopeChecking")
              : connectionState === "unconfigured"
                ? t("drive.notConfigured")
                : connectionState === "unavailable"
                  ? t("drive.scopeUnavailable")
                  : t("drive.scopeConnected")}
          </span>
        </header>
      ) : null}

      <div className="owb-drive-module__toolbar">
        <Input
          aria-label={t("drive.searchAria")}
          prefix={<Search aria-hidden="true" size={14} />}
          placeholder={t("drive.searchPh")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => void loadObjects(query.trim())}
          allowClear
        />
        <Button type="primary" icon={<Search aria-hidden="true" size={14} />} onClick={() => void loadObjects(query.trim())}>
          {t("drive.search")}
        </Button>
        <Button aria-label={t("drive.refreshAria")} icon={<RefreshCw aria-hidden="true" size={14} />} onClick={() => void loadObjects(query.trim())}>
          {t("drive.refresh")}
        </Button>
      </div>

      {connectionState === "unconfigured" ? (
        <div className="owb-drive-module__unconfigured" role="status">
          <span className="owb-drive-module__unconfigured-dot" aria-hidden="true" />
          <span>{t("drive.notConfigured")}</span>
        </div>
      ) : null}
      {listError !== null ? <Alert type="error" showIcon message={listError} /> : null}

      <div className="owb-drive-module__layout">
        <section className="owb-drive-module__list" aria-label={t("drive.listAria")}>
          <header className="owb-drive-module__list-header">
            <div>
              <h2>{t("drive.listTitle")}</h2>
            </div>
            <span className="owb-drive-module__count">
              {objects.length} <small>{t("drive.itemCountLabel")}</small>
            </span>
          </header>
          {loading ? (
            <div className="owb-drive-module__loading" role="status">
              <Spin size="small" />
              <span>{t("drive.loading")}</span>
            </div>
          ) : null}
          {!loading && listError === null ? (
            <List
              className="owb-drive-module__objects"
              dataSource={objects}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("drive.empty")} /> }}
              renderItem={(object) => {
                const Icon = objectIcon(object.mime);
                return (
                  <List.Item key={object.id}>
                    <button
                      type="button"
                      className="owb-drive-module__object"
                      aria-label={t("drive.openObject", { name: object.name })}
                      aria-pressed={selected?.id === object.id}
                      onClick={() => void openObject(object)}
                    >
                      <span className="owb-drive-module__object-icon" aria-hidden="true"><Icon size={16} /></span>
                      <span className="owb-drive-module__object-main">
                        <strong>{object.name}</strong>
                        <small>{objectKindLabel(object.mime, t)} · {formatBytes(object.size)}</small>
                        {object.summary ? <span>{object.summary}</span> : null}
                      </span>
                      <span className="owb-drive-module__object-arrow" aria-hidden="true">›</span>
                    </button>
                  </List.Item>
                );
              }}
            />
          ) : null}
        </section>

        <aside className="owb-drive-module__detail" aria-label={t("drive.detailAria")}>
          {selected === null ? (
            <div className="owb-drive-module__detail-empty">
              <Cloud aria-hidden="true" size={22} />
              <strong>{t("drive.detailEmptyTitle")}</strong>
              <span>{t("drive.detailEmptyHint")}</span>
            </div>
          ) : (
            <>
              <header className="owb-drive-module__detail-header">
                <div>
                  <h2>{(detail ?? selected).name}</h2>
                </div>
                <button type="button" aria-label={t("drive.closeDetail")} onClick={() => { setSelected(null); setDetail(null); }}>
                  <X aria-hidden="true" size={15} />
                </button>
              </header>
              {detailLoading ? <Spin aria-label={t("drive.detailLoading")} /> : null}
              {detailError !== null ? <Alert type="error" showIcon message={detailError} /> : null}
              {!detailLoading && detailError === null ? (
                <div className="owb-drive-module__detail-body">
                  <p>{(detail ?? selected).summary ?? t("drive.noSummary")}</p>
                  <dl>
                    <div><dt>{t("drive.metaType")}</dt><dd>{objectKindLabel((detail ?? selected).mime, t)}</dd></div>
                    <div><dt>{t("drive.metaSize")}</dt><dd>{formatBytes((detail ?? selected).size)}</dd></div>
                    <div><dt>{t("drive.metaSource")}</dt><dd>{t("drive.sourceMem")}</dd></div>
                  </dl>
                </div>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
