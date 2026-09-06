// #120 regression: above the 980px breakpoint the Org page's lower-left
// position region and the adjacent local-conversation panel have to read as one
// equal pair — equal width, same grid-row height — with the position card
// taking the left column's remaining height and the dismiss action pinned to
// the bottom of the column.
//
// Two declarations shipped it broken: `.owb-org-module` sized its tracks
// `minmax(300px, .92fr) minmax(360px, 1.14fr)` (left permanently narrower, and
// the unequal 300/360 px floors pinned that ratio once the fr maths stopped
// dominating), and `.owb-position-column` opted out of the row with
// `align-self: start` + `grid-template-rows: auto auto` (left permanently
// shorter). Both are CSS-only, so this asserts the CSS contract.
//
// The measured half of #120 — AC-001/AC-002 `getBoundingClientRect()` deltas
// and AC-004's emulated narrow width — needs a layout engine, which jsdom is
// not; this is the executable floor, not a substitute for the screenshot pass.
//
// Assertions resolve the cascade rather than pattern-matching the sheet.
// app.css still carries pre-#73 two-track declarations (`minmax(240px, .65fr)`
// under `max-width: 1080px`, `minmax(280px, .72fr)` unconditionally) that a
// later unconditional rule overrides, so they never render. Grep-style
// "selector X declares property P" would fail on text the user cannot reach,
// while resolving P at a viewport asserts what actually applies. Delete the
// winning block and the resurrected stale value is exactly what the resolver
// reports here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const postcss = require("postcss");

// The 981px case is the breakpoint edge: two columns, and the narrower of the
// two desktop windows the contract has to hold in. 1280x700 is under the
// `max-height: 720px` compression rule from #73.
const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  desktopEdge: { width: 981, height: 900 },
  desktopShort: { width: 1280, height: 700 },
  stackedAt980: { width: 980, height: 900 },
  stackedNarrow: { width: 760, height: 900 },
};

function builtStylesheet() {
  const assetsDir = path.join(__dirname, "..", "dist", "renderer", "assets");
  const cssFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".css"));
  assert.ok(cssFiles.length > 0, "renderer build must emit css assets");
  return cssFiles
    .map((file) => fs.readFileSync(path.join(assetsDir, file), "utf8"))
    .join("\n");
}

/** Cascade order is source order, so walk the sheet once and keep the rules. */
function stylesheetRules() {
  const ast = postcss.parse(builtStylesheet(), { from: "renderer-bundle.css" });
  const rules = [];
  ast.walkRules((rule) => {
    const conditions = [];
    for (let parent = rule.parent; parent !== undefined; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name === "media") conditions.push(parent.params);
    }
    rules.push({ selectors: rule.selectors.map(normalizeSelector), conditions, decls: rule.nodes });
  });
  return rules;
}

function normalizeSelector(selector) {
  return selector.replace(/\s*([>+~])\s*/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * Whether a `@media` parameter list can be true for this viewport. Only the
 * width/height features app.css actually uses are understood; anything else
 * throws instead of being assumed away, because silently ignoring a condition
 * would make a rule look like it applies when it cannot.
 */
function mediaMatches(params, viewport) {
  const list = params.split(",").map((part) => part.trim());
  return list.some((one) =>
    one
      // Vite's production minifier removes the whitespace around `and`.
      // Put it back before tokenizing so combined viewport guards remain
      // executable in the cascade resolver instead of being treated as an
      // unknown media feature.
      .replace(/\)\s*and\s*\(/gi, ") and (")
      .split(/\s+and\s+/i)
      .map((token) => token.trim())
      .every((token) => {
        if (/^(only|screen|all)$/i.test(token)) return true;
        const feature = /^\(\s*(max|min)?-?(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(token);
        if (feature === null) {
          throw new Error(`mediaMatches: unsupported @media condition "${token}" — extend this matcher rather than guessing`);
        }
        const [, bound, name, rawPx] = feature;
        if (bound === undefined) {
          throw new Error(`mediaMatches: bare @media feature "${token}" is exact-match in MQ3, not min-width — extend this matcher rather than guessing`);
        }
        const px = Number(rawPx);
        const size = name.toLowerCase() === "width" ? viewport.width : viewport.height;
        return bound.toLowerCase() === "max" ? size <= px : size >= px;
      }),
  );
}

/** Last value of `property` declared for the exact `selector` at `viewport`. */
function valueAt(rules, selector, property, viewport) {
  const wanted = normalizeSelector(selector);
  let value = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(wanted)) continue;
    if (!rule.conditions.every((params) => mediaMatches(params, viewport))) continue;
    for (const node of rule.decls) {
      if (node.type !== "decl" || node.prop !== property) continue;
      assert.notEqual(
        node.important,
        true,
        `!important on ${selector} { ${property} } defeats source-order cascade resolution in this test`,
      );
      value = node.value;
    }
  }
  return value;
}

/**
 * Grid track list as authored: top-level whitespace split (not inside
 * `minmax(…)`/`repeat(…)`), with `repeat(N, …)` expanded because that is the
 * shape a minifier may fold two identical tracks into.
 */
function trackList(value) {
  assert.notEqual(value, null, "expected a grid track declaration");
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === " " && depth === 0) {
      if (current !== "") parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") parts.push(current);

  const tracks = [];
  for (const part of parts) {
    const repeat = /^repeat\(\s*(\d+)\s*,(.+)\)$/i.exec(part);
    if (repeat === null) {
      tracks.push(part);
      continue;
    }
    const times = Number(repeat[1]);
    const inner = trackList(repeat[2].trim());
    for (let index = 0; index < times; index += 1) tracks.push(...inner);
  }
  return tracks;
}

function normalizeTrack(track) {
  return track.replace(/\s+/g, "");
}

function flexGrows(value) {
  if (value === null) return false;
  if (/^none$/.test(value)) return false;
  const first = value.split(/\s+/)[0];
  return !(Number.isNaN(Number(first)) ? false : Number(first) <= 0);
}

test("position region and conversation panel are equal width on desktop (#120 AC-001)", () => {
  const rules = stylesheetRules();

  for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.desktopEdge]) {
    assert.equal(
      valueAt(rules, ".owb-org-module", "display", viewport),
      "grid",
      `${viewport.width}px: without display: grid the two children stack as blocks, so every track assertion below describes a layout that never renders`,
    );

    const tracks = trackList(valueAt(rules, ".owb-org-module", "grid-template-columns", viewport));
    assert.equal(tracks.length, 2, `${viewport.width}px must keep the two-column pair`);
    const [left, right] = tracks.map(normalizeTrack);
    assert.equal(
      left,
      right,
      `${viewport.width}px tracks "${left}" / "${right}" are not equal — the old 0.92fr/1.14fr asymmetry`,
    );
    for (const track of [left, right]) {
      assert.match(track, /fr/, `${viewport.width}px track "${track}" is not flexible, so the pair cannot stay equal as the window resizes`);
    }
  }
});

test("position column stretches to the row as a single filled card (#120 AC-002, #137 review)", () => {
  const rules = stylesheetRules();
  const viewport = VIEWPORTS.desktop;

  assert.equal(
    valueAt(rules, ".owb-org-module", "align-items", viewport),
    "stretch",
    "the grid must stretch its items, otherwise equal row height depends on every column sizing itself",
  );

  const alignSelf = valueAt(rules, ".owb-position-column", "align-self", viewport);
  assert.ok(
    alignSelf === null || alignSelf === "auto" || alignSelf === "stretch",
    `position column resolves align-self: ${alignSelf}; #120 relies on the grid's inherited stretch and #130 writes that same value out explicitly, but anything else shrinks the column back below the conversation panel`,
  );

  const rows = trackList(valueAt(rules, ".owb-position-column", "grid-template-rows", viewport));
  assert.equal(rows.length, 1, "the column is a single card row since #137 moved dismiss into the card header");
  assert.match(normalizeTrack(rows[0]), /1fr/, `card row "${rows[0]}" must take the column's remaining height`);
  assert.equal(
    valueAt(rules, ".owb-position-actions", "display", viewport),
    null,
    "the outside dismiss wrapper must stay removed — the action lives in the card header now",
  );

  assert.ok(
    flexGrows(valueAt(rules, ".owb-main > .owb-org-module", "flex", viewport)),
    "the Org page has to give the grid the window's remaining height, or there is no row to share",
  );
});

test("position content and dismiss action stay reachable under vertical pressure (#120 AC-003)", () => {
  const rules = stylesheetRules();
  const viewport = VIEWPORTS.desktopShort;

  const minHeight = valueAt(rules, ".owb-position-column", "min-height", viewport);
  assert.equal(
    String(minHeight).replace(/\s+/g, ""),
    "0",
    `position column min-height: ${minHeight} — a px floor here outruns the available height in a short window instead of scrolling`,
  );

  assert.equal(
    valueAt(rules, ".owb-position-column > .ui-org-position-card", "min-height", viewport),
    "0",
    "the card itself needs min-height: 0 to shrink inside the column",
  );

  assert.ok(
    flexGrows(valueAt(rules, ".owb-pos-body", "flex", viewport)),
    "the card body is the flexible region: without flex-grow the stretched card leaves dead space under the content",
  );
  assert.match(
    String(valueAt(rules, ".owb-pos-body", "overflow", viewport)),
    /\b(auto|scroll)\b/,
    "the card body must scroll, otherwise the Context Scope section is unreachable once the card is short",
  );
  assert.equal(valueAt(rules, ".owb-pos-body", "min-height", viewport), "0", "overflow cannot engage against an auto min-height");

  assert.match(
    String(valueAt(rules, ".owb-panel", "overflow", viewport)),
    /hidden|auto|scroll/,
    "the card shell must clip or scroll so a stretched position card never spills outside the panel pair",
  );
});

test("left column pairs the chart and the position record; conversation owns the right column (#137 AC-001/003)", () => {
  const rules = stylesheetRules();
  const viewport = VIEWPORTS.desktop;

  assert.equal(
    valueAt(rules, ".owb-org-module__left", "display", viewport),
    "flex",
    "the left column is a flex stack: chart on top, position record below, same width by construction",
  );
  assert.equal(
    valueAt(rules, ".owb-org-module__left", "flex-direction", viewport),
    "column",
    "chart and position record must stack vertically in one column",
  );
  assert.ok(
    !flexGrows(valueAt(rules, ".owb-org-module__left > .owb-org-chart", "flex", viewport)),
    "the chart keeps its content height inside the left column",
  );
  assert.ok(
    flexGrows(valueAt(rules, ".owb-org-module__left > .owb-position-column", "flex", viewport)),
    "the position record absorbs the left column's remaining height so the column fills the module row",
  );
  // Right column: the turn panel is a direct grid item of .owb-org-module and
  // the module stretches its items, so the conversation panel owns the full
  // module height (structural guarantee; jsdom-free CSS contract).
  assert.equal(
    valueAt(rules, ".owb-org-module", "align-items", viewport),
    "stretch",
    "module-level stretch is what lets the conversation panel own the right column height",
  );
});

test("the pair stacks in one column at 980px and below, without unequal-width tracks (#120 AC-004)", () => {
  const rules = stylesheetRules();

  for (const viewport of [VIEWPORTS.stackedAt980, VIEWPORTS.stackedNarrow]) {
    const tracks = trackList(valueAt(rules, ".owb-org-module", "grid-template-columns", viewport));
    assert.equal(
      tracks.length,
      1,
      `${viewport.width}px must stack to a single column, got "${tracks.join(" ")}"`,
    );
  }

  const minWidth = valueAt(rules, ".owb-org-module > *", "min-width", VIEWPORTS.desktop);
  assert.equal(
    minWidth,
    "0",
    "grid items keep an automatic min-content floor; without min-width: 0 an equal track pair can be pushed apart by wide content",
  );
});

test("the stacked Org page has explicit rows and owns its narrow-window scroll (#185)", () => {
  const rules = stylesheetRules();

  for (const viewport of [VIEWPORTS.stackedAt980, VIEWPORTS.stackedNarrow]) {
    assert.equal(
      valueAt(rules, ".owb-main > .owb-org-module", "overflow-y", viewport),
      "auto",
      `${viewport.width}px: the stacked Org page must own overflow locally so the shell never clips one row over another`,
    );
    assert.deepEqual(
      trackList(valueAt(rules, ".owb-org-module", "grid-template-rows", viewport)).map(normalizeTrack),
      ["auto", "auto"],
      `${viewport.width}px: explicit auto rows are required; implicit grid rows were allowing the chart and conversation to overlap`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-module", "align-content", viewport),
      "start",
      `${viewport.width}px: stacked content must begin at the top instead of stretching implicit tracks unpredictably`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-module__left", "flex", viewport),
      "none",
      `${viewport.width}px: the chart + position stack must size its own grid row`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-module__left", "min-height", viewport),
      "max-content",
      `${viewport.width}px: the first stacked row must keep the chart and position card's content contribution`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-module__left > .owb-position-column", "flex", viewport),
      "none",
      `${viewport.width}px: the position card must not collapse its parent row while the conversation row is laid out`,
    );
  }
});

test("the org chart owns its canvas and cannot paint into the conversation row (#186)", () => {
  const rules = stylesheetRules();

  assert.equal(
    valueAt(rules, ".owb-org-chart", "position", VIEWPORTS.desktop),
    "relative",
    "the chart needs a local positioning context so its transformed stage cannot participate in an unrelated stacking context",
  );
  assert.equal(
    valueAt(rules, ".owb-org-chart", "isolation", VIEWPORTS.desktop),
    "isolate",
    "the chart must own an isolated paint context",
  );
  assert.equal(
    valueAt(rules, ".owb-org-chart", "overflow", VIEWPORTS.desktop),
    "hidden",
    "the chart panel must clip its canvas to its rounded frame",
  );
  assert.equal(
    valueAt(rules, ".owb-org-chart__body", "contain", VIEWPORTS.desktop),
    "paint",
    "the transformed chart stage must be paint-contained by the canvas body",
  );
  assert.equal(
    valueAt(rules, ".owb-org-module > .owb-turn-panel", "position", VIEWPORTS.desktop),
    "relative",
    "the conversation row needs a stable layer above any transformed chart pixels",
  );
  assert.equal(
    valueAt(rules, ".owb-org-module > .owb-turn-panel", "z-index", VIEWPORTS.desktop),
    "1",
    "the conversation row must win if a stale browser layout briefly overlaps rows",
  );

  for (const viewport of [VIEWPORTS.stackedAt980, VIEWPORTS.stackedNarrow]) {
    assert.equal(
      valueAt(rules, ".owb-org-module__left > .owb-org-chart", "width", viewport),
      "100%",
      `${viewport.width}px: the chart must follow the left column instead of sizing that column to the tree's max-content width`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-module__left > .owb-org-chart", "min-width", viewport),
      "0",
      `${viewport.width}px: the flex chart item must give up its automatic min-content width`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-chart", "min-height", viewport),
      "360px",
      `${viewport.width}px: the stacked chart needs a real canvas height before the conversation row begins`,
    );
    assert.equal(
      valueAt(rules, ".owb-org-chart__body", "min-height", viewport),
      "312px",
      `${viewport.width}px: the chart body must provide enough vertical room for the root and child tiers`,
    );
  }
});

// Not an AC: stretching the column made the no-position-selected card show one
// line of guidance with the leftover height below it. Product called this in
// during the #120 review, so it is gated here rather than left to the eye.
test("the empty position card fills the height it was stretched to (#120 review note)", () => {
  const rules = stylesheetRules();
  const viewport = VIEWPORTS.desktop;
  const notice = ".owb-position-column > .ui-org-position-card > .owb-panel__notice";

  assert.ok(
    flexGrows(valueAt(rules, notice, "flex", viewport)),
    "the guidance row has to take the card's leftover height, or the empty state shows a dead block under itself",
  );
  assert.equal(
    valueAt(rules, notice, "align-content", viewport),
    "center",
    "the guidance row is a grid box, so its single auto row must sit in the middle of the space it grew into",
  );
});
