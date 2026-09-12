// #127 AC-001/002: single-source org-module layout & responsive breakpoint pins.
//
// The renderer stylesheet used to declare `.owb-org-module` and
// `.owb-org-module > .owb-turn-panel` in TWO places — an earlier block
// with `align-items: start` + `height: calc(100vh - 116px)`, and a later
// block with `align-items: stretch` + `height: auto`. The later block won
// in the cascade, but the earlier dead-code copies stayed in the file and
// misled reviewers about the effective layout. Meanwhile the position
// column carried `align-self: start`, so the turn panel stretched with
// content while the position card stayed compact — an obvious visual
// height mismatch in the empty state.
//
// These tests pin the AC-001 fix (single-source, both panels stretch) and
// AC-002 responsive-breakpoint invariants (single-column stacking gives
// both panels a floor min-height, vertical-tight windows drop the floor).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const test = require("node:test");

const stylesheet = path.join(__dirname, "..", "renderer", "src", "app.css");
const css = fs.readFileSync(stylesheet, "utf8");
const ast = postcss.parse(css, { from: stylesheet });

function ruleBlocksMatching(selector, container = ast) {
  const matches = [];
  container.walkRules((rule) => {
    const selectors = rule.selectors.map((sel) => sel.trim());
    if (selectors.includes(selector)) matches.push(rule);
  });
  return matches;
}

function firstDecl(rule, prop) {
  let value = null;
  rule.walkDecls(prop, (decl) => { value = decl.value; });
  return value;
}

function atRulesMatching(name, params, container = ast) {
  const matches = [];
  container.walkAtRules(name, (rule) => {
    if (rule.params.replace(/\s+/g, "") === params.replace(/\s+/g, "")) {
      matches.push(rule);
    }
  });
  return matches;
}

function topLevelRuleBlocksMatching(selector) {
  const matches = [];
  ast.each((node) => {
    if (node.type === "rule") {
      const selectors = node.selectors.map((sel) => sel.trim());
      if (selectors.includes(selector)) matches.push(node);
    }
  });
  return matches;
}

test("#127 AC-001: `.owb-org-module` is defined exactly once at the top level and prescribes stretch alignment", () => {
  const rules = topLevelRuleBlocksMatching(".owb-org-module");
  assert.equal(rules.length, 1, "workspace grid rule must be single-sourced at the top level (no earlier dead-code copy)");
  assert.equal(firstDecl(rules[0], "align-items"), "stretch");
});

test("#127 AC-001: `.owb-org-module__pane--right > .owb-turn-panel` is defined exactly once at the top level and lets the turn panel grow (no viewport-driven height)", () => {
  const rules = topLevelRuleBlocksMatching(".owb-org-module__pane--right > .owb-turn-panel");
  assert.equal(rules.length, 1, "turn-panel-in-grid rule must be single-sourced at the top level");
  assert.equal(firstDecl(rules[0], "height"), "100%");
  assert.equal(firstDecl(rules[0], "min-height"), "0");
});

test("#127 AC-001: `.owb-position-column` never opts out of the row stretch", () => {
  // The column stays as tall as the turn panel either by inheriting the
  // parent's `align-items: stretch` (preferred, #120 AC-002 pins align-self
  // to null/auto) or by an explicit `align-self: stretch`. What broke the
  // layout was `align-self: start` — that must never come back.
  const rules = ruleBlocksMatching(".owb-position-column");
  for (const rule of rules) {
    const alignSelf = firstDecl(rule, "align-self");
    assert.ok(
      alignSelf === null || alignSelf === "stretch" || alignSelf === "auto",
      `position column declares align-self: ${alignSelf}; only inherited stretch or explicit stretch/auto keep the pair equal-height`,
    );
  }
  const grid = topLevelRuleBlocksMatching(".owb-org-module")[0];
  assert.equal(firstDecl(grid, "align-items"), "stretch");
});

test("#127 AC-002: single-column stacking (≤980px) preserves the min-height floor for both panels", () => {
  const media980 = atRulesMatching("media", "(max-width: 980px)");
  assert.ok(media980.length >= 1, "single-column media block must exist");
  const stackingRules = [];
  for (const at of media980) {
    at.walkRules((rule) => {
      const selectors = rule.selectors.map((sel) => sel.trim());
      if (
        selectors.includes(".owb-org-module__left > .owb-position-column") &&
        selectors.includes(".owb-org-module__pane--right > .owb-turn-panel")
      ) {
        stackingRules.push(rule);
      }
    });
  }
  assert.equal(stackingRules.length, 1, "one paired stacking rule must set min-height on both panels");
  assert.equal(firstDecl(stackingRules[0], "min-height"), "380px");
});

test("#127 AC-002: vertical-tight viewport (≤720px height) drops the min-height floor so panels can scroll", () => {
  const media720 = atRulesMatching("media", "(max-height: 720px)");
  assert.ok(media720.length >= 1, "vertical-tight media block must exist");
  const dropRules = [];
  for (const at of media720) {
    at.walkRules((rule) => {
      const selectors = rule.selectors.map((sel) => sel.trim());
      if (
        selectors.includes(".owb-org-module__left > .owb-position-column") &&
        selectors.includes(".owb-org-module__pane--right > .owb-turn-panel")
      ) {
        dropRules.push(rule);
      }
    });
  }
  assert.equal(dropRules.length, 1, "vertical-tight block must drop the paired min-height");
  assert.equal(firstDecl(dropRules[0], "min-height"), "0");
});
