// The first-run surface draws the product icon itself, not a near-enough
// lookalike.
//
// The asset (branding/roleweave/roleweave-icon.svg) and the renderer (geometry
// in BrandMark.tsx + palette in onboarding.css) are split in two, because
// neither an SVG build loader nor hardcoded brand colour inside a component was
// wanted. The cost of that split is drift, so every value is pinned here: any
// edit that fails to update the other half turns the suite red.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..", "..", "..");
const assetPath = path.join(repoRoot, "branding", "roleweave", "roleweave-icon.svg");
const componentPath = path.join(__dirname, "..", "renderer", "src", "onboarding", "BrandMark.tsx");
const cssPath = path.join(__dirname, "..", "renderer", "src", "onboarding", "onboarding.css");

const asset = fs.readFileSync(assetPath, "utf8");
const component = fs.readFileSync(componentPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

test("#519 the splash mark reuses the shipped icon geometry verbatim", () => {
  const viewBox = /viewBox="([^"]+)"/.exec(asset);
  assert.ok(viewBox, "the brand asset must declare a viewBox");
  assert.ok(component.includes(`viewBox="${viewBox[1]}"`), `BrandMark must keep the asset viewBox (${viewBox[1]})`);

  const transform = /<g[^>]*transform="([^"]+)"/.exec(asset);
  assert.ok(transform, "the brand asset must declare its artwork transform");
  assert.ok(component.includes(`transform="${transform[1]}"`), `BrandMark must keep the asset transform (${transform[1]})`);

  const paths = [...asset.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(paths.length, 4, "the asset is expected to carry four ribbon paths");
  for (const d of paths) {
    assert.ok(component.includes(d), `BrandMark is missing asset path data: ${d.slice(0, 48)}...`);
  }

  // The element make-up must match too: two rects (tile + edge) and two dots.
  assert.equal((component.match(/<rect/g) ?? []).length, 2, "BrandMark must draw the tile and the edge rect");
  assert.equal((component.match(/<circle/g) ?? []).length, 2, "BrandMark must draw both node dots");
  for (const attribute of ['x="0" y="0" width="512" height="512" rx="126"', 'x="8" y="8" width="496" height="496" rx="118"', 'cx="116" cy="106" r="9"', 'cx="412" cy="264" r="9"']) {
    assert.ok(component.includes(attribute), `BrandMark must keep the asset geometry: ${attribute}`);
  }
});

test("#519 the brand palette lives in CSS and matches the asset hex values", () => {
  // Every coloured element inside the asset's <g>, and the token it must carry.
  // weave-break-* share the canvas colour: they are the patches that punch
  // holes in the weave ribbon.
  const mapping = [
    ["icon-canvas", "--owb-brandmark-tile", "#141820"],
    ["icon-edge", "--owb-brandmark-edge", "#2c3a52"],
    ["role-ribbon", "--owb-brandmark-role", "#722ed1"],
    ["weave-ribbon", "--owb-brandmark-weave", "#1677ff"],
    ["weave-break-left", "--owb-brandmark-tile", "#141820"],
    ["weave-break-right", "--owb-brandmark-tile", "#141820"],
    ["role-node", "--owb-brandmark-node", "#ffffff"],
    ["workflow-node", "--owb-brandmark-node", "#ffffff"],
  ];

  for (const [id, token, hex] of mapping) {
    const element = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(asset);
    assert.ok(element, `the brand asset must still declare #${id}`);
    assert.ok(
      element[0].toLowerCase().includes(hex),
      `#${id} no longer paints ${hex} in the asset; the mapping below is stale`,
    );
    assert.ok(
      new RegExp(`${token}:\\s*${hex}`).test(css),
      `${token} must declare the asset's own value ${hex}`,
    );
  }

  // The component carries no colour of its own: colour comes only from CSS,
  // geometry only from the component.
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(component), "BrandMark must stay geometry-only (no hex literals)");
  assert.ok(!/\bfill="#/.test(component), "BrandMark must set no inline fill; the CSS classes own colour");

  // Class wiring: every element class must actually be coloured by CSS, or the
  // mark renders black.
  for (const part of ["tile", "edge", "role", "weave", "cut", "node"]) {
    assert.ok(
      new RegExp(`\\.owb-brandmark__${part}\\s*[,{]`).test(css),
      `.owb-brandmark__${part} must be styled in onboarding.css`,
    );
  }
});
