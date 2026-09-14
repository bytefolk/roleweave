// #77 review item 3: --ui-foreground-subtle is used for 9-11px text (not
// "large text" under WCAG — the 3:1 exception does not apply), so it must
// clear the 4.5:1 AA threshold against every surface it can render on, in
// both themes. This is a real WCAG contrast computation against the shipped
// tokens, not a token-string presence check — it would have caught the
// original #85887c / #7e8176 regression.
//
// #248 moved the palette out of antd-skin.css into @fullstack-ai-infra/ui's
// profile blocks, so this audit now reads them — through the package's
// exports map, i.e. the exact CSS the renderer bundles. The audited profile
// is `mint`: resolveThemeProfile() seeds it as RoleWeave's default, so it is
// the palette the app ships. The `default` profile is the upstream Ant
// Design palette kept as an opt-in; its contrast is upstream's to own.
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

// The mint profile ships as one comma-joined light rule and one dark rule.
// Pull each rule's declaration block out by selector, brace-matched, so the
// audit reads the same values the renderer resolves at runtime.
function mintBlock(css, theme) {
  const selector = `[data-ui-theme=mint][data-theme=${theme}]`;
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `mint ${theme} block missing from the design-system stylesheet`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  assert.fail(`unbalanced braces in the mint ${theme} block`);
}

function mintBlocks() {
  const css = fs.readFileSync(require.resolve("@fullstack-ai-infra/ui/styles.css"), "utf8");
  return [["light", mintBlock(css, "light")], ["dark", mintBlock(css, "dark")]];
}

const SURFACE_TOKENS = ["--ui-surface", "--ui-surface-raised", "--ui-surface-inset", "--ui-canvas", "--ui-canvas-subtle"];
const AA_NORMAL_TEXT = 4.5;

test("--ui-foreground-subtle clears WCAG AA (4.5:1) against every surface, both themes", () => {
  for (const [theme, block] of mintBlocks()) {
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

// antd-skin.css no longer carries palette values (#248); it aliases the three
// state-control foregrounds to the profile's primary foreground. Pin that
// glue, then audit the resolved pairs, so the readable-foreground promise
// survives the palette's move to the design system.
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

  for (const [theme, block] of mintBlocks()) {
    const primaryForeground = tokenValue(block, "--ui-primary-foreground");
    const foregrounds = {
      primary: primaryForeground,
      ai: tokenValue(block, "--ui-ai-foreground"),
      success: primaryForeground,
      warning: primaryForeground,
      danger: primaryForeground,
    };
    for (const [role, second] of [["primary", "hover"], ["ai", "hover"], ["success", "strong"], ["warning", "strong"], ["danger", "strong"]]) {
      const foreground = foregrounds[role];
      for (const backgroundToken of [`--ui-${role}`, `--ui-${role}-${second}`]) {
        const background = tokenValue(block, backgroundToken);
        const ratio = contrastRatio(foreground, background);
        assert.ok(ratio >= AA_NORMAL_TEXT,
          `${theme} ${role} foreground ${foreground} on ${backgroundToken} ${background} is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
      }
    }
  }
});
