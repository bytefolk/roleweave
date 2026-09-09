// The shell has a fixed viewport. Page-level scrolling makes the whole layout
// reflow when an alert, a scrollbar, or a module changes height. Scrolling is
// therefore owned by the specific data surface that needs it (thread, report
// stream, document list, etc.), never by the shell or the main page wrapper.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const test = require("node:test");

const stylesheet = path.join(__dirname, "..", "renderer", "src", "app.css");
const ast = postcss.parse(fs.readFileSync(stylesheet, "utf8"), { from: stylesheet });

function lastDecl(selector, prop) {
  let value = null;
  ast.walkRules((rule) => {
    if (!rule.selectors.map((item) => item.trim()).includes(selector)) return;
    rule.walkDecls(prop, (decl) => { value = decl.value; });
  });
  return value;
}

test("shell and page wrapper do not own a scrollbar", () => {
  for (const selector of ["html", "body", "#root"]) {
    assert.equal(lastDecl(selector, "height"), "100%", `${selector} must participate in the fixed viewport chain`);
    assert.equal(lastDecl(selector, "overflow"), "hidden", `${selector} must not become the document scroll owner`);
  }
  assert.equal(lastDecl(".owb-app", "height"), "100%", "the app shell must use the fixed root height");
  assert.equal(lastDecl(".owb-app", "min-height"), "0", "the app shell must be shrinkable inside the root");
  assert.equal(lastDecl(".owb-main", "overflow"), "hidden");

  const shellMain = [];
  ast.walkRules((rule) => {
    if (!rule.selectors.map((item) => item.trim()).includes(".owb-app .ui-app-shell__main")) return;
    shellMain.push(rule);
  });
  assert.ok(shellMain.length > 0, "the desktop shell needs an app-specific main rule");
  let overflow = null;
  shellMain.forEach((rule) => rule.walkDecls("overflow", (decl) => { overflow = decl.value; }));
  assert.equal(overflow, "hidden");
});

test("scrollable modules keep scrolling local to their own surface", () => {
  assert.equal(lastDecl(".owb-main > .owb-approval-queue", "overflow-y"), "auto");
  assert.equal(lastDecl(".owb-main > .owb-reports", "overflow-y"), "auto");
  assert.equal(lastDecl(".owb-main > .owb-docs-module", "overflow-y"), "auto");
  assert.equal(lastDecl(".owb-main > .owb-memory-module", "overflow-y"), "auto");
  assert.equal(lastDecl(".owb-main > .owb-settings-module", "overflow-y"), "auto");
  for (const selector of [
    ".owb-main > .owb-approval-queue",
    ".owb-main > .owb-reports",
    ".owb-main > .owb-docs-module",
    ".owb-main > .owb-memory-module",
    ".owb-main > .owb-settings-module",
  ]) {
    assert.equal(lastDecl(selector, "scrollbar-gutter"), "stable", `${selector} must reserve its scrollbar gutter`);
  }
});

test("every primary module can shrink before its own local scroll surface takes over", () => {
  const source = fs.readFileSync(stylesheet, "utf8");
  const flexRule = source.match(/\.owb-main > \.owb-org-module,[\s\S]*?\.owb-main > \.owb-settings-module\s*\{([\s\S]*?)\}/);
  assert.ok(flexRule, "the fixed-height main area needs one complete primary-module sizing rule");
  assert.match(flexRule[1], /flex:\s*1/);
  assert.match(flexRule[1], /min-height:\s*0/);
  for (const moduleName of ["owb-org-module", "owb-groups", "owb-reports", "owb-docs-module", "owb-memory-module", "owb-approval-queue", "owb-settings-module"]) {
    assert.match(flexRule[0], new RegExp(`\\.owb-main > \\.${moduleName}(?:,|\\s*\\{)`), `${moduleName} must be in the shrinkable module set`);
  }
});

test("page surfaces keep their content column shrinkable across every module", () => {
  const source = fs.readFileSync(stylesheet, "utf8");
  const pageSurfaceRule = source.match(/\.owb-main > \.owb-org-module,[\s\S]*?\.owb-main > \.owb-settings-module\s*\{([\s\S]*?)\}/);
  assert.ok(pageSurfaceRule, "primary page surfaces need a shared sizing contract");
  for (const moduleName of [
    "owb-org-module",
    "owb-groups",
    "owb-reports",
    "owb-docs-module",
    "owb-memory-module",
    "owb-approval-queue",
    "owb-settings-module",
  ]) {
    assert.match(pageSurfaceRule[0], new RegExp(`\\.owb-main > \\.${moduleName}(?:,|\\s*\\{)`));
  }
  assert.match(pageSurfaceRule[1], /min-width:\s*0/);
});

test("the conclusion stays in the conversation scroll surface", () => {
  assert.equal(lastDecl(".owb-turn__conclusion .owb-tc__out", "overflow"), "visible");
  assert.equal(lastDecl(".owb-turn__conclusion .owb-tc__out", "max-height"), "none");
});

test("employee replies use the full conversation width and keep status labels intact", () => {
  const employee = ".owb-turn-thread .owb-bubble--employee.owb-tc";
  assert.equal(lastDecl(employee, "width"), "100%");
  assert.equal(lastDecl(employee, "max-width"), "100%");
  assert.equal(lastDecl(".owb-turn-thread .owb-tc-head", "flex-wrap"), "wrap");
  assert.equal(lastDecl(".owb-turn-thread .owb-tc-head__who", "flex"), "1 1 140px");
  assert.equal(lastDecl(".owb-turn-thread .owb-turn__status", "white-space"), "nowrap");
});
