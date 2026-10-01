/**
 * The three window-control buttons of the 40px custom title bar (#73). The
 * window is frameless, so these are the only way to close, minimize, or
 * maximize it — #94 and #248 exist because that affordance is not decorative.
 *
 * Extracted out of `App.tsx` for #519: the first-run splash and the
 * login/register card also run inside the frameless window, but `<App />` is
 * deliberately not mounted yet at that point. Keeping the buttons inside App
 * would have left the user with a window they could neither drag nor close
 * during the splash and while the login card is up. Sharing the component is
 * the point — a second copy would drift out of the #94 / #248 guards in
 * window-controls-affordance.test.cjs, which read the built bundle by class
 * name and would keep passing while the copy they never see rots.
 */
import { useT } from "@roleweave/ui";

export function WindowControls() {
  const t = useT();
  return (
    <span className="owb-wintitle__controls">
      <button
        type="button"
        className="owb-wctl owb-wctl--close"
        aria-label={t("win.close")}
        title={t("win.closeTitle")}
        onClick={() => void window.owb.windowClose?.()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
        </svg>
      </button>
      <button
        type="button"
        className="owb-wctl owb-wctl--min"
        aria-label={t("win.minimize")}
        title={t("win.minimizeTitle")}
        onClick={() => void window.owb.windowMinimize?.()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.2 5h5.6" />
        </svg>
      </button>
      {/* The label stays static on purpose: `isMaximized()` is not trustworthy
          under WSLg, and the button must not report a state it cannot know. */}
      <button
        type="button"
        className="owb-wctl owb-wctl--max"
        aria-label={t("win.maximize")}
        title={t("win.maximizeTitle")}
        onClick={() => void window.owb.windowToggleMaximize?.()}
      >
        {/* #248: fullscreen is a green disc with a struck-through glyph. */}
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.8 7.2L7.2 2.8" />
        </svg>
      </button>
    </span>
  );
}
