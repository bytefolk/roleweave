/** The apply response and org.updated carry the same workspace/version. Keep
 * their shared promise after completion as SSE can arrive on either side of
 * the response. Missing metadata must never suppress an unrelated update. */
export function createOrgRefreshCoordinator() {
  const refreshes = new Map<string, Promise<void>>();
  return {
    clear: () => refreshes.clear(),
    run(workspace: unknown, version: unknown, refresh: () => Promise<void>): Promise<void> {
      const stamp = version as { seq?: unknown; updatedAt?: unknown } | null;
      if (typeof workspace !== "string" || typeof stamp?.seq !== "number" || typeof stamp.updatedAt !== "string") {
        return refresh();
      }
      const key = JSON.stringify([workspace, stamp.seq, stamp.updatedAt]);
      const existing = refreshes.get(key);
      if (existing) return existing;
      const request = Promise.resolve().then(refresh);
      refreshes.set(key, request);
      // Bound retained, completed mutations; failed reads may be retried.
      void request.then(() => {
        if (refreshes.size > 32) refreshes.delete(refreshes.keys().next().value!);
      }, () => {
        if (refreshes.get(key) === request) refreshes.delete(key);
      });
      return request;
    },
  };
}

export function onlyMovesAndReorders(changes: unknown): boolean {
  return Array.isArray(changes) && changes.length > 0 && changes.every((change: unknown) => {
    const op = (change as { op?: unknown } | null)?.op;
    return op === "move" || op === "reorder";
  });
}
