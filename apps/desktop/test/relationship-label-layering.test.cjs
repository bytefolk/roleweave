// #517 bug 3: three's CSS2DRenderer writes `element.style.zIndex = zMax - i`
// onto every label element it sorts, i.e. 1..N for N visible labels. None of
// the wrappers between `.owb-rgraph__spatial-labels` and
// `.owb-rgraph__workspace` created a stacking context, so those indices
// competed page-wide and beat the z-index 3 canvas chrome and the z-index 8
// "relationship details" overlay: the black name labels painted straight over
// both. Giving `.owb-rgraph__spatial-stage` a z-index contains them.
//
// The measured half — an actual paint order in a layout engine — needs a
// browser, so this asserts the CSS contract the containment depends on. It is
// the executable floor, not a substitute for the visual pass.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const test = require("node:test");

const stylesheet = path.join(__dirname, "..", "renderer", "src", "graph", "RelationshipGraph.css");
const ast = postcss.parse(fs.readFileSync(stylesheet, "utf8"), { from: stylesheet });

/** Last value of `property` declared for the exact `selector`. */
function lastDecl(selector, property) {
  let value = null;
  ast.walkRules((rule) => {
    if (!rule.selectors.map((item) => item.trim()).includes(selector)) return;
    rule.walkDecls(property, (decl) => { value = decl.value; });
  });
  return value;
}

function zIndex(selector) {
  const raw = lastDecl(selector, "z-index");
  return raw === null ? null : Number(raw);
}

test("the 3D label stage forms the stacking context that contains three's label z-indices (#517)", () => {
  assert.equal(
    lastDecl(".owb-rgraph__spatial-stage", "position"),
    "absolute",
    "z-index only applies to a positioned element, so the stage must stay positioned",
  );
  assert.equal(
    zIndex(".owb-rgraph__spatial-stage"),
    0,
    "without a stacking context on the stage, CSS2DRenderer's 1..N label indices compete with the canvas chrome page-wide",
  );
});

test("canvas chrome, the fallback and the details inspector all paint above the contained label stage (#517)", () => {
  const stage = zIndex(".owb-rgraph__spatial-stage");
  assert.notEqual(stage, null, "the label stage must declare a z-index");

  for (const above of [
    ".owb-rgraph__spatial-fallback",
    ".owb-rgraph__spatial-controls",
    ".owb-rgraph__object-navigation",
  ]) {
    const value = zIndex(above);
    assert.notEqual(value, null, `${above} must declare a z-index so it is unambiguously above the label layer`);
    assert.ok(value > stage, `${above} (z-index ${value}) must paint above the contained label stage (z-index ${stage})`);
  }

  // The selection inspector is an overlay only inside the container query, so
  // read it from the query body instead of the top level.
  let inspector = null;
  ast.walkAtRules("container", (rule) => {
    rule.walkRules((nested) => {
      if (!nested.selectors.map((item) => item.trim()).includes(".owb-rgraph__workspace.has-selection .owb-rgraph__inspector")) return;
      nested.walkDecls("z-index", (decl) => { inspector = Number(decl.value); });
    });
  });
  assert.notEqual(inspector, null, "the narrow-container inspector overlay must keep a z-index");
  assert.ok(
    inspector > stage,
    `the details inspector overlay (z-index ${inspector}) must paint above the contained label stage (z-index ${stage})`,
  );
});
