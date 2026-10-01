// The machine-checkable half of the #519 first-run motion.
//
// jsdom applies no real stylesheet cascade, so these invariants read the **built
// bundle**, following this repository's existing practice (contrast /
// window-controls-affordance / panel-parity): @keyframes may only drive
// compositor properties, reduced motion must actually land, and the transition
// duration must have exactly one source of truth.
//
// Negative controls (recorded in the PR ledger): swapping a keyframe's transform
// for width, or deleting the reduced-motion block, turns the matching assertion
// red.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSrc = path.join(__dirname, "..", "renderer", "src");

function builtCss() {
  const assetsDir = path.join(__dirname, "..", "dist", "renderer", "assets");
  const cssFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".css"));
  assert.ok(cssFiles.length > 0, "renderer build must emit css assets");
  return cssFiles.map((file) => fs.readFileSync(path.join(assetsDir, file), "utf8")).join("\n");
}

/** Brace-matched body of an at-rule, tolerant of minified output. */
function atRuleBody(css, name) {
  const index = css.indexOf(`@keyframes ${name}`);
  if (index < 0) return null;
  const open = css.indexOf("{", index);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

// Compositor-friendly properties plus one timing property that has no visual
// effect of its own.
const COMPOSITOR_SAFE = new Set(["transform", "opacity", "filter", "animation-timing-function"]);

test("#519 onboarding keyframes drive compositor-friendly properties only", () => {
  const css = builtCss();
  const names = [...css.matchAll(/@keyframes\s+(owb-onboarding-[\w-]+)/g)].map((match) => match[1]);
  assert.ok(names.length >= 5, `expected the onboarding keyframe family in the bundle, got ${names.join(", ")}`);

  for (const name of names) {
    const body = atRuleBody(css, name);
    assert.ok(body !== null, `${name} must have a parsable body`);
    const declared = [...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
    assert.ok(declared.length > 0, `${name} must declare something`);
    for (const property of declared) {
      assert.ok(
        COMPOSITOR_SAFE.has(property),
        `${name} animates "${property}"; the splash runs on the compositor, so only transform/opacity/filter (plus timing) may appear. ` +
          "A layout or paint property here drops frames exactly while the user is waiting.",
      );
    }
    // Stated as an explicit denial: these are the names a careless edit reaches
    // for first.
    for (const forbidden of ["width", "height", "top", "left", "margin", "letter-spacing", "background"]) {
      assert.ok(
        !new RegExp(`(^|;|\\{)\\s*${forbidden}\\s*:`).test(body),
        `${name} must not animate ${forbidden}`,
      );
    }
  }
});

test("#519 reduced motion keeps fades and drops the transforms", () => {
  const css = builtCss();
  // The bundle carries several reduced-motion blocks — the design system ships
  // its own global override, and it is not the one under test. Scan every
  // block and require the one that actually addresses the onboarding mark.
  const blocks = [];
  for (const match of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
    const open = css.indexOf("{", match.index);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) { blocks.push(css.slice(open + 1, i)); break; }
      }
    }
  }
  assert.ok(blocks.length > 0, "the renderer bundle must ship at least one prefers-reduced-motion block");

  const onboarding = blocks.filter((body) => body.includes(".owb-splash__mark"));
  assert.equal(
    onboarding.length,
    1,
    "exactly one reduced-motion block must address the onboarding mark (the mark is the loudest motion in the sequence)",
  );
  assert.match(onboarding[0], /owb-onboarding-fade-in/, "reduced motion must swap the mark animation for a fade");
  assert.match(
    onboarding[0],
    /transform:\s*none/,
    "the docking beat must drop its transform, not just its animation name",
  );
});

test("#519 the transition duration has exactly one source of truth", () => {
  const css = builtCss();
  assert.match(css, /var\(--owb-transition-ms/, "the stylesheet must consume --owb-transition-ms rather than hardcode a duration");
  const gate = fs.readFileSync(path.join(rendererSrc, "onboarding", "OnboardingGate.tsx"), "utf8");
  assert.match(gate, /"--owb-transition-ms"/, "the gate must publish --owb-transition-ms from the state machine's timings");
  assert.match(gate, /REDUCED_MOTION_ONBOARDING_TIMINGS/, "reduced-motion timings must live next to the default timings");
});

test("#519 onboarding adds no runtime dependency", () => {
  const allowed = new Set(["react", "@roleweave/ui", "@roleweave/shared"]);
  const dir = path.join(rendererSrc, "onboarding");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  assert.ok(files.length >= 4, "expected the onboarding module set");

  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^"']*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (!allowed.has(specifier)) offenders.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], `onboarding must not pull a new runtime dependency (issue AC): ${offenders.join(", ")}`);

  // Acceptance criterion: no extra request before the first paint. A remote
  // asset reference in this stylesheet would be one.
  const css = fs.readFileSync(path.join(dir, "onboarding.css"), "utf8");
  assert.ok(!/url\(\s*["']?https?:/i.test(css), "onboarding.css must not fetch a remote asset before first paint");
  assert.ok(!/@import\s/i.test(css), "onboarding.css must not @import anything");
});

test("#519 the ordinary launch is the only one that waits for ready-to-show", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /const showsOnReady = smokeRequest === null && behaviorSmokeRequest === null && layoutReportPath === null;/,
    "hiding the window must be limited to a normal launch: the staging/layout harnesses snapshot native descendants");
  assert.match(main, /show:\s*!showsOnReady/, "the window must start hidden exactly when we intend to reveal it on paint");
  assert.match(main, /once\("ready-to-show", revealOnce\)/, "ready-to-show must reveal the window");
  assert.match(main, /once\("did-finish-load", revealOnce\)/,
    "a launch that never reaches ready-to-show must still become visible instead of leaving an invisible window");
});

test("#519 the layout harness gets past onboarding through exactly one declared channel", () => {
  const { layoutSmokeLoadOptions, LAYOUT_SMOKE_QUERY_KEY } = require("../src/packaged-smoke.cjs");
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const entry = fs.readFileSync(path.join(rendererSrc, "main.tsx"), "utf8");

  // This is the only contact surface between this change and the #127 full-app
  // layout smoke: that harness renders the real app, and a fresh CI machine has
  // no session, so the gate would park it on the login card and the two columns
  // being measured would never appear inside the 5s mount-poll budget — a
  // correct build judged red. The harness therefore declares itself in the URL
  // and the renderer honours exactly that declaration.
  const options = layoutSmokeLoadOptions(path.join(rendererSrc, "..", "index.html"));
  assert.deepEqual(options.loadOptions, { query: { [LAYOUT_SMOKE_QUERY_KEY]: "1" } });
  assert.match(options.trustedRendererUrl, /\?orgWorkbenchLayoutSmoke=1$/,
    "the trusted renderer URL must carry the same query, otherwise every window IPC call in the harness run is rejected");

  assert.ok(entry.includes(`"${LAYOUT_SMOKE_QUERY_KEY}"`),
    `renderer/src/main.tsx must recognise the layout harness key ${LAYOUT_SMOKE_QUERY_KEY}`);
  assert.match(entry, /isLayoutSmokeEntry\(location\) \|\| isPackagedSmokeEntry\(location\)|isPackagedSmokeEntry\(location\) \|\| isLayoutSmokeEntry\(location\)/,
    "the root element must bypass the gate for the layout harness");
  assert.match(main, /layoutSmokeLoadOptions\(entryPath\)/, "main must build the layout load options");
  assert.match(main, /loadFile\(entryPath, layoutLoad\.loadOptions\)/, "the layout branch must load with those options");
});
