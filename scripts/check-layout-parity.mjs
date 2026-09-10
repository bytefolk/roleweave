#!/usr/bin/env node
/** #127 AC-004: cross-platform layout parity for the two-column org workspace.
 * Compares the `layout` measurements embedded in the packaged static smoke
 * reports produced on macOS arm64 and Windows x64.
 *
 * #190: this used to compare absolute column heights across platforms with an
 * 8px tolerance, and the first run that ever had both reports failed on an 89px
 * difference with identical widths and perfect intra-platform alignment. The
 * runners do not give the app the same window height, so an absolute height
 * comparison measures the runner rather than the layout. What is comparable
 * across platforms is the chrome overhead: how much vertical space the app's own
 * chrome takes out of the viewport it was given. That is why the measurement now
 * records the viewport, and why a report without one is refused rather than
 * silently compared.
 *
 * #194: the renderer also reports whether the measurement settled — whether the
 * columns stopped moving — rather than sampling them the instant they appeared.
 * An unsettled report is refused here on the same principle as a viewport-less
 * one: the numbers in it describe a moment during layout, and two such moments
 * on two runners are not a layout comparison. Refusing is what makes the settle
 * gate load-bearing instead of advisory.
 *
 * Thresholds (declared, reviewable here):
 *  - per-platform bottomDelta (left column bottom vs turn panel bottom) <= 2px,
 *    the two columns must end together;
 *  - per-platform |leftHeight - rightHeight| <= 2px, they must also be the same
 *    height, which bottom alignment alone does not prove;
 *  - cross-platform column width delta <= 4px (fr tracks, same window width);
 *  - cross-platform chrome overhead delta <= 8px, where overhead is
 *    viewport.innerHeight - column height. Absolute heights are never compared
 *    across platforms.
 * A missing `layout`, `viewport` or `settled: true` on either side fails
 * loudly. The thresholds above are untouched by #194: the settle gate decides
 * when to stop waiting, never what counts as parity. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BOTTOM_DELTA_MAX = 2;
const COLUMN_HEIGHT_DELTA_MAX = 2;
const CROSS_WIDTH_DELTA_MAX = 4;
const CROSS_CHROME_DELTA_MAX = 8;

export function readLayout(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!report || typeof report !== "object" || report.layout === undefined) {
    throw new Error(`${file}: smoke report has no layout measurement`);
  }
  if (report.layout === null) {
    throw new Error(`${file}: layout is null — the two-column org module did not render`);
  }
  const layout = report.layout;
  const viewport = layout.viewport;
  // Refused rather than defaulted: a report from before #190 carries no viewport,
  // and guessing one would reintroduce exactly the comparison that was wrong.
  if (!viewport || typeof viewport.innerHeight !== "number" || viewport.innerHeight <= 0) {
    throw new Error(
      `${file}: layout has no usable viewport measurement; a height difference cannot be attributed without it`,
    );
  }
  // #194: refused rather than compared, for the same reason as the viewport
  // above. A measurement taken before the renderer finished laying out is a
  // sample of when that runner happened to look, not of the layout, so a pair
  // of them compares two arbitrary moments. Ordered after the viewport check:
  // a report carrying neither still reports the viewport, which is the older
  // and more specific absence.
  if (layout.settled !== true) {
    throw new Error(
      `${file}: layout measurement never settled within its budget; a mid-layout sample cannot be compared across platforms`,
    );
  }
  return layout;
}

/** Vertical space the app's own chrome takes out of the viewport. Comparable
 * across platforms in a way an absolute column height is not. */
function chromeOverhead(layout) {
  return layout.viewport.innerHeight - layout.leftHeight;
}

export function layoutParityFailures(mac, win) {
  const failures = [];

  for (const [name, layout] of [["macos", mac], ["windows", win]]) {
    if (!(layout.leftHeight > 0) || !(layout.rightHeight > 0)) {
      failures.push(`${name}: a column measured no height (${layout.leftHeight}px / ${layout.rightHeight}px)`);
    }
    if (layout.bottomDelta > BOTTOM_DELTA_MAX) {
      failures.push(`${name}: column bottom delta ${layout.bottomDelta}px exceeds ${BOTTOM_DELTA_MAX}px`);
    }
    if (Math.abs(layout.leftHeight - layout.rightHeight) > COLUMN_HEIGHT_DELTA_MAX) {
      failures.push(
        `${name}: columns are different heights (left ${layout.leftHeight}px vs turn panel ${layout.rightHeight}px, max ${COLUMN_HEIGHT_DELTA_MAX}px)`,
      );
    }
    const overhead = chromeOverhead(layout);
    if (overhead < 0) {
      failures.push(
        `${name}: column is taller than its viewport (${layout.leftHeight}px in ${layout.viewport.innerHeight}px)`,
      );
    }
  }

  if (Math.abs(mac.leftWidth - win.leftWidth) > CROSS_WIDTH_DELTA_MAX) {
    failures.push(`left column width differs: mac ${mac.leftWidth}px vs win ${win.leftWidth}px (max ${CROSS_WIDTH_DELTA_MAX}px)`);
  }
  if (Math.abs(mac.rightWidth - win.rightWidth) > CROSS_WIDTH_DELTA_MAX) {
    failures.push(`turn panel width differs: mac ${mac.rightWidth}px vs win ${win.rightWidth}px (max ${CROSS_WIDTH_DELTA_MAX}px)`);
  }

  const macOverhead = chromeOverhead(mac);
  const winOverhead = chromeOverhead(win);
  if (Math.abs(macOverhead - winOverhead) > CROSS_CHROME_DELTA_MAX) {
    failures.push(
      `chrome overhead differs: mac ${macOverhead}px of ${mac.viewport.innerHeight}px vs win ${winOverhead}px of ${win.viewport.innerHeight}px (max ${CROSS_CHROME_DELTA_MAX}px)`,
    );
  }

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [macPath, winPath] = process.argv.slice(2);
  if (!macPath || !winPath) {
    console.error("usage: node scripts/check-layout-parity.mjs <mac-report.json> <win-report.json>");
    process.exit(2);
  }
  const mac = readLayout(macPath);
  const win = readLayout(winPath);
  const failures = layoutParityFailures(mac, win);
  if (failures.length > 0) {
    console.error("layout parity FAILED:");
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    mac,
    win,
    chromeOverhead: { macos: chromeOverhead(mac), windows: chromeOverhead(win) },
  }));
}
