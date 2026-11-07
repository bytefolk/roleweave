import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Select, Space, Spin, Tooltip, message } from "antd";
import { FolderOpen, ImagePlus, Plus, RefreshCw, UsersRound } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { DocsFileEntry, DocsFileListResponse, DocsFileResponse, DriveObject, VaultNote, VaultNoteResponse, VaultSourceRef } from "@roleweave/shared";
import type { PositionMentionOption } from "../turns/types";
import { DocsPanel, documentScopeDirty } from "../docs/DocsPanel";
import { DocViewer } from "../docs/DocViewer";
import "./vault-workspace.css";

function responseBody<T>(response: { status: number; body: T }, fallback: string): T {
  if (response.status < 200 || response.status >= 300 || !response.body) {
    const body = response.body as { message?: string } | null;
    const error = new Error(body?.message ?? fallback);
    if (response.status === 409) error.name = "DocsConflictError";
    throw error;
  }
  return response.body;
}

function notePath(name: string): string {
  const path = name.trim();
  return /\.(md|markdown)$/i.test(path) ? path : `${path}.md`;
}

interface VaultModuleProps {
  workspaceKey: string;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  onOpenSource?: (source: VaultSourceRef) => void;
  resourceRequest?: { positionId: string; path: string; nonce: number } | null;
}
export function VaultModule(props: VaultModuleProps) {
  const t = useT();
  const [vaultId, setVaultId] = useState<string>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true; setVaultId(undefined); setError(undefined);
    const load = async () => {
      try {
        const source = responseBody(await window.owb.vault.source(), t("vault.loadFail"));
        if (current) setVaultId(source.vaultId);
      } catch (failure) { if (current) setError(failure instanceof Error ? failure.message : t("vault.loadFail")); }
    };
    void load(); return () => { current = false; };
  }, [props.workspaceKey, retry, t]);
  if (error) return <Alert type="error" title={t("vault.loadFail")} description={error} action={<Button aria-label={t("hire.retry")} onClick={() => setRetry((value) => value + 1)}>{t("hire.retry")}</Button>} />;
  if (!vaultId) return <div role="status" aria-label={t("vault.loading")}><Spin /></div>;
  return <VaultWorkspace key={`${props.workspaceKey}:${vaultId}`} {...props} vaultId={vaultId} />;
}

function VaultWorkspace({ workspaceKey, vaultId, positions, selectedPositionId, resourceRequest, onOpenSource }: VaultModuleProps & { vaultId: string }) {
  const t = useT();
  const [messageApi, messageHolder] = message.useMessage();
  const notes = useRef(new Map<string, VaultNote>());
  const scope = `vault:${vaultId}:${workspaceKey}`;
  const [revision, setRevision] = useState(0);
  const [scopePosition, setScopePosition] = useState<string>();
  const [requestedPath, setRequestedPath] = useState<string>();
  const selectedPathRef = useRef<string>();
  const [dirty, setDirty] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const [bindingPosition, setBindingPosition] = useState<string>();
  const [bindingNotes, setBindingNotes] = useState<VaultNote[]>([]);
  const [boundIds, setBoundIds] = useState<string[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string>();
  const [imagesOpen, setImagesOpen] = useState(false);
  const [images, setImages] = useState<DriveObject[]>([]);
  const [imageId, setImageId] = useState<string>();
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [insertRequest, setInsertRequest] = useState<{ path: string; text: string; nonce: number } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTarget, setSyncTarget] = useState<string>();
  const [targets, setTargets] = useState<Array<{ vaultId: string; title: string }>>([]);
  const [syncNotice, setSyncNotice] = useState<{ status: string; pushed: number; pulled: number; conflicts: Array<{ path: string; copyPath: string }> }>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyNote, setHistoryNote] = useState<VaultNote>();
  const [historyVersions, setHistoryVersions] = useState<Array<{ version: string; path: string; createdAt: string; content: string }>>([]);
  const [historyChoice, setHistoryChoice] = useState<number>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const historyRequest = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const remember = useCallback((note: VaultNote) => { notes.current.set(note.path, note); return note; }, []);
  const fileResponse = useCallback((body: VaultNoteResponse): DocsFileResponse => {
    remember(body.note);
    return { schemaVersion: "docs-file.v1", positionId: scope, path: body.note.path,
      content: body.content, version: body.note.version, modifiedAt: body.note.modifiedAt, size: body.note.size };
  }, [remember, scope]);
  const list = useCallback(async (_id: string, options?: { archived?: boolean }, q?: string): Promise<DocsFileListResponse> => {
    const body = responseBody(await window.owb.vault.list({ q, positionId: scopePosition, archived: options?.archived, includeLegacy: true }), t("vault.loadFail"));
    for (const note of body.notes) remember(note);
    return { schemaVersion: "docs-file-list.v1", positionId: scope,
      files: body.notes.map((note) => ({ path: note.path, kind: "file", size: note.size, modifiedAt: note.modifiedAt })) };
  }, [scopePosition, remember, scope, t]);
  const search = useCallback((id: string, query: string, options?: { archived?: boolean }) => list(id, options, query), [list]);
  const currentNote = useCallback((path: string) => {
    const note = notes.current.get(path);
    if (!note) throw new Error(t("vault.noteMissing"));
    return note;
  }, [t]);
  const read = useCallback(async (_id: string, path: string) => fileResponse(responseBody(await window.owb.vault.read(currentNote(path).noteId), t("docs.readFail"))), [currentNote, fileResponse, t]);
  const write = useCallback(async (_id: string, path: string, value: string, expectedVersion: string) => fileResponse(responseBody(await window.owb.vault.write({ noteId: currentNote(path).noteId, content: value, expectedVersion }), t("docs.editFail"))), [currentNote, fileResponse, t]);
  const create = useCallback(async (_id: string, path: string) => { remember(responseBody(await window.owb.vault.create({ path, content: `# ${path.split("/").pop()!.replace(/\.(md|markdown)$/i, "")}\n` }), t("docs.createFail")).note); }, [remember, t]);
  const rename = useCallback(async (_id: string, from: string, to: string) => {
    const note = currentNote(from);
    const body = responseBody(await window.owb.vault.rename({ noteId: note.noteId, path: to, expectedVersion: note.version }), t("docs.renameFail"));
    notes.current.delete(from); remember(body.note); return { to: body.note.path };
  }, [currentNote, remember, t]);
  const archive = useCallback(async (_id: string, path: string) => {
    const note = currentNote(path); remember(responseBody(await window.owb.vault.archive({ noteId: note.noteId, expectedVersion: note.version }), t("docs.archiveFail")).note);
  }, [currentNote, remember, t]);
  const restore = useCallback(async (_id: string, path: string) => {
    const note = currentNote(path); remember(responseBody(await window.owb.vault.restore({ noteId: note.noteId, expectedVersion: note.version }), t("docs.restoreFail")).note);
  }, [currentNote, remember, t]);
  const remove = useCallback(async (_id: string, path: string) => {
    const note = currentNote(path); responseBody(await window.owb.vault.delete({ noteId: note.noteId, expectedVersion: note.version }), t("docs.deleteFail")); notes.current.delete(path);
  }, [currentNote, t]);
  const canMutate = useCallback((path: string) => notes.current.get(path)?.readOnly === false, []);
  const reference = useCallback((entry: DocsFileEntry) => JSON.stringify(currentNote(entry.path).ref), [currentNote]);
  const onSelectPath = useCallback((path: string) => { selectedPathRef.current = path; }, []);
  const referenceVersion = useRef(0);
  const onNavigateReference = useCallback((uri: string) => {
    const version = ++referenceVersion.current;
    void window.owb.vault.resolve({ uri }).then((result) => {
      if (!alive.current || version !== referenceVersion.current) return;
      const body = responseBody(result, t("vault.loadFail")); remember(body.note);
      setRequestedPath(body.note.path); setScopePosition(undefined); setRevision((value) => value + 1);
    }).catch((failure) => { if (alive.current && version === referenceVersion.current) messageApi.error(failure instanceof Error ? failure.message : t("vault.loadFail")); });
  }, [remember, t, messageApi]);
  const resolveUnlistedNote = useCallback(async (path: string, target: string, kind: "wikilink" | "relative") => {
    const version = ++referenceVersion.current;
    const result = responseBody(await window.owb.vault.list({ includeLegacy: true }), t("vault.loadFail"));
    if (!alive.current || version !== referenceVersion.current) return true;
    for (const note of result.notes) remember(note);
    let rootTarget = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
    if (kind === "wikilink" && !/\.(md|markdown)$/i.test(rootTarget)) rootTarget += ".md";
    const exact = result.notes.find((note) => note.path === path || note.path === rootTarget);
    const basename = path.split("/").pop()!;
    const candidates = result.notes.filter((note) => note.path === basename || note.path.endsWith(`/${basename}`));
    const found = exact ?? (kind === "wikilink" && candidates.length === 1 ? candidates[0] : undefined);
    if (!found) return false;
    setRequestedPath(found.path); setScopePosition(undefined); setRevision((value) => value + 1); return true;
  }, [remember, t]);
  const loadImage = useCallback(async (path: string) => {
    const body = responseBody(await window.owb.vault.image({ path: decodeURIComponent(path), notePath: selectedPathRef.current }), t("drive.previewFail"));
    return body.preview.dataUrl;
  }, [t]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    if (!resourceRequest) return;
    if (resourceRequest.path.startsWith("vault://notes/")) {
      let current = true;
      void window.owb.vault.resolve({ uri: resourceRequest.path }).then((response) => {
        if (!current) return;
        const body = responseBody(response, t("vault.loadFail")); remember(body.note);
        setRequestedPath(body.note.path); setScopePosition(undefined); setRevision((value) => value + 1);
      }).catch((error) => { if (current) messageApi.error(error instanceof Error ? error.message : t("vault.loadFail")); });
      return () => { current = false; };
    }
    const path = `positions/${resourceRequest.positionId}/${resourceRequest.path}`;
    setRequestedPath(path); setScopePosition(undefined); setRevision((value) => value + 1);
  }, [resourceRequest, remember, t, messageApi]);
  useEffect(() => {
    if (!bindingsOpen || !bindingPosition) return;
    let current = true; setBindingsLoading(true); setBindingsError(undefined); setBoundIds([]); setBindingNotes([]);
    void Promise.all([window.owb.vault.list({ includeLegacy: true }), window.owb.vault.bindings(bindingPosition)]).then(([listed, bound]) => {
      if (!current) return;
      const all = responseBody(listed, t("vault.loadFail"));
      const result = responseBody(bound, t("vault.bindingFail"));
      setBindingNotes(all.notes); setBoundIds(result.bindings.find((entry) => entry.positionId === bindingPosition)?.noteIds ?? []);
    }).catch((error) => { if (current) setBindingsError(error instanceof Error ? error.message : t("vault.bindingFail")); })
      .finally(() => { if (current) setBindingsLoading(false); });
    return () => { current = false; };
  }, [bindingsOpen, bindingPosition, t]);
  useEffect(() => {
    if (!imagesOpen) return;
    let current = true; setImagesLoading(true); setImageError(undefined); setImageId(undefined); setImages([]);
    void window.owb.drive.list().then((result) => {
      if (!current) return;
      setImages(responseBody(result, t("drive.listFail")).objects.filter((object) => /^image\/(png|jpeg|webp|gif)$/i.test(object.mime.split(";", 1)[0]!.trim())));
    }).catch((error) => { if (current) setImageError(error instanceof Error ? error.message : t("drive.listFail")); })
      .finally(() => { if (current) setImagesLoading(false); });
    return () => { current = false; };
  }, [imagesOpen, t]);

  async function submitCreate() {
    if (actionLock.current || !name.trim()) { if (!name.trim()) setCreateError(t("docs.nameRequired")); return; }
    actionLock.current = true; setBusy(true); setCreateError(undefined);
    try {
      const body = responseBody(await window.owb.vault.create({ path: notePath(name), content }), t("docs.createFail"));
      if (!alive.current) return;
      remember(body.note); setRequestedPath(body.note.path); setScopePosition(undefined); setRevision((value) => value + 1); setCreateOpen(false);
    } catch (error) { if (alive.current) setCreateError(error instanceof Error ? error.message : t("docs.createFail")); }
    finally { actionLock.current = false; if (alive.current) setBusy(false); }
  }
  async function saveBindings() {
    if (!bindingPosition || actionLock.current || bindingsLoading || bindingsError) return;
    actionLock.current = true; setBusy(true); setBindingsError(undefined);
    try {
      responseBody(await window.owb.vault.bind({ positionId: bindingPosition, noteIds: boundIds }), t("vault.bindingFail"));
      if (!alive.current) return;
      setBindingsOpen(false); setRevision((value) => value + 1); messageApi.success(t("vault.bindingsSaved"));
    } catch (error) { if (alive.current) setBindingsError(error instanceof Error ? error.message : t("vault.bindingFail")); }
    finally { actionLock.current = false; if (alive.current) setBusy(false); }
  }
  async function insertImage() {
    if (!imageId || actionLock.current || imagesLoading) return;
    const path = selectedPathRef.current; const note = path ? notes.current.get(path) : undefined;
    actionLock.current = true; setBusy(true); setImageError(undefined);
    try {
      const image = responseBody(await window.owb.vault.attach({ fileId: imageId }), t("drive.previewFail"));
      if (!alive.current) return;
      if (note && path !== selectedPathRef.current) throw new Error(t("vault.noteChanged"));
      const depth = note && !note.readOnly ? note.path.split("/").length - 1 : 0;
      const relative = `${"../".repeat(depth)}${image.path}`;
      const markdown = `![${image.name.replace(/[\[\]\r\n]/g, " ")}](<${relative}>)`;
      if (note && !note.readOnly && !note.archived) setInsertRequest({ path: note.path, text: markdown, nonce: Date.now() });
      else {
        const created = responseBody(await window.owb.vault.create({ path: `${image.name.replace(/\.[^.]+$/, "")}-${Date.now()}.md`, content: markdown + "\n" }), t("docs.createFail"));
        if (!alive.current) return;
        remember(created.note); setRequestedPath(created.note.path); setScopePosition(undefined); setRevision((value) => value + 1);
      }
      setImagesOpen(false);
    } catch (error) { if (alive.current) setImageError(error instanceof Error ? error.message : t("drive.previewFail")); }
    finally { actionLock.current = false; if (alive.current) setBusy(false); }
  }
  async function openSync() {
    if (documentScopeDirty(scope)) { setDirty(true); return; }
    setSyncOpen(true); setSyncTarget(undefined); setSyncNotice(undefined);
    try { const result = responseBody(await window.owb.vault.targets(), t("vault.syncFail")); if (alive.current) setTargets(result.vaults); }
    catch { if (alive.current) setTargets([]); }
  }
  async function sync() {
    if (dirty || actionLock.current || documentScopeDirty(scope)) return; actionLock.current = true; setBusy(true);
    try {
      const result = responseBody(await window.owb.vault.sync({ vaultId: syncTarget }), t("vault.syncFail"));
      if (!alive.current) return; setSyncNotice(result); setRevision((value) => value + 1);
    } catch (error) { if (alive.current) messageApi.error(error instanceof Error ? error.message : t("vault.syncFail")); }
    finally { actionLock.current = false; if (alive.current) setBusy(false); }
  }
  async function openHistory(note: VaultNote) {
    if (documentScopeDirty(scope)) { messageApi.warning(t("vault.historyDirty")); return; }
    const version = ++historyRequest.current;
    setHistoryNote(note); setHistoryOpen(true); setHistoryVersions([]); setHistoryChoice(undefined); setHistoryError(undefined); setHistoryLoading(true);
    try {
      const result = responseBody(await window.owb.vault.history(note.noteId), t("vault.historyFail"));
      if (!alive.current || version !== historyRequest.current) return;
      setHistoryVersions(result.versions); setHistoryChoice(result.versions.length ? 0 : undefined);
    } catch (failure) { if (alive.current && version === historyRequest.current) setHistoryError(failure instanceof Error ? failure.message : t("vault.historyFail")); }
    finally { if (alive.current && version === historyRequest.current) setHistoryLoading(false); }
  }
  async function restoreVersion() {
    const previous = historyChoice === undefined ? undefined : historyVersions[historyChoice];
    if (!previous || !historyNote || historyNote.readOnly || actionLock.current || documentScopeDirty(scope)) return;
    actionLock.current = true; setBusy(true); setHistoryError(undefined);
    try {
      const latest = responseBody(await window.owb.vault.read(historyNote.noteId), t("docs.readFail"));
      if (!alive.current || documentScopeDirty(scope)) return;
      const result = responseBody(await window.owb.vault.write({ noteId: historyNote.noteId, content: previous.content, expectedVersion: latest.note.version }), t("vault.historyRestoreFail"));
      if (!alive.current) return;
      remember(result.note); setRequestedPath(result.note.path); setRevision((value) => value + 1); setHistoryOpen(false); messageApi.success(t("vault.historyRestored"));
    } catch (failure) { if (alive.current) setHistoryError(failure instanceof Error && failure.name === "DocsConflictError" ? t("vault.historyConflict") : failure instanceof Error ? failure.message : t("vault.historyRestoreFail")); }
    finally { actionLock.current = false; if (alive.current) setBusy(false); }
  }
  const historyVersion = historyChoice === undefined ? undefined : historyVersions[historyChoice];
  const historyImageLoader = useCallback(async (path: string) => responseBody(await window.owb.vault.image({ path: decodeURIComponent(path), notePath: historyVersions[historyChoice ?? 0]?.path }), t("drive.previewFail")).preview.dataUrl, [historyVersions, historyChoice, t]);

  return <section className="owb-vault-module" aria-label={t("vault.workspaceAria")}>
    {messageHolder}
    <div className="owb-vault-module__controls">
      <Select aria-label={t("vault.scopeAria")} value={scopePosition} allowClear placeholder={t("vault.allNotes")}
        onChange={(value) => { setScopePosition(value); setRequestedPath(undefined); }} options={positions.map((position) => ({ value: position.id, label: t("vault.positionScope", { name: position.name }) }))} />
      <Space>
        <Tooltip title={t("vault.openFolder")}><Button aria-label={t("vault.openFolder")} icon={<FolderOpen size={15} />} onClick={() => {
          void window.owb.openWorkspaceFile?.("notes", workspaceKey).then((result) => { if (!result.opened && alive.current) messageApi.error(t("vault.openFolderFail")); }).catch(() => { if (alive.current) messageApi.error(t("vault.openFolderFail")); });
        }} /></Tooltip>
        <Tooltip title={t("vault.refresh")}><Button aria-label={t("vault.refresh")} icon={<RefreshCw size={15} />} onClick={() => setRevision((value) => value + 1)} /></Tooltip>
        <Tooltip title={t("vault.bindings")}><Button aria-label={t("vault.bindings")} icon={<UsersRound size={15} />} disabled={!positions.length}
          onClick={() => { setBindingPosition(selectedPositionId ?? positions[0]?.id); setBindingsOpen(true); }} /></Tooltip>
        <Tooltip title={t("vault.insertImage")}><Button aria-label={t("vault.insertImage")} icon={<ImagePlus size={15} />} onClick={() => setImagesOpen(true)} /></Tooltip>
        <Tooltip title={dirty ? t("vault.syncDirty") : t("vault.sync")}><Button aria-label={t("vault.sync")} icon={<RefreshCw size={15} />} disabled={dirty || busy} onClick={() => void openSync()} /></Tooltip>
      </Space>
    </div>
    <DocsPanel key={scopePosition ?? "all"} mode="vault" storageScope={scope} positionId={null} knowledgeFirst
      listDocs={list} searchDocs={search} readDoc={read} writeDoc={write} createDoc={create} renameDoc={rename}
      archiveDoc={archive} restoreDoc={restore} deleteDoc={remove} canMutate={canMutate} fileReference={reference}
      imageResourceLoader={loadImage} onDirtyChange={setDirty} onSelectPath={onSelectPath} onNavigateReference={onNavigateReference} resolveUnlistedNote={resolveUnlistedNote} insertRequest={insertRequest}
      reloadToken={revision} requestedPath={requestedPath}
      documentActions={(path) => {
        const note = notes.current.get(path);
        return <>{note?.legacy ? <span className="owb-vault-module__legacy">{t("vault.legacyReadOnly")}</span> : null}
          {note && !note.readOnly ? <Button type="text" size="small" disabled={dirty || busy} onClick={() => void openHistory(note)}>{t("vault.history")}</Button> : null}
          {note?.source?.positionId && note.source.sessionId && onOpenSource ? <Button type="text" size="small" onClick={() => onOpenSource(note.source!)}>{t("vault.sourceConversation")}</Button> : null}</>;
      }}
      toolbar={<Button aria-label={t("vault.create")} icon={<Plus size={16} />} onClick={() => { setName(""); setContent(""); setCreateError(undefined); setCreateOpen(true); }} />} />
    <Modal className="owb-vault-dialog" title={t("vault.create")} open={createOpen} onCancel={() => { if (!busy) setCreateOpen(false); }} onOk={() => void submitCreate()} confirmLoading={busy} okText={t("docs.createAction")} cancelText={t("dlg.cancel")} maskClosable={!busy} closable={!busy}>
      <Input aria-label={t("vault.nameAria")} placeholder={t("vault.nameHint")} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      <Input.TextArea aria-label={t("memory.content")} value={content} onChange={(event) => setContent(event.target.value)} rows={8} disabled={busy} />
      {createError ? <Alert type="error" title={createError} /> : null}
    </Modal>
    <Modal className="owb-vault-dialog" title={t("vault.bindings")} open={bindingsOpen} onCancel={() => { if (!busy) setBindingsOpen(false); }} onOk={() => void saveBindings()} confirmLoading={busy} okButtonProps={{ disabled: !bindingPosition || bindingsLoading || Boolean(bindingsError) }} cancelText={t("dlg.cancel")} okText={t("docs.save")}>
      <p>{t("vault.bindingsHint")}</p>
      <Select aria-label={t("vault.bindingPosition")} value={bindingPosition} onChange={setBindingPosition} options={positions.map((position) => ({ value: position.id, label: position.name }))} disabled={busy} />
      <Select mode="multiple" aria-label={t("vault.bindingNotes")} value={boundIds} onChange={setBoundIds} loading={bindingsLoading} disabled={busy || bindingsLoading} showSearch optionFilterProp="label"
        options={bindingNotes.map((note) => ({ value: note.noteId, label: `${note.title} · ${note.path}` }))} />
      {bindingsError ? <Alert type="error" title={bindingsError} /> : null}
    </Modal>
    <Modal className="owb-vault-dialog" title={t("vault.insertImage")} open={imagesOpen} onCancel={() => { if (!busy) setImagesOpen(false); }} onOk={() => void insertImage()} confirmLoading={busy} okButtonProps={{ disabled: !imageId || imagesLoading }} okText={t("vault.insert")} cancelText={t("dlg.cancel")}>
      <p>{t("vault.imageHint")}</p>
      <Select aria-label={t("vault.imagePicker")} value={imageId} onChange={setImageId} loading={imagesLoading} disabled={busy || imagesLoading} showSearch optionFilterProp="label"
        options={images.map((image) => ({ value: image.id, label: image.name }))} notFoundContent={t("vault.noImages")} />
      {imageError ? <Alert type="error" title={imageError} /> : null}
    </Modal>
    <Modal className="owb-vault-dialog" title={t("vault.sync")} open={syncOpen} onCancel={() => { if (!busy) setSyncOpen(false); }} onOk={() => void sync()} confirmLoading={busy} okButtonProps={{ disabled: dirty }} okText={t("vault.sync")} cancelText={t("dlg.close")}>
      <p>{t("vault.syncHint")}</p>
      <Select aria-label={t("vault.syncTarget")} value={syncTarget} onChange={setSyncTarget} allowClear placeholder={t("vault.newSyncTarget")}
        options={targets.map((target) => ({ value: target.vaultId, label: target.title }))} disabled={busy} />
      {syncNotice ? <Alert type={syncNotice.status === "conflict" || syncNotice.status === "local_changed" ? "warning" : syncNotice.status === "not_configured" ? "info" : "success"} title={t(`vault.sync.${syncNotice.status}`, { pushed: syncNotice.pushed, pulled: syncNotice.pulled })}
        description={syncNotice.conflicts.map((conflict) => <p key={conflict.path}>{t("vault.syncConflict", { path: conflict.path, copy: conflict.copyPath })}</p>)} /> : null}
    </Modal>
    <Modal className="owb-vault-dialog" title={t("vault.history")} open={historyOpen} width={760} onCancel={() => { if (!busy) { historyRequest.current += 1; setHistoryOpen(false); } }} footer={[
      <Button key="close" disabled={busy} onClick={() => { historyRequest.current += 1; setHistoryOpen(false); }}>{t("dlg.close")}</Button>,
      <Button key="restore" type="primary" loading={busy} disabled={dirty || historyLoading || !historyVersion || Boolean(historyError)} onClick={() => void restoreVersion()}>{t("vault.historyRestore")}</Button>,
    ]}>
      <p>{t("vault.historyHint")}</p>
      <Select aria-label={t("vault.historyPicker")} value={historyChoice} onChange={setHistoryChoice} loading={historyLoading} disabled={busy || historyLoading}
        options={historyVersions.map((version, index) => ({ value: index, label: `${new Date(version.createdAt).toLocaleString()} · ${version.path}` }))} notFoundContent={t("vault.historyEmpty")} />
      {historyError ? <Alert type="error" title={historyError} /> : null}
      {historyVersion ? <div className="owb-vault-history-preview"><DocViewer source={historyVersion.content} path={historyVersion.path} showToolbar={false} imageResourceLoader={historyImageLoader} /></div> : null}
    </Modal>
  </section>;
}
