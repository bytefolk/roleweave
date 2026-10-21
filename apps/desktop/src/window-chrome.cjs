const { isTrustedWindowSender } = require("./window-ipc.cjs");

const WINDOW_TITLEBAR_HEIGHT = 40;
const HEX_COLOR = /^#[\da-f]{6}(?:[\da-f]{2})?$/i;

/** UI platform belongs to Electron, independently of the Agent/backend host. */
function windowChromeInfo(platform) {
  return {
    platform: ["win32", "darwin", "linux"].includes(platform) ? platform : "other",
    nativeControls: platform === "win32",
  };
}

function windowChromeOptions(platform, dark = false) {
  if (platform !== "win32") return { frame: false };
  return {
    // hidden preserves Windows caption semantics while letting the renderer
    // paint the title bar. The overlay owns maximize/restore and Snap hit tests.
    frame: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      height: WINDOW_TITLEBAR_HEIGHT,
      color: dark ? "#14151b" : "#f7f8fb",
      symbolColor: dark ? "#e8e9ed" : "#202127",
    },
  };
}

function validateWindowChromeColors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "color,symbolColor"
    || typeof value.color !== "string" || !HEX_COLOR.test(value.color)
    || typeof value.symbolColor !== "string" || !HEX_COLOR.test(value.symbolColor)) return null;
  return { color: value.color, symbolColor: value.symbolColor };
}

function setWindowChromeColors({ event, browserWindow, trustedRendererUrl, platform, nativeControls, request }) {
  if (platform !== "win32" || nativeControls !== true) return { ok: false };
  const colors = validateWindowChromeColors(request);
  if (!colors) return { ok: false };
  try {
    if (!isTrustedWindowSender(event, browserWindow, trustedRendererUrl)
      || browserWindow.isDestroyed?.() || typeof browserWindow.setTitleBarOverlay !== "function") return { ok: false };
    browserWindow.setTitleBarOverlay({ ...colors, height: WINDOW_TITLEBAR_HEIGHT });
    return { ok: true };
  } catch {
    // A closing window is not an authorization to act on its replacement.
    return { ok: false };
  }
}

module.exports = { WINDOW_TITLEBAR_HEIGHT, windowChromeInfo, windowChromeOptions, validateWindowChromeColors, setWindowChromeColors };
