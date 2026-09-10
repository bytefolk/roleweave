// Renders the RoleWeave site headlessly, screenshots the three sections the PR
// description claims to check, asserts page health, and FAILS CLOSED
// (process.exitCode = 1) on any page error or failed assertion. Webfont
// requests to fonts.googleapis.com / fonts.gstatic.com failing is reported but
// NOT fatal: that depends on the runner's network, not on this page.
//
// Run it in an isolated, version-pinned environment so a warm browser cache
// cannot mask a version mismatch (playwright-core's CLI is named
// `playwright-core`, not `playwright`):
//
//   WORK=$(mktemp -d); export PLAYWRIGHT_BROWSERS_PATH="$WORK/browsers"
//   cd "$WORK" && npm init -y >/dev/null
//   npm install playwright-core@1.62.1
//   npx --no-install playwright-core install chromium
//   node /path/to/repo/scripts/render-check.js /path/to/repo/index.html
//
// Add --self-test-failclose to inject a console.error and a thrown error into
// the same page; everything else stays identical, so a non-zero exit there
// proves the error path fails closed rather than merely printing.
const { chromium } = require('playwright-core');
const fs = require('fs');

const SITE = process.argv[2];
const SELF_TEST = process.argv.includes('--self-test-failclose');
const SECTIONS = [
  { name: 'hero', selector: 'header.hero' },
  { name: 'runtime', selector: '#runtime' },
  { name: 'ladder', selector: '#ladder' },
];
const EXPECTED_REVEALS = 9;

(async () => {
  const failures = [];
  const errors = [];
  const fontFailures = [];
  const browser = await chromium.launch({ headless: true });
  try {
    console.log('BROWSER_VERSION=' + browser.version());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Fatal: the page's own JavaScript failing. Resource-load echoes are
    // handled via requestfailed below, so they are excluded here to keep this
    // assertion deterministic with respect to the page rather than the network.
    page.on('console', m => {
      if (m.type() !== 'error') return;
      if (/^Failed to load resource/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    page.on('pageerror', e => errors.push('pageerror: ' + String(e)));

    // The page pulls webfonts from fonts.googleapis.com / fonts.gstatic.com.
    // Those failing says something about the runner's network, not about this
    // page, so they are reported but not fatal. Any OTHER failed request is.
    page.on('requestfailed', req => {
      const url = req.url();
      const why = (req.failure() && req.failure().errorText) || 'unknown';
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) {
        fontFailures.push(`${url} (${why})`);
      } else {
        errors.push(`requestfailed: ${url} (${why})`);
      }
    });

    if (SELF_TEST) {
      await page.addInitScript(() => {
        console.error('injected console error (--self-test-failclose)');
        setTimeout(() => { throw new Error('injected pageerror (--self-test-failclose)'); }, 50);
      });
    }

    await page.goto('file://' + SITE, { waitUntil: 'load' });
    await page.waitForTimeout(600);

    for (const s of SECTIONS) {
      const el = await page.$(s.selector);
      if (!el) { failures.push(`section not found: ${s.selector}`); continue; }
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const box = await el.boundingBox();
      if (!box || box.width < 200 || box.height < 100) {
        failures.push(`section ${s.name} has implausible box: ${JSON.stringify(box)}`);
        continue;
      }
      const file = `${s.name}.png`;
      await el.screenshot({ path: file });
      const bytes = fs.statSync(file).size;
      if (bytes < 5000) failures.push(`screenshot ${file} suspiciously small: ${bytes} bytes`);
      console.log(`SECTION=${s.name} box=${Math.round(box.width)}x${Math.round(box.height)} file=${file} bytes=${bytes}`);
    }

    // Progressive scroll: a single jump to the bottom skips most sections, so
    // their IntersectionObservers never fire. Step through so every .reveal
    // block actually passes through the viewport.
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.6);
      for (let y = 0; y <= document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 300));
    });
    await page.waitForTimeout(600);

    const reveals = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.reveal'));
      return { total: all.length, shown: all.filter(e => e.classList.contains('in')).length };
    });
    console.log(`REVEALS=${reveals.shown}/${reveals.total}`);
    if (reveals.total !== EXPECTED_REVEALS) failures.push(`expected ${EXPECTED_REVEALS} reveal blocks, found ${reveals.total}`);
    if (reveals.shown !== reveals.total) failures.push(`${reveals.total - reveals.shown} reveal block(s) never became visible`);

    const tabBtn = await page.$('.tab-btn[data-tab="t2"]');
    if (!tabBtn) {
      failures.push('principles tab button [data-tab="t2"] not found');
    } else {
      await tabBtn.click();
      await page.waitForTimeout(250);
      const active = await page.evaluate(() => {
        const p = document.querySelector('.tab-panel[data-active]');
        return p ? p.id : null;
      });
      console.log(`ACTIVE_TAB_AFTER_CLICK=${active}`);
      if (active !== 't2') failures.push(`tab click did not activate t2 (got ${active})`);
    }
  } finally {
    await browser.close();
  }

  console.log('PAGE_ERRORS=' + (errors.length ? errors.join(' | ') : 'none'));
  console.log('WEBFONT_LOAD_FAILURES=' + (fontFailures.length
    ? `${fontFailures.length} (non-fatal, network-dependent): ${fontFailures.join(' | ')}`
    : 'none'));
  if (errors.length) failures.push(`${errors.length} page error(s) captured`);

  if (failures.length) {
    console.log('RESULT=FAIL');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('RESULT=PASS');
  }
})().catch(e => {
  console.log('RESULT=FAIL');
  console.log('  - uncaught: ' + e.message);
  process.exitCode = 1;
});
