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
  Dropdown,
  Empty,
  Input,
  List,
  Modal,
  Segmented,
  Spin,
  message,
  type InputRef,
  type MenuProps,
} from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { Check, FileCode2, FolderOpen, LoaderCircle, MoreHorizontal } from "lucide-react";
import { formatDocRefUri } from "@roleweave/shared/docs";
import { useT } from "@roleweave/ui";
import type {
  DocsFileEntry,
  DocsFileListResponse,
  DocsFileResponse,
} from "@roleweave/shared";
import { DocViewer } from "./DocViewer";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor";

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
  writeDoc?(positionId: string, path: string, content: string, expectedVersion: string): Promise<DocsFileResponse>;
  createDoc?(positionId: string, path: string): Promise<void>;
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

function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

type EditorMode = "source" | "live" | "reading";

interface NoteSession {
  draft: string;
  savedContent: string;
  baseVersion: string;
  mode: EditorMode;
  selectionStart: number;
  selectionEnd: number;
  editorScrollTop: number;
  readerScrollTop: number;
}

const noteSessions = new Map<string, NoteSession>();
const noteWriteQueues = new Map<string, Promise<DocsFileResponse>>();

function sessionKey(positionId: string, path: string): string {
  return `${positionId}\u0000${path}`;
}

function enqueueNoteWrite(
  key: string,
  expectedVersion: string,
  write: (version: string) => Promise<DocsFileResponse>,
): Promise<DocsFileResponse> {
  const previous = noteWriteQueues.get(key);
  const queued = previous
    ? previous.then((response) => write(response.version))
    : write(expectedVersion);
  noteWriteQueues.set(key, queued);
  const remove = () => {
    if (noteWriteQueues.get(key) === queued) noteWriteQueues.delete(key);
  };
  void queued.then(remove, remove);
  return queued;
}

function resolveNotePath(currentPath: string, target: string, kind: "wikilink" | "relative"): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "").trim();
  } catch {
    return null;
  }
  if (decoded === "" || decoded.startsWith("/") || decoded.includes("\\")) return null;
  if (kind === "wikilink" && !/\.(md|markdown)$/i.test(decoded)) decoded += ".md";
  const base = currentPath.slice(0, currentPath.lastIndexOf("/") + 1);
  const candidate = decoded.startsWith("knowledge/") ? decoded : `${base}${decoded}`;
  const segments: string[] = [];
  for (const segment of candidate.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (segments.length <= 1) return null;
      segments.pop();
      continue;
    }
    if (!/^(?!\.)[A-Za-z0-9._-]+$/.test(segment)) return null;
    segments.push(segment);
  }
  const resolved = segments.join("/");
  return resolved.startsWith("knowledge/") && /\.(md|markdown)$/i.test(resolved) ? resolved : null;
}

export function DocsPanel({
  positionId,
  listDocs,
  readDoc,
  writeDoc,
  createDoc,
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
  const [messageApi, messageHolder] = message.useMessage();
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
  const [savedContent, setSavedContent] = useState("");
  const [baseVersion, setBaseVersion] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("live");
  const [externalConflict, setExternalConflict] = useState<DocsFileResponse | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [missingNote, setMissingNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<InputRef>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const lifecycleEnabled = Boolean(writeDoc || renameDoc || archiveDoc || restoreDoc || deleteDoc);
  const archivedView = fileScope === "archived";
  const readVersion = useRef(0);
  const [listRetry, setListRetry] = useState(0);
  const requestedSelection = useRef<string | null>(null);
  const externalCheck = useRef<string | null>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const readerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<TextAreaRef>(null);
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
    setExternalConflict(null);
    setCompareOpen(false);
    setMissingNote(null);
    setRenameOpen(false);
    setDeleteOpen(false);
    setSaving(false);
    return () => {
      readVersion.current += 1;
    };
  }, [positionId, archivedView]);

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
      setExternalConflict(null);
      setCompareOpen(false);
      setMissingNote(null);
      setSaving(false);
      setReading(true);
      const version = ++readVersion.current;
      const loaded = archivedView
        ? readDoc(positionId, path, { archived: true })
        : readDoc(positionId, path);
      loaded
        .then((response) => {
          if (version === readVersion.current) {
            const key = sessionKey(positionId, path);
            const cached = noteSessions.get(key);
            const hasDirtyDraft = cached !== undefined && cached.draft !== cached.savedContent;
            const next: NoteSession = hasDirtyDraft
              ? cached
              : {
                  draft: response.content,
                  savedContent: response.content,
                  baseVersion: response.version,
                  mode: cached?.mode ?? "live",
                  selectionStart: cached?.selectionStart ?? 0,
                  selectionEnd: cached?.selectionEnd ?? 0,
                  editorScrollTop: cached?.editorScrollTop ?? 0,
                  readerScrollTop: cached?.readerScrollTop ?? 0,
                };
            noteSessions.set(key, next);
            setDoc(response);
            setDraft(next.draft);
            setSavedContent(next.savedContent);
            setBaseVersion(next.baseVersion);
            setEditorMode(next.mode);
          }
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
    if (!doc || !readerRef.current) return;
    const cached =
      positionId !== null && selected !== null
        ? noteSessions.get(sessionKey(positionId, selected))?.readerScrollTop
        : undefined;
    readerRef.current.scrollTop = cached ?? scrollPositions.current.get(`${positionId}:${selected}`) ?? 0;
  }, [doc, positionId, selected]);

  useLayoutEffect(() => {
    if (positionId === null || selected === null) return;
    const session = noteSessions.get(sessionKey(positionId, selected));
    const textarea = editorRef.current?.resizableTextArea?.textArea;
    if (!session || !textarea) return;
    textarea.setSelectionRange(session.selectionStart, session.selectionEnd);
    textarea.scrollTop = session.editorScrollTop;
  }, [doc, editorMode, positionId, selected]);

  useEffect(() => {
    const key = `${positionId}:${reloadToken}:${requestedPath}`;
    if (requestedPath && requestedSelection.current !== key) {
      requestedSelection.current = key;
      setQuery("");
      setFileScope("all");
      openFile(requestedPath);
    }
  }, [positionId, requestedPath, reloadToken, openFile]);

  const refreshList = useCallback(() => setListRetry((value) => value + 1), []);

  const mutableSelected = selected !== null && isKnowledgeFile(selected);
  const liveEditable = Boolean(
    doc && mutableSelected && !archivedView && writeDoc && isMarkdownFile(doc.path),
  );
  const dirty = liveEditable && (draft !== savedContent || composing);

  const updateComposition = (active: boolean) => {
    composingRef.current = active;
    setComposing(active);
  };

  const updateDraft = (value: string) => {
    setDraft(value);
    if (positionId === null || selected === null) return;
    const key = sessionKey(positionId, selected);
    const session = noteSessions.get(key)!;
    noteSessions.set(key, { ...session, draft: value });
  };

  const saveEdit = useCallback(
    async (content = draft, notify = true, version = baseVersion) => {
      if (positionId === null || selected === null || !writeDoc || saving || composingRef.current || version === "") return;
      const epoch = readVersion.current;
      const actingPosition = positionId;
      const actingArchived = archivedView;
      const actingPath = selected;
      const expectedVersion = version;
      const key = sessionKey(actingPosition, actingPath);
      setSaving(true);
      try {
        const updated = await enqueueNoteWrite(
          key,
          expectedVersion,
          (queuedVersion) => writeDoc(actingPosition, actingPath, content, queuedVersion),
        );
        const session = noteSessions.get(key);
        if (session) {
          noteSessions.set(key, {
            ...session,
            savedContent: content,
            baseVersion: updated.version,
          });
        }
        if (epoch !== readVersion.current || actingPosition !== positionId || actingArchived !== archivedView) return;
        setDoc(updated);
        setSavedContent(content);
        setBaseVersion(updated.version);
        if (!liveEditable) setEditing(false);
        if (notify) messageApi.success(t("docs.saved"));
        refreshList();
      } catch (error) {
        if (epoch !== readVersion.current) return;
        if (error instanceof Error && error.name === "DocsConflictError") {
          try {
            const external = await readDoc(actingPosition, actingPath);
            if (epoch === readVersion.current) setExternalConflict(external);
          } catch (readLatestError) {
            if (epoch === readVersion.current) {
              messageApi.error(readLatestError instanceof Error ? readLatestError.message : t("docs.readFail"));
            }
          }
        } else {
          messageApi.error(error instanceof Error ? error.message : t("docs.editFail"));
        }
      } finally {
        if (epoch === readVersion.current) setSaving(false);
      }
    },
    [archivedView, baseVersion, draft, liveEditable, messageApi, positionId, readDoc, refreshList, saving, selected, t, writeDoc],
  );

  useEffect(() => {
    if (!dirty || composing || saving || externalConflict) return;
    const content = draft;
    const timer = window.setTimeout(() => void saveEdit(content, false), 500);
    return () => window.clearTimeout(timer);
  }, [composing, dirty, draft, externalConflict, saveEdit, saving]);

  useEffect(() => {
    if (
      positionId === null ||
      selected === null ||
      doc === null ||
      archivedView ||
      reading
    ) return;
    const listed = files.find((file) => file.path === selected);
    if (!listed || listed.modifiedAt <= baseVersion) return;
    const checkKey = `${positionId}:${selected}:${listed.modifiedAt}`;
    if (externalCheck.current === checkKey) return;
    externalCheck.current = checkKey;
    const epoch = readVersion.current;
    void readDoc(positionId, selected).then((response) => {
      if (epoch !== readVersion.current) return;
      const key = sessionKey(positionId, selected);
      const session = noteSessions.get(key);
      if (composingRef.current || (session && session.draft !== session.savedContent)) {
        setExternalConflict(response);
        return;
      }
      noteSessions.set(key, {
        draft: response.content,
        savedContent: response.content,
        baseVersion: response.version,
        mode: session?.mode ?? editorMode,
        selectionStart: session?.selectionStart ?? 0,
        selectionEnd: session?.selectionEnd ?? 0,
        editorScrollTop: session?.editorScrollTop ?? 0,
        readerScrollTop: session?.readerScrollTop ?? 0,
      });
      setDoc(response);
      setDraft(response.content);
      setSavedContent(response.content);
      setBaseVersion(response.version);
    });
  }, [archivedView, baseVersion, dirty, doc, editorMode, files, positionId, readDoc, reading, selected]);

  const keepMine = () => {
    if (externalConflict === null || positionId === null || selected === null) return;
    const version = externalConflict.version;
    const key = sessionKey(positionId, selected);
    const session = noteSessions.get(key);
    if (session) noteSessions.set(key, { ...session, baseVersion: version });
    setBaseVersion(version);
    setExternalConflict(null);
    setCompareOpen(false);
    void saveEdit(draft, false, version);
  };

  const reloadExternal = () => {
    if (externalConflict === null || positionId === null || selected === null) return;
    const key = sessionKey(positionId, selected);
    const session = noteSessions.get(key);
    noteSessions.set(key, {
      draft: externalConflict.content,
      savedContent: externalConflict.content,
      baseVersion: externalConflict.version,
      mode: session?.mode ?? editorMode,
      selectionStart: 0,
      selectionEnd: 0,
      editorScrollTop: 0,
      readerScrollTop: session?.readerScrollTop ?? 0,
    });
    setDoc(externalConflict);
    setDraft(externalConflict.content);
    setSavedContent(externalConflict.content);
    setBaseVersion(externalConflict.version);
    setExternalConflict(null);
    setCompareOpen(false);
  };

  const submitRename = async () => {
    if (positionId === null || selected === null || !renameDoc) return;
    const trimmed = renameValue.trim();
    if (trimmed === "") {
      messageApi.error(t("docs.nameRequired"));
      return;
    }
    const parent = selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/") + 1) : "knowledge/";
    const nextPath = trimmed.includes("/") ? trimmed : `${parent}${trimmed}`;
    const epoch = readVersion.current;
    const actingPosition = positionId;
    const actingArchived = archivedView;
    setSaving(true);
    try {
      const renamed = await renameDoc(actingPosition, selected, nextPath);
      if (epoch !== readVersion.current || actingPosition !== positionId || actingArchived !== archivedView) return;
      setRenameOpen(false);
      messageApi.success(t("docs.renamed", { path: renamed.to }));
      setSelected(renamed.to);
      setSaving(false);
      refreshList();
      openFile(renamed.to);
    } catch (error) {
      if (epoch !== readVersion.current) return;
      messageApi.error(error instanceof Error ? error.message : t("docs.renameFail"));
    } finally {
      if (epoch === readVersion.current) setSaving(false);
    }
  };

  const submitArchive = async () => {
    if (positionId === null || selected === null || !archiveDoc) return;
    const epoch = readVersion.current;
    const actingPosition = positionId;
    const actingArchived = archivedView;
    const actingPath = selected;
    setSaving(true);
    try {
      await archiveDoc(actingPosition, actingPath);
      if (epoch !== readVersion.current || actingPosition !== positionId || actingArchived !== archivedView) return;
      messageApi.success(t("docs.archivedOk", { path: actingPath }));
      setSelected(null);
      setDoc(null);
      refreshList();
    } catch (error) {
      if (epoch !== readVersion.current) return;
      messageApi.error(error instanceof Error ? error.message : t("docs.archiveFail"));
    } finally {
      if (epoch === readVersion.current) setSaving(false);
    }
  };

  const submitRestore = async () => {
    if (positionId === null || selected === null || !restoreDoc) return;
    const epoch = readVersion.current;
    const actingPosition = positionId;
    const actingArchived = archivedView;
    const actingPath = selected;
    setSaving(true);
    try {
      await restoreDoc(actingPosition, actingPath);
      if (epoch !== readVersion.current || actingPosition !== positionId || actingArchived !== archivedView) return;
      messageApi.success(t("docs.restored", { path: actingPath }));
      setFileScope("knowledge");
      setSelected(null);
      setDoc(null);
      refreshList();
    } catch (error) {
      if (epoch !== readVersion.current) return;
      messageApi.error(error instanceof Error ? error.message : t("docs.restoreFail"));
    } finally {
      if (epoch === readVersion.current) setSaving(false);
    }
  };

  const submitDelete = async () => {
    if (positionId === null || selected === null || !deleteDoc) return;
    const epoch = readVersion.current;
    const actingPosition = positionId;
    const actingArchived = archivedView;
    const actingPath = selected;
    setSaving(true);
    try {
      if (actingArchived) await deleteDoc(actingPosition, actingPath, { archived: true });
      else await deleteDoc(actingPosition, actingPath);
      if (epoch !== readVersion.current || actingPosition !== positionId || actingArchived !== archivedView) return;
      messageApi.success(t("docs.deleted", { path: actingPath }));
      setDeleteOpen(false);
      setSelected(null);
      setDoc(null);
      refreshList();
    } catch (error) {
      if (epoch !== readVersion.current) return;
      messageApi.error(error instanceof Error ? error.message : t("docs.deleteFail"));
    } finally {
      if (epoch === readVersion.current) setSaving(false);
    }
  };

  const navigateDoc = (target: string, kind: "wikilink" | "relative") => {
    if (selected === null) return;
    const resolved = resolveNotePath(selected, target, kind);
    if (resolved === null) return;
    if (files.some((file) => file.path === resolved)) openFile(resolved);
    else setMissingNote(resolved);
  };

  const createMissingNote = async () => {
    if (positionId === null || missingNote === null || !createDoc) return;
    const path = missingNote;
    setSaving(true);
    try {
      await createDoc(positionId, path);
      setMissingNote(null);
      refreshList();
      openFile(path);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : t("docs.createFail"));
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
      messageApi.success(t("docs.refCopied"));
    } catch {
      messageApi.error(t("docs.clipboardUnavailable"));
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

  const operationBlocked = saving || reading || dirty || editing;
  const canRename = Boolean(mutableSelected && !archivedView && renameDoc && !operationBlocked);
  const beginRename = () => {
    if (!canRename || selected === null) return;
    setRenameValue(selected.slice(selected.lastIndexOf("/") + 1));
    setRenameOpen(true);
  };
  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const documentState = saving ? "docs.saving" : liveEditable ? dirty ? "docs.unsaved" : "docs.saved"
    : editing ? "docs.unsaved" : !mutableSelected ? "docs.boundReadOnly" : "reading.preview";
  const documentMenu: NonNullable<MenuProps["items"]> = [];
  if (doc) {
    if (liveEditable) {
      documentMenu.push(...(["live", "reading", "source"] as const).map((mode) => ({
        key: `mode-${mode}`,
        label: <span aria-current={editorMode === mode ? "true" : undefined}>{t(`docs.mode.${mode}`)}</span>,
        icon: editorMode === mode ? <Check size={14} aria-hidden="true" /> : undefined,
        onClick: () => {
          setEditorMode(mode);
          if (positionId !== null && selected !== null) {
            const key = sessionKey(positionId, selected);
            const session = noteSessions.get(key);
            if (session) noteSessions.set(key, { ...session, mode });
          }
        },
      })), { type: "divider" });
    }
    if (liveEditable || editing) {
      documentMenu.push({
        key: "save",
        label: <span className="owb-doc-menu-label"><span>{t("docs.save")}</span><kbd>{modifier}S</kbd></span>,
        disabled: saving || composing || externalConflict !== null,
        onClick: () => { void saveEdit(draft, false); },
      });
    }
    if (editing && !liveEditable) {
      documentMenu.push({ key: "cancel-edit", label: t("dlg.cancel"), disabled: saving, onClick: () => setEditing(false) });
    } else if (mutableSelected && !archivedView && writeDoc && !liveEditable) {
      documentMenu.push({ key: "edit", label: t("docs.edit"), disabled: saving || reading, onClick: () => {
        setDraft(doc.content);
        setSavedContent(doc.content);
        setBaseVersion(doc.version);
        setEditing(true);
      } });
    }
    if (mutableSelected && !archivedView && renameDoc) {
      documentMenu.push({ key: "rename", label: t("docs.rename"), disabled: operationBlocked, onClick: beginRename });
    }
    if (mutableSelected && !archivedView && archiveDoc) {
      documentMenu.push({ key: "archive", label: t("docs.archive"), disabled: operationBlocked, onClick: () => { void submitArchive(); } });
    }
    if (mutableSelected && archivedView && restoreDoc) {
      documentMenu.push({ key: "restore", label: t("docs.restore"), disabled: operationBlocked, onClick: () => { void submitRestore(); } });
    }
    documentMenu.push({ key: "copy-ref", label: t("docs.copyRef"), onClick: () => {
      void copyRef({ path: doc.path, modifiedAt: doc.version, size: doc.size, kind: "file" });
    } });
    documentMenu.push({ type: "divider" }, { key: "shortcuts", label: t("docs.shortcuts"), onClick: () => setShortcutsOpen(true) });
    if (mutableSelected && deleteDoc) {
      documentMenu.push({ type: "divider" }, { key: "delete", label: t("docs.delete"), danger: true,
        disabled: operationBlocked, onClick: () => setDeleteOpen(true) });
    }
  }

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

  const isMac = modifier === "⌘";
  const combo = (base: string, shift = false) => (isMac ? `${shift ? "⇧" : ""}⌘${base}` : `Ctrl+${shift ? "Shift+" : ""}${base}`);
  const shortcutRows: Array<[string, string]> = [
    [combo("B"), "docs.shortcut.bold"],
    [combo("I"), "docs.shortcut.italic"],
    [combo("X", true), "docs.shortcut.strike"],
    [isMac ? "⌘1 ~ ⌘6" : "Ctrl+1 ~ Ctrl+6", "docs.shortcut.heading"],
    [combo("L"), "docs.shortcut.ul"],
    [combo("O"), "docs.shortcut.ol"],
    [combo("J"), "docs.shortcut.task"],
    [combo("O", true), "docs.shortcut.indent"],
    [combo("I", true), "docs.shortcut.outdent"],
    [combo(";"), "docs.shortcut.quote"],
    [combo("H", true), "docs.shortcut.hr"],
    [combo("G"), "docs.shortcut.inlineCode"],
    [combo("U"), "docs.shortcut.codeBlock"],
    [combo("M"), "docs.shortcut.table"],
    [combo("K"), "docs.shortcut.link"],
    [combo("Z"), "docs.shortcut.undo"],
    [combo("Z", true), "docs.shortcut.redo"],
    [combo("S"), "docs.shortcut.save"],
  ];

  return (
    <section className="owb-docs-panel" aria-label={t("docs.panelAria")}>
      {messageHolder}
      {positionId === null ? (
        <Empty description={t("docs.pickFromTree")} />
      ) : (
        <>
          <div className="owb-docs-panel__workspace">
            <div className="owb-docs-panel__list-pane">
              <header className="owb-docs-panel__header">
                <Input
                  allowClear
                  aria-label={t("memory.search")}
                  placeholder={t("memory.search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {toolbar}
              </header>
              {knowledgeFirst || lifecycleEnabled ? (
                <div className="owb-docs-panel__scope">
                  <Segmented
                    aria-label={t("memory.fileScope")}
                    size="small"
                    block
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
                </div>
              ) : null}
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
                      <Dropdown trigger={["contextMenu"]} destroyOnHidden menu={{ items: [
                        { key: "copy-ref", label: t("docs.copyRef"), onClick: () => { void copyRef(entry); } },
                      ] }}>
                        <button
                          type="button"
                          className="owb-docs-panel__file"
                          title={`${entry.path} · ${fileTypeLabel(entry.path)} · ${formatSize(entry.size)}`}
                          aria-label={entry.path}
                          aria-pressed={selected === entry.path}
                          onClick={() => openFile(entry.path)}
                        >
                          {renderFilePath(entry.path)}
                        </button>
                      </Dropdown>
                    </List.Item>
                  )}
                />
              ) : null}
            </div>
            <div
              ref={readerRef}
              onScroll={() => {
                if (doc && selected && readerRef.current) {
                  const scrollTop = readerRef.current.scrollTop;
                  scrollPositions.current.set(`${positionId}:${selected}`, scrollTop);
                  if (positionId !== null) {
                    const key = sessionKey(positionId, selected);
                    const session = noteSessions.get(key);
                    if (session) noteSessions.set(key, { ...session, readerScrollTop: scrollTop });
                  }
                }
              }}
              className={`owb-docs-panel__reader-pane${liveEditable && editorMode === "live" ? " owb-docs-panel__reader-pane--live" : ""}`}
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
              {doc !== null && missingNote !== null ? (
                <Alert
                  className="owb-docs-panel__missing-note"
                  type="info"
                  showIcon
                  message={t("docs.missingNote", { path: missingNote })}
                  action={createDoc ? (
                    <Button size="small" loading={saving} onClick={() => void createMissingNote()}>
                      {t("docs.createMissing")}
                    </Button>
                  ) : undefined}
                />
              ) : null}
              {doc !== null && externalConflict !== null ? (
                <>
                  <Alert
                    className="owb-docs-panel__conflict"
                    type="warning"
                    showIcon
                    message={t("docs.conflict")}
                    action={
                      <div className="owb-docs-panel__conflict-actions">
                        <Button size="small" onClick={() => setCompareOpen((open) => !open)}>
                          {t("docs.compare")}
                        </Button>
                        <Button size="small" onClick={reloadExternal}>
                          {t("docs.reloadExternal")}
                        </Button>
                        <Button size="small" type="primary" onClick={keepMine}>
                          {t("docs.keepMine")}
                        </Button>
                      </div>
                    }
                  />
                  {compareOpen ? (
                    <div className="owb-docs-panel__compare" role="region" aria-label={t("docs.compareAria")}>
                      <section>
                        <strong>{t("docs.localVersion")}</strong>
                        <pre>{draft}</pre>
                      </section>
                      <section>
                        <strong>{t("docs.externalVersion")}</strong>
                        <pre>{externalConflict.content}</pre>
                      </section>
                    </div>
                  ) : null}
                </>
              ) : null}
              {doc !== null ? (
                <header className="owb-doc-viewer__toolbar owb-docs-panel__toolbar" role="toolbar" aria-label={t("docs.toolbarAria")}>
                  <div className="owb-doc-viewer__location">
                    {mutableSelected && !archivedView && renameDoc ? (
                      <button type="button" className="owb-docs-panel__title" disabled={!canRename}
                        title={`${doc.path} · ${t("docs.renameHint")}`} onDoubleClick={beginRename}
                        onKeyDown={(event) => {
                          if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            beginRename();
                          }
                        }}>
                        {stripExtension(doc.path.slice(doc.path.lastIndexOf("/") + 1))}
                      </button>
                    ) : <strong title={doc.path}>{stripExtension(doc.path.slice(doc.path.lastIndexOf("/") + 1))}</strong>}
                  </div>
                  <span className="owb-docs-panel__save-status" role="status" aria-label={t(documentState)}>{t(documentState)}</span>
                  <Dropdown trigger={["click"]} destroyOnHidden menu={{ items: documentMenu }}>
                    <Button type="text" size="small" icon={<MoreHorizontal size={17} aria-hidden="true" />}
                      aria-label={t("docs.moreActions")} title={t("docs.moreActions")} disabled={reading} />
                  </Dropdown>
                </header>
              ) : null}
              {doc !== null && (editing || (liveEditable && editorMode === "source")) ? (
                <div className={`owb-docs-panel__editor${liveEditable ? " owb-docs-panel__editor--live" : ""}`}>
                  <Input.TextArea
                    ref={editorRef}
                    aria-label={t("docs.editorAria")}
                    value={draft}
                    rows={18}
                    disabled={saving && !liveEditable}
                    onChange={(event) => {
                      updateDraft(event.target.value);
                      if (positionId !== null && selected !== null) {
                        const key = sessionKey(positionId, selected);
                        const session = noteSessions.get(key)!;
                        noteSessions.set(key, {
                          ...session,
                          selectionStart: event.target.selectionStart,
                          selectionEnd: event.target.selectionEnd,
                        });
                      }
                    }}
                    onSelect={(event) => {
                      if (positionId === null || selected === null) return;
                      const session = noteSessions.get(sessionKey(positionId, selected));
                      if (!session) return;
                      noteSessions.set(sessionKey(positionId, selected), {
                        ...session,
                        selectionStart: event.currentTarget.selectionStart,
                        selectionEnd: event.currentTarget.selectionEnd,
                      });
                    }}
                    onScroll={(event) => {
                      if (positionId === null || selected === null) return;
                      const session = noteSessions.get(sessionKey(positionId, selected));
                      if (!session) return;
                      noteSessions.set(sessionKey(positionId, selected), {
                        ...session,
                        editorScrollTop: event.currentTarget.scrollTop,
                      });
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                        event.preventDefault();
                        void saveEdit(event.currentTarget.value, false);
                      }
                    }}
                  />
                </div>
              ) : null}
              {doc !== null && (!editing || liveEditable) && (!liveEditable || editorMode !== "source") ? (
                <DocViewer
                  source={liveEditable ? draft : doc.content}
                  version={doc.version}
                  updatedAt={doc.modifiedAt}
                  title={doc.path}
                  path={doc.path}
                  onNavigateDoc={navigateDoc}
                  showEditor={editorMode !== "reading"}
                  editor={liveEditable && positionId !== null ? (
                    <LiveMarkdownEditor
                      key={sessionKey(positionId, doc.path)}
                      sessionId={sessionKey(positionId, doc.path)}
                      active={editorMode === "live"}
                      value={draft}
                      onChange={updateDraft}
                      onSave={(value) => void saveEdit(value, false)}
                      ariaLabel={t("docs.editorAria")}
                      onNavigateDoc={navigateDoc}
                      onCompositionChange={updateComposition}
                    />
                  ) : undefined}
                  showToolbar={false}
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
        afterOpenChange={(open) => { if (open) renameInputRef.current?.focus({ cursor: "all" }); }}
        confirmLoading={saving}
        okText={t("docs.rename")}
        cancelText={t("dlg.cancel")}
        onOk={() => void submitRename()}
        onCancel={() => {
          if (!saving) setRenameOpen(false);
        }}
      >
        <Input
          ref={renameInputRef}
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
      <Modal
        title={t("docs.shortcuts")}
        open={shortcutsOpen}
        footer={null}
        onCancel={() => setShortcutsOpen(false)}
      >
        <table className="owb-docs-panel__shortcuts" aria-label={t("docs.shortcutsAria")}>
          <tbody>
            {shortcutRows.map(([keys, labelKey]) => (
              <tr key={labelKey}>
                <td><kbd>{keys}</kbd></td>
                <td>{t(labelKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    </section>
  );
}
