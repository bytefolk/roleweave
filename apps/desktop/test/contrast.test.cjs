// #77 review item 3: --ui-foreground-subtle is used for 9-11px text (not
// "large text" under WCAG — the 3:1 exception does not apply), so it must
// clear the 4.5:1 AA threshold against every surface it can render on, in
// both themes. This is a real WCAG contrast computation against the shipped
// tokens, not a token-string presence check — it would have caught the
// original #85887c / #7e8176 regression.
//
// Mint inherits the shared light/dark token map from
// @fullstack-ai-infra/ui, then applies the RoleWeave-owned overlay in
// antd-skin.css. Resolve that actual cascade here: the package stylesheet
// intentionally has no product profile blocks. `mint` is seeded as the
// RoleWeave default, while `default` remains the opt-in upstream palette.
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

function tokenValues(...blocks) {
  const values = new Map();
  for (const block of blocks) {
    for (const match of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

function tokenValue(values, name) {
  const value = values.get(name);
  assert.ok(value, `expected ${name} as a hex value in the resolved mint tokens`);
  return value;
}

// CSS source formatting varies between authored CSS and the minified bundle:
// values may be quoted, unquoted, separated by CRLF, or adjacent. Locate the
// actual selector rather than assuming one serialization.
function declarationBlock(css, selector, label) {
  const match = selector.exec(css);
  assert.ok(match, `${label} block missing from stylesheet`);
  const open = css.indexOf("{", match.index);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  assert.fail(`unbalanced braces in the ${label} block`);
}

function themeBlock(css, theme) {
  return declarationBlock(
    css,
    new RegExp(`\\[\\s*data-theme\\s*=\\s*(?:["']${theme}["']|${theme})\\s*\\]\\s*\\{`),
    `${theme} shared token`,
  );
}

function mintOverlayBlock(css, theme) {
  return declarationBlock(
    css,
    new RegExp(
      `\\[\\s*data-ui-theme\\s*=\\s*(?:["']mint["']|mint)\\s*\\]\\s*` +
      `\\[\\s*data-theme\\s*=\\s*(?:["']${theme}["']|${theme})\\s*\\]\\s*\\{`,
    ),
    `mint ${theme} overlay`,
  );
}

function mintBlocks() {
  const shared = fs.readFileSync(require.resolve("@fullstack-ai-infra/ui/styles.css"), "utf8");
  const skin = fs.readFileSync(path.join(__dirname, "..", "renderer", "src", "antd-skin.css"), "utf8");
  return ["light", "dark"].map((theme) => [
    theme,
    tokenValues(themeBlock(shared, theme), mintOverlayBlock(skin, theme)),
  ]);
}

const SURFACE_TOKENS = ["--ui-surface", "--ui-surface-raised", "--ui-surface-inset", "--ui-canvas", "--ui-canvas-subtle"];
const AA_NORMAL_TEXT = 4.5;

test("--ui-foreground-subtle clears WCAG AA (4.5:1) against every surface, both themes", () => {
  for (const [theme, tokens] of mintBlocks()) {
    const subtle = tokenValue(tokens, "--ui-foreground-subtle");
    for (const surfaceToken of SURFACE_TOKENS) {
      const surface = tokenValue(tokens, surfaceToken);
      const ratio = contrastRatio(subtle, surface);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${theme} foreground-subtle ${subtle} on ${surfaceToken} ${surface} is ${ratio.toFixed(2)}:1, below AA 4.5:1`,
      );
    }
  }
});

// antd-skin.css aliases the three state-control foregrounds to the profile's
// primary foreground. Pin that glue, then audit the resolved pairs so the
// readable-foreground promise covers both the shared map and mint overlay.
test("solid controls keep readable foregrounds in normal and hover states, both themes", () => {
  const aliases = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "src", "antd-skin.css"),
    "utf8",
  );
  for (const role of ["success", "warning", "danger"]) {
    assert.ok(
      new RegExp(`--ui-${role}-foreground:\\s*var\\(--ui-primary-foreground\\)`).test(aliases),
      `antd-skin.css must keep --ui-${role}-foreground aliased to --ui-primary-foreground`,
    );
  }

  for (const [theme, tokens] of mintBlocks()) {
    const primaryForeground = tokenValue(tokens, "--ui-primary-foreground");
    const foregrounds = {
      primary: primaryForeground,
      ai: tokenValue(tokens, "--ui-ai-foreground"),
      success: primaryForeground,
      warning: primaryForeground,
      danger: primaryForeground,
    };
    for (const [role, second] of [["primary", "hover"], ["ai", "hover"], ["success", "strong"], ["warning", "strong"], ["danger", "strong"]]) {
      const foreground = foregrounds[role];
      for (const backgroundToken of [`--ui-${role}`, `--ui-${role}-${second}`]) {
        const background = tokenValue(tokens, backgroundToken);
        const ratio = contrastRatio(foreground, background);
        assert.ok(ratio >= AA_NORMAL_TEXT,
          `${theme} ${role} foreground ${foreground} on ${backgroundToken} ${background} is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
      }
    }
  }
});
