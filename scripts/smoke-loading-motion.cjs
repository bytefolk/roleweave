const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roleweave-motion-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename, temp], {
      env, encoding: 'utf8', timeout: 60000,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = require('electron');
  const temp = process.argv[2];
  app.setPath('userData', path.join(temp, 'profile'));
  app.whenReady().then(async () => {
    const renderer = path.resolve(__dirname, '../apps/desktop/dist/renderer');
    const index = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
    const styles = [...index.matchAll(/<link\b[^>]*>/g)]
      .map(([tag]) => tag.match(/href="([^"]+\.css)"/)?.[1])
      .filter(Boolean);
    assert.ok(styles.length, 'build:renderer must emit a stylesheet');
    const fixture = path.join(temp, 'motion.html');
    fs.writeFileSync(fixture, `<!doctype html><html data-theme="light"><head>
      ${styles.map((file) => `<link rel="stylesheet" href="${pathToFileURL(path.resolve(renderer, file)).href}">`).join('\n')}
      </head><body><div class="owb-app"><div class="owb-turn-panel">
      <span class="owb-turn-progress__summary-spinner"><span class="owb-turn-progress__summary-spinner-track"></span><i class="owb-turn-progress__summary-spinner-dot"></i></span>
      <div class="owb-turn-progress" data-motion="live"><ol class="owb-turn-progress__steps"><li class="owb-turn-progress__step"><span class="owb-turn-progress__activity-orbit"></span></li></ol></div>
      </div></div><span class="owb-project-dialog__spinner"><span></span><i></i></span></body></html>`);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    win.webContents.debugger.attach('1.3');
    await win.loadFile(fixture);
    const failures = [];
    for (const reduced of [false, true]) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
      });
      for (const theme of ['light', 'dark']) {
        const result = await win.webContents.executeJavaScript(`(async () => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          const selectors = ['.owb-project-dialog__spinner', '.owb-turn-progress__summary-spinner'];
          const elements = selectors.map(selector => document.querySelector(selector));
          const samples = selectors.map(() => []);
          const end = performance.now() + 1100;
          do {
            await new Promise(requestAnimationFrame);
            elements.forEach((el, i) => samples[i].push(getComputedStyle(el).transform));
          } while (performance.now() < end);
          return {
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            spinners: elements.map((el, i) => {
              const style = getComputedStyle(el);
              return { selector: selectors[i], name: style.animationName, duration: style.animationDuration,
                iterations: style.animationIterationCount, timing: style.animationTimingFunction,
                frames: new Set(samples[i]).size, running: el.getAnimations().some(a => a.playState === 'running') };
            }),
            decorativeRunning: [...document.querySelectorAll('.owb-turn-progress__step, .owb-turn-progress__activity-orbit, .owb-turn-progress__steps')]
              .some(el => el.getAnimations().some(a => a.playState === 'running')),
          };
        })()`);
        console.log(JSON.stringify({ theme, ...result }));
        try {
          assert.equal(result.reduced, reduced);
          for (const spinner of result.spinners) {
            assert.ok(spinner.frames > 1, `${theme}/${reduced}: ${spinner.selector} must visibly change across frames`);
            assert.equal(spinner.running, true);
            assert.equal(spinner.iterations, 'infinite');
            assert.ok(parseFloat(spinner.duration) >= (reduced ? 2 : 0.1));
            if (reduced) assert.match(spinner.timing, /^steps\(/);
          }
          if (reduced) assert.equal(result.decorativeRunning, false, 'decorative motion must remain disabled');
        } catch (error) {
          failures.push(error.message);
        }
      }
    }
    assert.deepEqual(failures, []);
    console.log('Loading motion: 4 theme/motion combinations passed in Electron.');
    app.exit(0);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
