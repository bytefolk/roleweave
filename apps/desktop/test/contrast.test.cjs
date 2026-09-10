// #77 review item 3: --ui-foreground-subtle is used for 9-11px text (not
// "large text" under WCAG — the 3:1 exception does not apply), so it must
// clear the 4.5:1 AA threshold against every surface it can render on, in
// both themes. This is a real WCAG contrast computation against the source
// skin file, not a token-string presence check — it would have caught the
// original #85887c / #7e8176 regression.
//
// Reads apps/desktop/renderer/src/antd-skin.css directly rather than the
// built bundle: that file is org-workbench's own single skin surface (ADR-
// 0002), so its `:root, [data-theme="light"]` / `[data-theme="dark"]` blocks
// are unambiguous — unlike the built bundle, which also contains
// design-system's own same-selector defaults ahead of this file's overrides
// and would require re-deriving cascade order to find the right block.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function relativeLuminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA.replace("#", ""));
  const b = relativeLuminance(hexB.replace("#", ""));
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenValue(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `expected ${name} as a hex value in block`);
  return match[1];
}

const SURFACE_TOKENS = ["--ui-surface", "--ui-surface-raised", "--ui-surface-inset", "--ui-canvas", "--ui-canvas-subtle"];
const AA_NORMAL_TEXT = 4.5;

test("--ui-foreground-subtle clears WCAG AA (4.5:1) against every surface, both themes", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "src", "antd-skin.css"),
    "utf8",
  );

  const lightBlock = css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="dark"]'));
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'));

  for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
    const subtle = tokenValue(block, "--ui-foreground-subtle");
    for (const surfaceToken of SURFACE_TOKENS) {
      const surface = tokenValue(block, surfaceToken);
      const ratio = contrastRatio(subtle, surface);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${theme} foreground-subtle ${subtle} on ${surfaceToken} ${surface} is ${ratio.toFixed(2)}:1, below AA 4.5:1`,
      );
    }
  }
});

test("solid controls keep readable foregrounds in normal and hover states, both themes", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "src", "antd-skin.css"), "utf8");
  const darkStart = css.indexOf('[data-theme="dark"]');
  const blocks = [["light", css.slice(css.indexOf(':root,'), darkStart)], ["dark", css.slice(darkStart)]];
  for (const [theme, block] of blocks) {
    for (const [role, hover] of [["primary", "hover"], ["ai", "hover"], ["success", "strong"], ["warning", "strong"], ["danger", "strong"]]) {
      const foreground = tokenValue(block, `--ui-${role}-foreground`);
      for (const backgroundToken of [`--ui-${role}`, `--ui-${role}-${hover}`]) {
        const background = tokenValue(block, backgroundToken);
        const ratio = contrastRatio(foreground, background);
        assert.ok(ratio >= AA_NORMAL_TEXT,
          `${theme} ${role} foreground ${foreground} on ${backgroundToken} ${background} is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
      }
    }
  }
});
