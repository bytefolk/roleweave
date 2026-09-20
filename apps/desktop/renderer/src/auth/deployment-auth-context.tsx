import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DeploymentSessionSummary } from "@roleweave/shared";

interface DeploymentAuthContextValue {
  sessions: DeploymentSessionSummary[];
  activeUrl: string | null;
  loading: boolean;
  login(deploymentUrl: string, provider: "local" | "remote", identity: string, token: string, expiresAt?: string | null): Promise<boolean>;
  logout(deploymentUrl: string): Promise<boolean>;
  setActive(url: string | null): void;
  clearAll(): Promise<boolean>;
}

const DeploymentAuthContext = createContext<DeploymentAuthContextValue | null>(null);

const ACTIVE_KEY = "owb:active-deployment-url";

function readActiveUrl(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

function writeActiveUrl(url: string | null): void {
  try {
    if (url) localStorage.setItem(ACTIVE_KEY, url);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* storage unavailable */ }
}

export function DeploymentAuthProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<DeploymentSessionSummary[]>([]);
  const [activeUrl, setActiveUrl] = useState<string | null>(readActiveUrl);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await window.owb.deploymentSession.list();
      if (result.ok) setSessions(result.sessions);
    } catch { /* storage unavailable */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (deploymentUrl: string, provider: "local" | "remote", identity: string, token: string, expiresAt: string | null = null) => {
    const result = await window.owb.deploymentSession.save({ deploymentUrl, provider, accountIdentity: identity, token, expiresAt });
    if (!result.ok) return false;
    await refresh();
    setActiveUrl(deploymentUrl);
    writeActiveUrl(deploymentUrl);
    return true;
  }, [refresh]);

  const logout = useCallback(async (deploymentUrl: string) => {
    const result = await window.owb.deploymentSession.remove(deploymentUrl);
    if (!result.ok) return false;
    if (activeUrl === deploymentUrl) {
      setActiveUrl(null);
      writeActiveUrl(null);
    }
    await refresh();
    return true;
  }, [activeUrl, refresh]);

  const setActive = useCallback((url: string | null) => {
    setActiveUrl(url);
    writeActiveUrl(url);
  }, []);

  const clearAll = useCallback(async () => {
    const result = await window.owb.deploymentSession.clear();
    if (!result.ok) return false;
    setActiveUrl(null);
    writeActiveUrl(null);
    await refresh();
    return true;
  }, [refresh]);

  const value = useMemo<DeploymentAuthContextValue>(() => ({
    sessions, activeUrl, loading, login, logout, setActive, clearAll,
  }), [sessions, activeUrl, loading, login, logout, setActive, clearAll]);

  return <DeploymentAuthContext.Provider value={value}>{children}</DeploymentAuthContext.Provider>;
}

export function useDeploymentAuth(): DeploymentAuthContextValue {
  const ctx = useContext(DeploymentAuthContext);
  if (!ctx) throw new Error("useDeploymentAuth must be used within DeploymentAuthProvider");
  return ctx;
}
