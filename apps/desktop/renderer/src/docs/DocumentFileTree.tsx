import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { Tooltip } from "antd";
import { useT } from "@roleweave/ui";
import type { DocsFileEntry } from "@roleweave/shared";

type FileNode = { kind: "file"; path: string; name: string; entry: DocsFileEntry };
type FolderNode = { kind: "folder"; path: string; name: string; children: FileNodeOrFolder[] };
type FileNodeOrFolder = FileNode | FolderNode;

function directories(files: DocsFileEntry[]): FileNodeOrFolder[] {
  const roots: FileNodeOrFolder[] = [];
  const folders = new Map<string, FolderNode>();
  for (const entry of files) {
    const parts = entry.path.split("/");
    let children = roots;
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = parts.slice(0, depth + 1).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: "folder", path, name: parts[depth]!, children: [] };
        folders.set(path, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({ kind: "file", path: entry.path, name: parts.at(-1)!, entry });
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sort = (nodes: FileNodeOrFolder[]) => {
    nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : collator.compare(a.name, b.name));
    for (const node of nodes) if (node.kind === "folder") sort(node.children);
  };
  sort(roots);
  return roots;
}

/** A file explorer for actual workspace paths; remote document titles are not paths. */
export function DocumentFileTree({ files, selectedPath, query, hidden, empty, renderFile, onCollapse }: {
  files: DocsFileEntry[];
  selectedPath: string | null;
  query: string;
  hidden: boolean;
  empty: ReactNode;
  renderFile: (entry: DocsFileEntry) => ReactNode;
  onCollapse: () => void;
}) {
  const t = useT();
  const nodes = useMemo(() => directories(files), [files]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [searchCollapsed, setSearchCollapsed] = useState(new Set<string>());
  const [focusedPath, setFocusedPath] = useState<string>();
  const items = useRef(new Map<string, HTMLLIElement>());
  const searching = query.length > 0;
  const closed = searching ? searchCollapsed : collapsed;

  useEffect(() => { setSearchCollapsed(new Set()); }, [query]);
  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = selectedPath.split("/").slice(0, -1).map((_, depth) => selectedPath.split("/").slice(0, depth + 1).join("/"));
    const reveal = (previous: Set<string>) => new Set([...previous].filter(path => !ancestors.includes(path)));
    setCollapsed(reveal);
    setSearchCollapsed(reveal);
  }, [selectedPath]);

  const visible: Array<{ node: FileNodeOrFolder; parent?: string }> = [];
  const collect = (siblings: FileNodeOrFolder[], parent?: string) => {
    for (const node of siblings) {
      visible.push({ node, parent });
      if (node.kind === "folder" && !closed.has(node.path)) collect(node.children, node.path);
    }
  };
  collect(nodes);
  const tabStop = visible.some(({ node }) => node.path === focusedPath) ? focusedPath
    : visible.some(({ node }) => node.path === selectedPath) ? selectedPath : visible[0]?.node.path;
  const focus = (path: string | undefined) => {
    if (path) { setFocusedPath(path); items.current.get(path)?.focus(); }
  };
  const toggle = (node: FolderNode, close = !closed.has(node.path)) => {
    const update = searching ? setSearchCollapsed : setCollapsed;
    update(previous => { const next = new Set(previous); if (close) next.add(node.path); else next.delete(node.path); return next; });
    if (close) onCollapse();
  };
  const navigate = (event: KeyboardEvent<HTMLLIElement>, node: FileNodeOrFolder) => {
    if ((event.target as Element).closest('[role="treeitem"]') !== event.currentTarget || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    if (node.kind === "file" && event.target === event.currentTarget && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      const button = event.currentTarget.querySelector<HTMLButtonElement>("button");
      if (button) {
        const bounds = button.getBoundingClientRect();
        button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bounds.left + 12, clientY: bounds.bottom }));
      }
      return;
    }
    const index = visible.findIndex(row => row.node.path === node.path);
    switch (event.key) {
      case "ArrowDown": focus(visible[index + 1]?.node.path); break;
      case "ArrowUp": focus(visible[index - 1]?.node.path); break;
      case "Home": focus(visible[0]?.node.path); break;
      case "End": focus(visible.at(-1)?.node.path); break;
      case "ArrowRight":
        if (node.kind === "folder") { if (closed.has(node.path)) toggle(node, false); else focus(node.children[0]?.path); }
        break;
      case "ArrowLeft":
        if (node.kind === "folder" && !closed.has(node.path)) toggle(node, true);
        else focus(visible[index]?.parent);
        break;
      case "Enter": case " ":
        if (event.target !== event.currentTarget) return;
        if (node.kind === "folder") toggle(node);
        else event.currentTarget.querySelector<HTMLButtonElement>("button")?.click();
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const render = (siblings: FileNodeOrFolder[], depth = 1): ReactNode => siblings.map((node, index) => {
    const expanded = node.kind === "folder" && !closed.has(node.path);
    return <li key={node.path} className="owb-document-tree__item" role="treeitem" aria-label={node.path}
      aria-level={depth} aria-posinset={index + 1} aria-setsize={siblings.length}
      aria-expanded={node.kind === "folder" ? expanded : undefined}
      aria-selected={node.kind === "file" ? selectedPath === node.path : undefined}
      tabIndex={tabStop === node.path ? 0 : -1}
      ref={element => { if (element) items.current.set(node.path, element); else items.current.delete(node.path); }}
      onFocus={event => { if ((event.target as Element).closest('[role="treeitem"]') === event.currentTarget) setFocusedPath(node.path); }}
      onKeyDown={event => navigate(event, node)}>
      {node.kind === "folder" ? <Tooltip placement="right" trigger={["hover", "focus"]} title={t("docs.folderLocation", { path: node.path })}>
        <button type="button" tabIndex={-1} className="owb-document-tree__folder" aria-expanded={expanded}
          onClick={() => { focus(node.path); toggle(node); }}>
          <ChevronRight className={expanded ? "is-expanded" : undefined} size={13} aria-hidden="true" />
          {expanded ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
          <span>{node.name}</span>
        </button>
      </Tooltip> : renderFile(node.entry)}
      {node.kind === "folder" && expanded ? <ul role="group">{render(node.children, depth + 1)}</ul> : null}
    </li>;
  });
  return <div className="owb-docs-panel__list owb-document-tree" hidden={hidden}>
    {nodes.length ? <ul role="tree" aria-label={t("docs.directoryTree")}>{render(nodes)}</ul> : empty}
  </div>;
}
