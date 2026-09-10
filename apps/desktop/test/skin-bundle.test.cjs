// #50 regression: a stray `*/` inside the antd-skin.css header comment closed the
// comment early, and the CSS parser dropped the whole light-theme :root token block
// (caught by CDP computed-value audit, invisible to static checks). Assert the
// skin token values survive parsing in the built renderer bundle.
//
// Both themes use the RoleWeave purple / blue brand palette.
// This guard fired again during #73 — the header comment mentioned
// `--ui-duration-*/--ui-ease`, whose `*/` re-closed the comment and dropped the
// block a second time. Keep variable names out of prose, or write them without
// the glob.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("renderer bundle keeps the light and dark skin token blocks (#50, #73)", () => {
  const assetsDir = path.join(__dirname, "..", "dist", "renderer", "assets");
  const cssFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".css"));
  assert.ok(cssFiles.length > 0, "renderer build must emit css assets");
  const css = cssFiles
    .map((file) => fs.readFileSync(path.join(assetsDir, file), "utf8"))
    .join("\n");

  // Light theme: cool paper surfaces / purple identity / readable blue actions.
  assert.ok(/--ui-canvas:\s*#f7f8fb/.test(css), "neutral canvas token must survive CSS parsing");
  assert.ok(/--ui-navigation:\s*#f1f3f7/.test(css), "sidebar tier token must survive CSS parsing");
  assert.ok(/--ui-primary:\s*#3e63dd/.test(css), "blue action token must survive CSS parsing");
  // Muted health states (control-plane 设计稿, not the antd bright palette).
  assert.ok(/--ui-success:\s*#2e7052/.test(css), "muted success token must survive CSS parsing");
  // Three-tier motion + the display font token added by #73.
  assert.ok(
    /--owb-duration-mid:\s*(160ms|\.16s)/.test(css),
    "motion three-tier tokens must survive CSS parsing",
  );
  assert.ok(/--ui-font-sans:\s*-apple-system/.test(css), "system font token must survive CSS parsing");
  assert.ok(/--owb-font-display:\s*var\(--ui-font-sans\)/.test(css), "light display font token must survive CSS parsing");

  // Dark theme block must survive the same parsing path.
  assert.ok(/--ui-canvas:\s*#14151b/.test(css), "dark canvas token must survive CSS parsing");
  assert.ok(/--ui-primary:\s*#86a0ff/.test(css), "dark blue action must survive CSS parsing");
  assert.ok(/--ui-brand:\s*#732fd1/.test(css), "light purple identity must survive CSS parsing");
  assert.ok(/--ui-brand:\s*#bb93f6/.test(css), "dark purple identity must survive CSS parsing");
});
