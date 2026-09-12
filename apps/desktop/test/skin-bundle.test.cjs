// #50 regression: a stray `*/` inside the antd-skin.css header comment closed
// the comment early, and the CSS parser dropped the whole light-theme :root
// token block (caught by CDP computed-value audit, invisible to static
// checks). Assert the skin token values survive parsing in the built renderer
// bundle.
// This guard fired again during #73 — the header comment mentioned
// `--ui-duration-*/--ui-ease`, whose `*/` re-closed the comment and dropped
// the block a second time. Keep variable names out of prose, or write them
// without the glob.
//
// #248 moved the palette into @fullstack-ai-infra/ui's profile blocks, so the
// guard now pins those instead of the old inline antd-skin palette: every hex
// token the mint profile declares must arrive in the built bundle, in both
// themes. Mint is the seeded default profile (resolveThemeProfile()). The
// RoleWeave-owned alias block from antd-skin.css rides the same pipeline and
// is pinned the same way.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function builtCss() {
  const assetsDir = path.join(__dirname, "..", "dist", "renderer", "assets");
  const cssFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".css"));
  assert.ok(cssFiles.length > 0, "renderer build must emit css assets");
  return cssFiles
    .map((file) => fs.readFileSync(path.join(assetsDir, file), "utf8"))
    .join("\n");
}

// Minifiers strip whitespace and quotes and may shorten #aabbcc to #abc, so
// compare with all of that normalized away rather than pinning the source
// formatting.
function normalize(text) {
  return text.toLowerCase().replace(/["']/g, "").replace(/\s+/g, "");
}

function expandHex(value) {
  return value.length === 4
    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    : value;
}

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

function hexDeclarations(block) {
  return [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(
    (match) => [match[1], match[2].toLowerCase()],
  );
}

test("renderer bundle keeps the skin token blocks (#50, #73, #248)", () => {
  const bundle = normalize(builtCss());
  const skin = fs.readFileSync(
    require.resolve("@fullstack-ai-infra/ui/styles.css"),
    "utf8",
  );

  for (const theme of ["light", "dark"]) {
    const selector = `[data-ui-theme=mint][data-theme=${theme}]`;
    assert.ok(
      bundle.includes(normalize(selector)),
      `mint ${theme} block selector must survive CSS parsing`,
    );
    const declarations = hexDeclarations(mintBlock(skin, theme));
    assert.ok(declarations.length > 0, `mint ${theme} block must declare hex tokens`);
    for (const [name, value] of declarations) {
      assert.ok(
        bundle.includes(`${name}:${expandHex(value)}`),
        `mint ${theme} token ${name}: ${value} must survive CSS parsing`,
      );
    }
  }

  // The antd-skin.css alias block is RoleWeave's glue to those tokens; #73
  // dropped exactly this kind of block once.
  for (const alias of [
    "--ui-brand:var(--ui-primary)",
    "--owb-font-display:var(--ui-font-sans)",
    "--owb-duration-mid:var(--ui-duration-normal)",
  ]) {
    assert.ok(
      bundle.includes(normalize(alias)),
      `${alias} must survive CSS parsing`,
    );
  }
});
