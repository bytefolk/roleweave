import fs from "node:fs/promises";
import path from "node:path";
import type { ContextSourceSummary, OrgRole } from "@roleweave/shared";
import { POSITIONS_DIR } from "./workspace-state.js";

const CONTEXT_EXPORT_ROOT = [".digital-employee", "workbench", "context-exports"] as const;

/**
 * Build the source inventory shown on a position record.
 *
 * This intentionally inspects only workspace-owned metadata and environment
 * presence. It does not open mem storage or a context vault, and it never
 * returns absolute paths or credentials to the renderer.
 */
export async function buildContextSources(
  workspaceDir: string,
  role: OrgRole,
): Promise<ContextSourceSummary[]> {
  const positionDir = resolvePositionPackageDir(workspaceDir, role);
  let documentCount = 0;
  let documentsReadable = true;
  try {
    documentCount = await countContextFiles(positionDir);
  } catch {
    documentsReadable = false;
  }

  const memConfigured = nonEmptyEnv("MEM_URL") || nonEmptyEnv("ORG_WORKBENCH_MEM_URL");
  const contextConfigured = nonEmptyEnv("CONTEXT_VAULT") && nonEmptyEnv("CONTEXT_RUNTIME_TOKEN");
  const contextExportCount = await countContextExports(workspaceDir, role.id);

  return [
    {
      id: "workspace-position-docs",
      kind: "workspace_docs",
      name: "岗位知识库",
      locator: `positions/${positionRelativePath(workspaceDir, positionDir)}/SKILL.md + knowledge/**`,
      binding: "bound",
      state: !documentsReadable ? "error" : documentCount > 0 ? "ready" : "empty",
      readOnly: true,
      itemCount: documentCount,
    },
    {
      id: "mem-drive",
      kind: "mem_drive",
      name: "统一网盘",
      locator: "mem://workspace",
      // The current drive proxy is workspace-wide; until a position path grant
      // is wired, show it as a source that can be bound rather than claiming
      // that every file in mem is already visible to this position.
      binding: "available",
      state: memConfigured ? "ready" : "not_configured",
      readOnly: true,
    },
    {
      id: "context-provider",
      kind: "context_provider",
      name: "岗位运行上下文",
      locator: `context://position/${role.id}`,
      // Workbench exports completed session turns with this exact position
      // scope; the runtime state below distinguishes configured from absent.
      binding: "bound",
      state: contextConfigured ? "ready" : "not_configured",
      readOnly: true,
      ...(contextExportCount > 0 ? { itemCount: contextExportCount } : {}),
    },
  ];
}

function nonEmptyEnv(name: string): boolean {
  return (process.env[name] ?? "").trim() !== "";
}

/**
 * Resolve the bound package inside this workspace's positions root.
 *
 * Applied organization files normally carry an absolute localReference. The
 * checked-in example workspace uses `/workspace/...` as a portable absolute
 * reference, though, so when that reference belongs to a different checkout
 * we rebase its path suffix after `positions/` onto the opened workspace.
 * Anything that still cannot be proven to stay inside positions/ falls back
 * to the legacy flat position path.
 */
export function resolvePositionPackageDir(workspaceDir: string, role: OrgRole): string {
  const positionsRoot = path.resolve(workspaceDir, POSITIONS_DIR);
  const rawReference = role.package.localReference;
  const candidate = path.isAbsolute(rawReference)
    ? path.resolve(rawReference)
    : path.resolve(workspaceDir, rawReference);
  const relative = path.relative(positionsRoot, candidate);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return candidate;
  }

  // Portable fixtures may retain an absolute reference rooted at another
  // checkout. Preserve only the path after a literal `positions` segment.
  const referenceSegments = path.resolve(rawReference).split(path.sep);
  const positionsIndex = referenceSegments.lastIndexOf(POSITIONS_DIR);
  if (positionsIndex >= 0 && positionsIndex < referenceSegments.length - 1) {
    const rebased = path.resolve(positionsRoot, ...referenceSegments.slice(positionsIndex + 1));
    const rebasedRelative = path.relative(positionsRoot, rebased);
    if (rebasedRelative !== "" && !rebasedRelative.startsWith("..") && !path.isAbsolute(rebasedRelative)) {
      return rebased;
    }
  }

  return path.join(positionsRoot, role.id);
}

function positionRelativePath(workspaceDir: string, positionDir: string): string {
  const relative = path.relative(path.resolve(workspaceDir, POSITIONS_DIR), positionDir);
  return relative.split(path.sep).join("/") || "—";
}

async function countContextFiles(dir: string, relativeDir = ""): Promise<number> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      count += await countContextFiles(absolute, path.posix.join(relativeDir, entry.name));
    } else if (entry.isFile() && isContextFile(path.posix.join(relativeDir, entry.name))) {
      count += 1;
    }
  }
  return count;
}
function isContextFile(relativePath: string): boolean {
  return relativePath === "SKILL.md" || relativePath.startsWith("knowledge/");
}

/** Count only Workbench-owned export state files for this position. */
async function countContextExports(workspaceDir: string, positionId: string): Promise<number> {
  const root = path.resolve(workspaceDir, ...CONTEXT_EXPORT_ROOT);
  let sessions;
  try {
    sessions = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0;
  }
  let count = 0;
  for (const session of sessions) {
    if (!session.isDirectory() || session.isSymbolicLink() || session.name.startsWith(".")) continue;
    let files;
    try {
      files = await fs.readdir(path.join(root, session.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(root, session.name, file.name), "utf8");
        const state = JSON.parse(raw) as { positionId?: unknown };
        if (state.positionId === positionId) count += 1;
      } catch {
        // A malformed export is not allowed to break the position card.
      }
    }
  }
  return count;
}
