import { useCallback, useEffect, useState } from "react";
import { useT } from "@roleweave/ui";
import type { DocsFileEntry } from "@roleweave/shared";

export interface SpaceFilesState {
  files: DocsFileEntry[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  readFile: (path: string) => Promise<{ content: string; version: string }>;
  writeFile: ((path: string, content: string, expectedVersion: string) => Promise<{ version: string }>) | undefined;
}

/**
 * Loads the files of one space folder.
 *
 * A space is identified by the position whose package directory holds it, so
 * the existing position-docs IPC is reused unchanged. Writes are optional so
 * the module degrades to read-only when the bridge lacks them.
 */
export function useSpaceFiles(positionId: string | null, workspaceOpen: boolean): SpaceFilesState {
  const t = useT();
  const [files, setFiles] = useState<DocsFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!workspaceOpen || !positionId) {
      setFiles([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void window.owb
      .positionDocs(positionId)
      .then((res) => {
        if (!alive) return;
        if (res.status >= 400 || !res.body) {
          setError(t("space.error.read", { path: positionId }));
          setFiles([]);
          return;
        }
        setFiles(res.body.files);
      })
      .catch(() => {
        if (alive) setError(t("space.error.read", { path: positionId }));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [positionId, workspaceOpen, reloadToken, t]);

  const readFile = useCallback(
    async (path: string): Promise<{ content: string; version: string }> => {
      if (!positionId) throw new Error(t("space.error.read", { path }));
      const res = await window.owb.positionDocFile(positionId, path);
      if (res.status >= 400 || !res.body) throw new Error(t("space.error.read", { path }));
      return { content: res.body.content, version: res.body.version };
    },
    [positionId, t],
  );

  const writeFile = useCallback(
    async (path: string, content: string, expectedVersion: string): Promise<{ version: string }> => {
      const write = window.owb.writePositionDoc;
      if (!positionId || !write) throw new Error(t("space.error.write", { path }));
      const res = await write({ positionId, path, content, expectedVersion });
      if (res.status >= 400 || !res.body) throw new Error(t("space.error.write", { path }));
      return { version: res.body.version };
    },
    [positionId, t],
  );

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return {
    files,
    loading,
    error,
    reload,
    readFile,
    writeFile: window.owb.writePositionDoc ? writeFile : undefined,
  };
}
