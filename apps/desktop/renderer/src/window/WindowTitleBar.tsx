import { useEffect, useRef } from "react";
import { useT } from "@roleweave/ui";
import type { OwbBridge } from "../owb";

type Platform = "win32" | "darwin" | "linux" | "other";

/** The desktop shell owns the UI platform, independently of its Agent backend. */
export function resolveWindowChrome(bridge: Partial<OwbBridge> | undefined, browserPlatform: string, userAgent: string) {
  const info = bridge?.windowChrome;
  if (info && ["win32", "darwin", "linux", "other"].includes(info.platform)) {
    return { platform: info.platform, nativeControls: info.platform === "win32" && info.nativeControls === true };
  }
  const hint = `${browserPlatform} ${userAgent}`;
  const platform: Platform = /Windows|Win32|Win64/i.test(hint) ? "win32"
    : /Macintosh|MacIntel|MacPPC|Mac OS X/i.test(hint) ? "darwin"
      : /Linux|X11/i.test(hint) ? "linux" : "other";
  return { platform, nativeControls: false };
}

function windowChromeColor(value: string): string | null {
  if (/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value)) return value;
  if (value === "transparent") return "#00000000";
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some(value => !Number.isFinite(value) || value < 0 || value > 255)) return null;
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return `#${channels.map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}${alpha === 1 ? "" : Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

function WindowControls({ mac }: { mac: boolean }) {
  const t = useT();
  const close = <button key="close" type="button" className="owb-wctl owb-wctl--close"
    aria-label={t("win.close")} title={t("win.closeTitle")} onClick={() => void window.owb?.windowClose?.()}>
    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /></svg>
  </button>;
  const minimize = <button key="minimize" type="button" className="owb-wctl owb-wctl--min"
    aria-label={t("win.minimize")} title={t("win.minimizeTitle")} onClick={() => void window.owb?.windowMinimize?.()}>
    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.2 5h5.6" /></svg>
  </button>;
  const maximize = <button key="maximize" type="button" className="owb-wctl owb-wctl--max"
    aria-label={t("win.maximize")} title={t("win.maximizeTitle")} onClick={() => void window.owb?.windowToggleMaximize?.()}>
    <svg viewBox="0 0 10 10" aria-hidden="true">{mac
      ? <path d="M2.8 7.2L7.2 2.8" />
      : <path d="M2 2h6v6H2z" />}</svg>
  </button>;
  return <span className={`owb-wintitle__controls owb-wintitle__controls--${mac ? "mac" : "standard"}`}
    onDoubleClick={event => event.stopPropagation()}>
    {mac ? [close, minimize, maximize] : [minimize, maximize, close]}
  </span>;
}

export function WindowTitleBar() {
  const header = useRef<HTMLElement>(null);
  const chrome = resolveWindowChrome(window.owb, navigator.platform, navigator.userAgent);
  const mac = chrome.platform === "darwin";
  const setColors = window.owb?.setWindowChromeColors;

  useEffect(() => {
    if (!chrome.nativeControls || !setColors) return;
    let pendingFrame = 0;
    let lastColors = "";
    const syncColors = () => {
      pendingFrame = 0;
      const element = header.current;
      const name = element?.querySelector<HTMLElement>(".owb-wintitle__name");
      if (!element || !name) return;
      const color = windowChromeColor(getComputedStyle(element).backgroundColor);
      const symbolColor = windowChromeColor(getComputedStyle(name).color);
      if (!color || !symbolColor || `${color}:${symbolColor}` === lastColors) return;
      lastColors = `${color}:${symbolColor}`;
      void setColors({ color, symbolColor }).catch(() => { lastColors = ""; });
    };
    const schedule = () => { if (!pendingFrame) pendingFrame = requestAnimationFrame(syncColors); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-ui-theme", "style"] });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    window.addEventListener("resize", schedule);
    syncColors();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
    };
  }, [chrome.nativeControls, setColors]);

  return <header ref={header} className={`owb-wintitle owb-wintitle--${mac ? "mac" : chrome.nativeControls ? "native-windows" : "standard"}`}
    data-window-platform={chrome.platform}
    onDoubleClick={() => { if (!chrome.nativeControls) void window.owb?.windowToggleMaximize?.(); }}>
    <div className="owb-wintitle__content">
      {mac && <WindowControls mac />}
      <span className="owb-wintitle__name">RoleWeave</span>
      <span className="owb-wintitle__spacer" />
      {!mac && !chrome.nativeControls && <WindowControls mac={false} />}
    </div>
  </header>;
}
