import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Alert, Button, Drawer, Empty, Image as ImagePreview, Input, Modal, Spin } from "antd";
import { Cloud, File, FileText, Film, Folder, Image, Info, LayoutGrid, List, Music2, RefreshCw, Search } from "lucide-react";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { DriveObject, DriveObjectDetailResponse, DriveObjectListResponse, DriveObjectPreviewResponse, DriveProviderStatusResponse } from "@roleweave/shared";
import "./drive-browser.css";

export interface DriveModuleProps {
  workspaceOpen: boolean;
  workspaceKey?: string;
  /** The memory workspace owns its heading and configured service launcher. */
  embedded?: boolean;
  serviceAction?: ReactNode;
}

type ConnectionState = "checking" | "connected" | "unconfigured" | "unavailable";
type FileKind = "folder" | "document" | "image" | "audio" | "video" | "other";
type Sort = "nameAsc" | "nameDesc" | "newest" | "oldest" | "sizeDesc" | "sizeAsc";
type Preview = DriveObjectPreviewResponse["preview"];
type Provider = DriveProviderStatusResponse["status"];
const PREVIEW_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FILTERS = ["all", "folder", "document", "image", "audio", "video", "other"] as const;
const SORTS: Sort[] = ["nameAsc", "nameDesc", "newest", "oldest", "sizeDesc", "sizeAsc"];

function mimeOf(mime: string) { return mime.split(";", 1)[0]?.trim().toLowerCase() ?? ""; }
function fileKind(mime: string): FileKind {
  const normalized = mimeOf(mime);
  if (normalized === "inode/directory") return "folder";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("text/") || normalized === "application/pdf" || normalized === "application/json" || normalized === "application/msword" || normalized.includes("officedocument")) return "document";
  return "other";
}
function fileIcon(mime: string) { return { folder: Folder, document: FileText, image: Image, audio: Music2, video: Film, other: File }[fileKind(mime)]; }
function kindKey(kind: FileKind | "all") { return kind === "all" ? "drive.typeAll" : kind === "other" ? "drive.typeOther" : `drive.type${kind[0]!.toUpperCase()}${kind.slice(1)}`; }
function typeKey(mime: string) { return mimeOf(mime) === "application/pdf" ? "drive.typePdf" : kindKey(fileKind(mime)); }
function errorCode(body: unknown): string | null {
  return body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : null;
}
function errorMessage(body: unknown, fallback: string): string {
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
}
function formatBytes(bytes: number, mime?: string) {
  if (mime && fileKind(mime) === "folder") return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A flat, read-only file browser over the existing bounded drive API. */
export function DriveModule({ workspaceOpen, workspaceKey, embedded = false, serviceAction }: DriveModuleProps) {
  const t = useT();
  const translation = useRef(t); translation.current = t;
  const locale = useOwbLocale();
  const scope = useMemo(() => Symbol("drive-workspace"), [workspaceOpen, workspaceKey]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const alive = useRef(true);
  const listEpoch = useRef(0), providerEpoch = useRef(0), detailEpoch = useRef(0), previewEpoch = useRef(0);
  const [objects, setObjects] = useState<DriveObject[]>([]);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [view, setView] = useState<"list" | "grid">("list");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<"details" | "preview" | null>(null);
  const inspectorRef = useRef(inspector); inspectorRef.current = inspector;
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const [detail, setDetail] = useState<DriveObject | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const fileButtons = useRef(new Map<string, HTMLButtonElement>());
  const browser = useRef<HTMLDivElement>(null);
  const activeObject = objects.find((object) => object.id === activeId) ?? null;
  const renderedPreviewEpoch = previewEpoch.current;

  const invalidateInspector = useCallback(() => {
    detailEpoch.current += 1; previewEpoch.current += 1;
    inspectorRef.current = null; setInspector(null); setDetail(null); setDetailError(null); setDetailLoading(false);
    setPreview(null); setPreviewError(null); setPreviewLoading(false);
  }, []);
  const clearSelection = useCallback(() => {
    invalidateInspector(); activeRef.current = null; setActiveId(null); setSelectedIds(new Set());
  }, [invalidateInspector]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; listEpoch.current += 1; providerEpoch.current += 1; detailEpoch.current += 1; previewEpoch.current += 1; }; }, []);

  const loadObjects = useCallback(async (needle = "") => {
    if (!workspaceOpen) return;
    const request = ++listEpoch.current;
    const current = () => alive.current && currentScope.current === scope && request === listEpoch.current;
    const boundedQuery = needle.trim().slice(0, 256);
    clearSelection(); setAppliedQuery(boundedQuery); setObjects([]); setLoading(true); setListError(null); setConnection("checking");
    try {
      const response = await window.owb.drive.list(boundedQuery);
      if (!current()) return;
      if (response.status >= 400 || !response.body) {
        if (errorCode(response.body) === "drive_not_configured") { setConnection("unconfigured"); return; }
        throw new Error(errorMessage(response.body, translation.current("drive.listFail")));
      }
      const body = response.body as DriveObjectListResponse;
      if (body.schemaVersion !== "drive-object-list.v1" || !Array.isArray(body.objects) || body.mocked !== false) throw new Error(translation.current("drive.listFail"));
      setObjects(body.objects); setConnection("connected");
    } catch (error) {
      if (current()) { setListError(error instanceof Error ? error.message : translation.current("drive.listFail")); setConnection("unavailable"); }
    } finally { if (current()) setLoading(false); }
  }, [clearSelection, scope, workspaceOpen]);
  const loadProvider = useCallback(async () => {
    const request = ++providerEpoch.current;
    const current = () => alive.current && currentScope.current === scope && request === providerEpoch.current;
    setProvider(null); setProviderError(false);
    if (!workspaceOpen || typeof window.owb.drive.provider !== "function") return;
    try {
      const response = await window.owb.drive.provider();
      if (!current()) return;
      const body = response.body as DriveProviderStatusResponse;
      if (response.status >= 400 || body?.schemaVersion !== "drive-provider.v1" || body?.status?.schemaVersion !== "drive-provider.v1" || !["mem", "bdpan"].includes(body?.status?.kind) || !["ready", "auth_expired", "not_installed", "not_connected", "unsupported_action", "error"].includes(body?.status?.state)) throw new Error();
      setProvider(body.status);
    } catch { if (current()) setProviderError(true); }
  }, [scope, workspaceOpen]);
  useEffect(() => {
    clearSelection(); setQuery(""); setAppliedQuery(""); setFilter("all"); setObjects([]); setListError(null); setLoading(false); setConnection("checking");
    void loadProvider(); if (workspaceOpen) void loadObjects();
    return () => { listEpoch.current += 1; providerEpoch.current += 1; detailEpoch.current += 1; previewEpoch.current += 1; };
  }, [clearSelection, loadObjects, loadProvider, workspaceOpen]);

  const loadDetail = async (object: DriveObject) => {
    if (fileKind(object.mime) === "folder") return;
    const request = ++detailEpoch.current;
    const current = () => alive.current && currentScope.current === scope && request === detailEpoch.current && activeRef.current === object.id && inspectorRef.current !== null;
    setDetail(null); setDetailLoading(true); setDetailError(null);
    try {
      const response = await window.owb.drive.detail(object.id);
      if (!current()) return;
      const body = response.body as DriveObjectDetailResponse;
      if (response.status >= 400 || body?.schemaVersion !== "drive-object.v1" || body?.object?.id !== object.id || body.mocked !== false) throw new Error(errorMessage(response.body, t("drive.detailFail")));
      setDetail(body.object);
    } catch (error) { if (current()) setDetailError(error instanceof Error ? error.message : t("drive.detailFail")); }
    finally { if (current()) setDetailLoading(false); }
  };
  const loadPreview = async (object: DriveObject) => {
    const request = ++previewEpoch.current;
    const current = () => alive.current && currentScope.current === scope && request === previewEpoch.current && activeRef.current === object.id && inspectorRef.current === "preview";
    setPreview(null); setPreviewError(null); setPreviewLoading(false);
    if (!PREVIEW_MIMES.has(mimeOf(object.mime))) return;
    setPreviewLoading(true); setPreviewAttempt((attempt) => attempt + 1);
    try {
      if (typeof window.owb.drive.preview !== "function") throw new Error(t("drive.previewUnavailable"));
      const response = await window.owb.drive.preview(object.id);
      if (!current()) return;
      if (response.status >= 400 || !response.body) {
        const key = ({ drive_preview_unsupported: "drive.previewUnsupported", drive_preview_too_large: "drive.previewTooLarge", drive_preview_invalid: "drive.previewInvalid", drive_action_unsupported: "drive.previewSourceUnsupported" } as Record<string, string>)[errorCode(response.body) ?? ""];
        throw new Error(key ? t(key) : errorMessage(response.body, t("drive.previewFail")));
      }
      const image = (response.body as DriveObjectPreviewResponse).preview;
      const mime = typeof image?.mime === "string" ? mimeOf(image.mime) : "";
      if ((response.body as DriveObjectPreviewResponse).schemaVersion !== "drive-object-preview.v1" || image?.objectId !== object.id || !PREVIEW_MIMES.has(mime) || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith(`data:${mime};base64,`)) throw new Error(t("drive.previewFail"));
      setPreview(image);
    } catch (error) { if (current()) setPreviewError(error instanceof Error ? error.message : t("drive.previewFail")); }
    finally { if (current()) setPreviewLoading(false); }
  };
  const selectObject = (object: DriveObject) => {
    if (activeRef.current === object.id && selectedIds.size === 1 && selectedIds.has(object.id)) return;
    invalidateInspector(); activeRef.current = object.id; setActiveId(object.id); setSelectedIds(new Set([object.id]));
  };
  const openInspector = (object: DriveObject, mode: "details" | "preview") => {
    if (activeRef.current === object.id && inspectorRef.current === mode) return;
    invalidateInspector(); activeRef.current = object.id; setActiveId(object.id); setSelectedIds(new Set([object.id]));
    inspectorRef.current = mode; setInspector(mode);
    // Directory rows are real upstream records, but this API cannot enter
    // them or fetch directory contents. Their listed metadata remains usable.
    if (fileKind(object.mime) === "folder") return;
    void loadDetail(object); if (mode === "preview") void loadPreview(object);
  };
  const visible = useMemo(() => {
    const files = objects.filter((object) => filter === "all" || fileKind(object.mime) === filter);
    const nameOrder = (a: DriveObject, b: DriveObject) => a.name.localeCompare(b.name, locale, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);
    return files.sort((a, b) => {
      if (sort === "nameAsc") return nameOrder(a, b);
      if (sort === "nameDesc") return -nameOrder(a, b);
      if (sort === "sizeDesc") return b.size - a.size || nameOrder(a, b);
      if (sort === "sizeAsc") return a.size - b.size || nameOrder(a, b);
      const time = (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
      return (sort === "oldest" ? time : -time) || nameOrder(a, b);
    });
  }, [filter, locale, objects, sort]);
  const toggleSelection = (id: string) => {
    invalidateInspector();
    const next = new Set(selectedIds); if (next.has(id)) next.delete(id); else next.add(id);
    const only = next.size === 1 ? [...next][0]! : null;
    activeRef.current = only; setActiveId(only); setSelectedIds(next);
  };
  const dateLabel = (value: string) => Number.isNaN(Date.parse(value)) ? t("drive.unknownDate") : new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
  const providerName = provider ? t(`drive.provider.${provider.kind}`) : t("drive.providerUnknown");
  const statusLabel = provider && provider.state !== "ready" ? t(`drive.providerState.${provider.state}`)
    : t(connection === "checking" ? "drive.scopeChecking" : connection === "connected" ? "drive.scopeConnected" : connection === "unconfigured" ? "drive.notConfigured" : "drive.scopeUnavailable");
  const single = selectedIds.size === 1 ? objects.find((object) => selectedIds.has(object.id)) ?? null : null;
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, object: DriveObject) => {
    if (event.key === "Enter") { event.preventDefault(); openInspector(object, "preview"); return; }
    const index = visible.findIndex((file) => file.id === object.id);
    const minWidth = window.matchMedia("(max-width: 640px)").matches ? 150 : 180;
    const columns = view === "grid" ? Math.max(1, Math.floor(((browser.current?.clientWidth ?? minWidth) - 12) / (minWidth + 12))) : 1;
    const offset = ({ ArrowDown: columns, ArrowUp: -columns, ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : offset === undefined ? null : Math.max(0, Math.min(visible.length - 1, index + offset));
    if (next !== null && visible[next]) { event.preventDefault(); fileButtons.current.get(visible[next]!.id)?.focus(); }
  };
  const fileButton = (object: DriveObject) => {
    const Icon = fileIcon(object.mime);
    return <button type="button" className="owb-drive-browser__file-name" aria-label={t("drive.selectObject", { name: object.name })} aria-pressed={selectedIds.has(object.id)}
      ref={(element) => { if (element) fileButtons.current.set(object.id, element); else fileButtons.current.delete(object.id); }}
      onClick={(event) => { event.stopPropagation(); selectObject(object); }} onDoubleClick={(event) => { event.stopPropagation(); openInspector(object, "preview"); }} onKeyDown={(event) => moveFocus(event, object)}>
      <span className="owb-drive-browser__file-icon" data-kind={fileKind(object.mime)} aria-hidden="true"><Icon size={view === "grid" ? 34 : 20} /></span><strong title={object.name}>{object.name}</strong>
    </button>;
  };
  const metadata = activeObject ? <div className="owb-drive-browser__metadata">
    {fileKind(activeObject.mime) === "folder" && inspector === "details" && <p className="owb-drive-browser__content-note" role="status">{t("drive.folderUnsupported")}</p>}
    {detailLoading ? <Spin aria-label={t("drive.detailLoading")} /> : null}
    {detailError ? <Alert type="error" showIcon title={t("drive.detailFail")} description={detailError} action={<Button size="small" onClick={() => void loadDetail(activeObject)}>{t("drive.retry")}</Button>} /> : null}
    <p className="owb-drive-browser__summary">{(detail ?? activeObject).summary ?? t("drive.noSummary")}</p>
    <dl><div><dt>{t("drive.metaType")}</dt><dd>{t(typeKey((detail ?? activeObject).mime))}</dd></div><div><dt>{t("drive.metaSize")}</dt><dd>{formatBytes((detail ?? activeObject).size, (detail ?? activeObject).mime)}</dd></div><div><dt>{t("drive.metaCreated")}</dt><dd>{dateLabel((detail ?? activeObject).createdAt)}</dd></div><div><dt>{t("drive.metaSource")}</dt><dd>{providerName}</dd></div></dl>
  </div> : null;

  if (!workspaceOpen) return <section className="owb-drive-module owb-drive-browser" aria-label={t("drive.moduleAria")}><Empty description={t("tree.notOpened")} /></section>;
  return <section className={`owb-drive-module owb-drive-browser${embedded ? " owb-drive-module--embedded" : ""}`} aria-label={t("drive.moduleAria")}>
    {!embedded && <h1 className="owb-drive-browser__title">{t("drive.title")}</h1>}
    <header className="owb-drive-browser__location"><div><Cloud size={18} aria-hidden="true" /><h2>{appliedQuery ? t("drive.searchResults", { query: appliedQuery }) : t("drive.allFiles")}</h2></div>
      <span className="owb-drive-browser__source" data-state={provider && provider.state !== "ready" ? provider.state : connection}>{providerName}<i aria-hidden="true" />{statusLabel}</span>
    </header>
    {provider && provider.state !== "ready" ? <p className="owb-drive-browser__provider-status" role="status">{t(`drive.providerState.${provider.state}`)}</p> : providerError ? <p className="owb-drive-browser__provider-status" role="status">{t("drive.providerStatusUnavailable")}</p> : null}
    <div className="owb-drive-browser__toolbar">
      <form className="owb-drive-browser__search" onSubmit={(event) => { event.preventDefault(); void loadObjects(query); }}><Input aria-label={t("drive.searchAria")} prefix={<Search size={14} aria-hidden="true" />} value={query} maxLength={256} onChange={(event) => setQuery(event.target.value.slice(0, 256))} placeholder={t("drive.searchPh")} allowClear /><Button htmlType="submit">{t("drive.search")}</Button></form>
      <label className="owb-drive-browser__sort"><span>{t("drive.sortAria")}</span><select aria-label={t("drive.sortAria")} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>{SORTS.map((value) => <option key={value} value={value}>{t(`drive.sort.${value}`)}</option>)}</select></label>
      <div className="owb-drive-browser__views" role="group" aria-label={t("drive.viewAria")}><Button aria-label={t("drive.viewList")} aria-pressed={view === "list"} type={view === "list" ? "primary" : "default"} icon={<List size={15} aria-hidden="true" />} onClick={() => setView("list")} /><Button aria-label={t("drive.viewGrid")} aria-pressed={view === "grid"} type={view === "grid" ? "primary" : "default"} icon={<LayoutGrid size={15} aria-hidden="true" />} onClick={() => setView("grid")} /></div>
      <Button aria-label={t("drive.refreshAria")} icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => { void loadObjects(appliedQuery); void loadProvider(); }} />
      {provider?.kind !== "bdpan" && serviceAction}
    </div>
    <div className="owb-drive-browser__filterbar"><div className="owb-drive-browser__filters" role="group" aria-label={t("drive.filterAria")}>{FILTERS.map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); clearSelection(); }}>{t(kindKey(value))}</button>)}</div>{appliedQuery && <Button size="small" onClick={() => { setQuery(""); void loadObjects(""); }}>{t("drive.clearSearch")}</Button>}</div>
    <div className="owb-drive-browser__selectionbar"><span role="status">{t("drive.selectedCount", { count: selectedIds.size })}</span><span>{t("drive.resultCount", { shown: visible.length, total: objects.length })}</span><div><Button size="small" disabled={!single} onClick={() => single && openInspector(single, "preview")}>{t("drive.previewAction")}</Button><Button size="small" disabled={!single} icon={<Info size={13} aria-hidden="true" />} onClick={() => single && openInspector(single, "details")}>{t("drive.detailsAction")}</Button>{selectedIds.size > 0 && <Button size="small" type="text" onClick={clearSelection}>{t("drive.clearSelection")}</Button>}</div></div>
    {connection === "unconfigured" && <div className="owb-drive-browser__empty-state" role="status"><Empty description={t("drive.notConfigured")} /></div>}
    {listError && <Alert type="error" showIcon title={listError} action={<Button onClick={() => void loadObjects(appliedQuery)}>{t("drive.retry")}</Button>} />}
    {loading && <div className="owb-drive-browser__loading" role="status"><Spin size="small" /><span>{t("drive.loading")}</span></div>}
    {!loading && connection === "connected" && <div className={`owb-drive-browser__files is-${view}`} ref={browser}>
      {visible.length === 0 ? <Empty description={objects.length === 0 ? t("drive.empty") : t("drive.noMatches")}>
        {filter !== "all" && <Button onClick={() => { setFilter("all"); clearSelection(); }}>{t("drive.resetFilter")}</Button>}
      </Empty> : view === "list" ? <table aria-label={t("drive.listAria")}><thead><tr><th className="owb-drive-browser__check"><input type="checkbox" aria-label={t("drive.selectAll")} checked={visible.every((object) => selectedIds.has(object.id))} onChange={(event) => { invalidateInspector(); const next = event.target.checked ? new Set(visible.map((object) => object.id)) : new Set<string>(); const only = next.size === 1 ? [...next][0]! : null; activeRef.current = only; setActiveId(only); setSelectedIds(next); }} /></th><th>{t("drive.columnName")}</th><th>{t("drive.metaType")}</th><th>{t("drive.metaSize")}</th><th>{t("drive.metaCreated")}</th></tr></thead><tbody>{visible.map((object) => <tr key={object.id} data-selected={selectedIds.has(object.id)} onClick={() => selectObject(object)} onDoubleClick={() => openInspector(object, "preview")}><td><input type="checkbox" aria-label={t("drive.selectObject", { name: object.name })} checked={selectedIds.has(object.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelection(object.id)} /></td><td>{fileButton(object)}</td><td>{t(typeKey(object.mime))}</td><td>{formatBytes(object.size, object.mime)}</td><td>{dateLabel(object.createdAt)}</td></tr>)}</tbody></table> : <ul className="owb-drive-browser__grid" aria-label={t("drive.listAria")}>{visible.map((object) => <li key={object.id} data-selected={selectedIds.has(object.id)} onClick={() => selectObject(object)} onDoubleClick={() => openInspector(object, "preview")}><input type="checkbox" aria-label={t("drive.selectObject", { name: object.name })} checked={selectedIds.has(object.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelection(object.id)} />{fileButton(object)}<span>{t(typeKey(object.mime))} · {formatBytes(object.size, object.mime)}</span><time dateTime={object.createdAt}>{dateLabel(object.createdAt)}</time></li>)}</ul>}
    </div>}
    <p className="owb-drive-browser__hint">{t("drive.readOnlyHint")}</p>
    <Drawer className="owb-drive-browser__drawer" title={activeObject?.name} open={inspector === "details"} onClose={invalidateInspector} size="min(460px, calc(100vw - 24px))" destroyOnHidden closable={{ "aria-label": t("drive.closeDetail") }}>{metadata}</Drawer>
    <Modal className="owb-drive-browser__preview" title={activeObject ? t("drive.previewTitle", { name: activeObject.name }) : ""} open={inspector === "preview"} onCancel={invalidateInspector} closable={{ "aria-label": t("drive.closePreview") }} footer={null} centered width="min(1080px, calc(100vw - 32px))" destroyOnHidden styles={{ container: { maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column" }, body: { minHeight: 0, overflowY: "auto" } }}>
      {activeObject && <div className="owb-drive-browser__preview-body">
        {PREVIEW_MIMES.has(mimeOf(activeObject.mime)) ? <figure aria-label={t("drive.previewAria")}>
          {previewLoading && <div className="owb-drive-browser__image-loading" role="status" aria-label={t("drive.previewLoading")}><Spin size="small" /><span>{t("drive.previewLoading")}</span></div>}
          {previewError && <Alert type="error" showIcon title={t("drive.previewFail")} description={previewError === t("drive.previewFail") ? undefined : previewError} action={<Button onClick={() => void loadPreview(activeObject)}>{t("drive.retry")}</Button>} />}
          {preview && !previewError && <><ImagePreview key={`${preview.objectId}:${previewAttempt}`} src={preview.dataUrl} alt={activeObject.name} preview={{ cover: t("drive.previewLarge") }} onError={() => { if (previewEpoch.current === renderedPreviewEpoch && activeRef.current === preview.objectId && inspectorRef.current === "preview") { setPreview(null); setPreviewError(t("drive.previewInvalid")); } }} /><figcaption>{t("drive.previewHint")}</figcaption></>}
        </figure> : <p className="owb-drive-browser__content-note" role="status">{t(fileKind(activeObject.mime) === "folder" ? "drive.folderUnsupported" : fileKind(activeObject.mime) === "image" ? "drive.previewUnsupported" : "drive.contentUnavailable")}</p>}
        {metadata}
      </div>}
    </Modal>
  </section>;
}
