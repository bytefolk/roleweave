import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@roleweave/ui";
import type { NoticeAction } from "../DiagnosticNotice";
import type { TurnEngine } from "./types";

/** External clients can start or sign in while RoleWeave is in the background.
 * Re-read availability on return instead of keeping the initial failure cached. */
export function useLocalConnectionRecovery(engine: TurnEngine | null, ready: boolean, recheck: () => Promise<void>) {
  const t = useT();
  const [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const openingRequest = useRef(false);
  const latestRecheck = useRef(recheck);
  latestRecheck.current = recheck;
  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await latestRecheck.current(); } catch { /* The normal recheck surface owns errors. */ }
    finally { inFlight.current = false; }
  }, []);

  useEffect(() => {
    setOpening(false); setWaiting(false); setFeedback(null);
    openingRequest.current = false;
    return () => { generation.current++; };
  }, [engine]);

  useEffect(() => {
    if (engine !== "qoder" && engine !== "qwen-office-local") return;
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [engine, check]);

  useEffect(() => {
    if (ready) { setWaiting(false); setFeedback(null); }
  }, [ready, waiting]);

  useEffect(() => {
    if (!waiting || ready) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => {
      alive = false;
      clearTimeout(timer);
      setWaiting(false); setFeedback(t("office.connectPending"));
    }, 45_000);
    const tick = async () => {
      await check();
      if (!alive) return;
      timer = setTimeout(() => { void tick(); }, 2500);
    };
    timer = setTimeout(() => { void tick(); }, 1500);
    return () => { alive = false; clearTimeout(timer); clearTimeout(deadline); };
  }, [waiting, ready, check, t]);

  const open = async () => {
    if (openingRequest.current || waiting) return;
    openingRequest.current = true;
    const version = generation.current;
    setOpening(true); setFeedback(null);
    try {
      const result = await window.owb.openQwenOffice?.();
      if (version !== generation.current) return;
      if (result?.opened) setWaiting(true);
      else setFeedback(t("office.openFailed"));
    } catch {
      if (version === generation.current) setFeedback(t("office.openFailed"));
    } finally {
      if (version === generation.current) { openingRequest.current = false; setOpening(false); }
    }
  };
  const action: NoticeAction | undefined = engine === "qwen-office-local" && !ready
    && window.owb.windowChrome?.platform === "win32" && window.owb.openQwenOffice
    ? { label: t(opening || waiting ? "office.connecting" : "office.openClient"), busy: opening || waiting, onClick: open }
    : undefined;
  return { action, feedback };
}
