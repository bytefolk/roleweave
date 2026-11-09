// #94: the composer's send/cancel button (`.owb-turn-composer__surface > button`)
// used `opacity: 0.45` for its disabled state on top of an already-saturated
// brand background (white icon on `--ui-ai` #722ed1 in light mode). Dimming
// both the icon and the background toward the same backdrop collapses them
// toward each other rather than toward invisibility evenly: measured ~2.2:1
// (white icon over the ~45%-blended purple against the composer's own
// backdrop), under the 3:1 WCAG floor for a UI icon — reported directly as
// "看不清标志了" (can't make out the icon).
//
// Fixed by swapping to `--ui-surface-raised` / `--ui-foreground-subtle`: the
// exact pair `contrast.test.cjs` already holds to >=4.5:1 on every surface
// tier in both themes (it iterates `--ui-surface-raised` as one of its five
// SURFACE_TOKENS). This test does not re-derive that contrast math — it
// pins that the composer's disabled rule actually *uses* the audited pair,
// and that the opacity trick that caused the regression does not return.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function builtCss() {
  const assetsDir = path.join(__dirname, "..", "dist", "renderer", "assets");
  const cssFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".css"));
  assert.ok(cssFiles.length > 0, "renderer build must emit css assets");
  return cssFiles.map((file) => fs.readFileSync(path.join(assetsDir, file), "utf8")).join("\n");
}

test("composer send/cancel button stays legible when disabled (#94)", () => {
  const css = builtCss();

  const rule = /\.owb-turn-composer__surface>button:disabled\{([^}]*)\}/.exec(css);
  assert.ok(rule !== null, ".owb-turn-composer__surface > button:disabled rule must exist");
  const body = rule[1];

  assert.ok(
    !/opacity\s*:/.test(body),
    `disabled state must not dim via opacity — it collapses the icon/background contrast toward each other instead of toward the page; got "${body}"`,
  );
  assert.ok(
    /background\s*:\s*var\(--ui-surface-raised\)/.test(body),
    `disabled background must be the audited --ui-surface-raised token; got "${body}"`,
  );
  assert.ok(
    /color\s*:\s*var\(--ui-foreground-subtle\)/.test(body),
    `disabled icon color must be the audited --ui-foreground-subtle token; got "${body}"`,
  );
});
