const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  (async () => {
    const { createServer } = await import('vite');
    const server = await createServer({
      configFile: path.resolve(__dirname, '../apps/desktop/vite.config.ts'),
      appType: 'custom',
      server: { host: '127.0.0.1', port: 5211, strictPort: true, open: false },
    });
    server.middlewares.use('/__graph-scroll', async (_request, response, next) => {
      try {
        const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppShell, DSProvider } from '@fullstack-ai-infra/ui';
          import 'antd/dist/reset.css';
          import '@fullstack-ai-infra/ui/styles.css';
          import '@roleweave/ui/styles.css';
          ${['antd-skin', 'app', 'roleweave-theme', 'roleweave-components', 'roleweave-conversation', 'roleweave-data', 'workspace-polish', 'memory/memory-workspace', 'control-legibility'].map(file => `import '/src/${file}.css';`).join('\n')}
          import { RelationshipGraph } from '/src/graph/RelationshipGraph.tsx';
          const h = React.createElement;
          const evidence = { source: 'fixture', locator: 'fixture', basis: 'declared', observedAt: '2026-09-26T00:00:00Z' };
          const nodes = Array.from({ length: 24 }, (_, i) => ({ id: 'agent:' + i, kind: 'agent', label: 'Employee ' + i, state: 'ready', positionId: String(i), evidence, facts: Array.from({ length: 20 }, (_, n) => ({ key: 'Fact ' + n, value: 'Detail ' + n })) }));
          const data = { schemaVersion: 'relationship-graph.v1', workspaceId: 'scroll-fixture', revision: '1', generatedAt: evidence.observedAt, nodes, edges: nodes.slice(1).map((node, i) => ({ id: 'edge:' + i, source: nodes[0].id, target: node.id, kind: 'reports_to', evidence, permission: 'not_applicable' })), coverage: [{ source: 'fixture', state: 'error' }], truncated: false, limits: { nodes: 500, edges: 1000 } };
          function Fixture() {
            const [theme, setTheme] = React.useState('dark');
            window.setFixtureTheme = setTheme;
            React.useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
            return h(DSProvider, { mode: theme },
              h('div', { className: 'owb-app' }, h('header', { className: 'owb-wintitle' }, 'Graph scroll verification'),
                h(AppShell, { moduleRail: 'Modules', sidebar: 'Organization', topbar: 'Local test workspace' },
                  h('div', { className: 'owb-main' }, h('nav', { className: 'owb-org-views' }, 'Organization overview'),
                    h('div', { style: { display: 'contents' } }, h(RelationshipGraph, { data, loading: false, onReload() {}, onOpenAgent() {}, onOpenResource() {} }))))));
          }
          createRoot(document.getElementById('root')).render(h(Fixture));
        </script></body></html>`;
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/__graph-scroll', html));
      } catch (error) { next(error); }
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__graph-scroll`;
    if (process.argv.includes('--serve')) {
      console.log(url);
      process.on('SIGINT', async () => { await server.close(); process.exit(0); });
      process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
      return;
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roleweave-graph-scroll-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(require('electron'), [__filename, temp, url], { env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
      });
    } finally {
      await server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(process.argv[2], 'profile'));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
    win.webContents.debugger.attach('1.3');
    await win.loadURL(process.argv[3]);
    const evaluate = source => win.webContents.executeJavaScript(source);
    const waitFor = condition => evaluate(`new Promise((resolve, reject) => { const start = performance.now(); const check = () => { if (${condition}) return resolve(true); if (performance.now() - start > 10000) return reject(new Error('Timed out: ' + ${JSON.stringify(condition)})); requestAnimationFrame(check); }; check(); })`);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await waitFor('document.querySelector(".owb-rgraph__spatial-stage canvas") && document.querySelector(".owb-rgraph__spatial-label")');
    const failures = [];
    const check = (name, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } };
    const wheel = async (selector, deltaX, deltaY, modifiers = 0) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
      await frames();
      const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const baseline = await evaluate('document.querySelector(".owb-rgraph").scrollTop');
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY, modifiers });
      await frames();
      return baseline;
    };
    for (const [width, height] of [[1728, 936], [1280, 800], [960, 680], [640, 680]]) {
      win.setContentSize(width, height);
      await frames();
      const shell = await evaluate(`(() => { const shell = document.querySelector('.ui-app-shell').getBoundingClientRect(); const main = document.querySelector('.ui-app-shell__main').getBoundingClientRect(); return { right: shell.right, mainRight: main.right }; })()`);
      check(`${width}x${height}/shell`, () => assert.ok(Math.abs(shell.right - shell.mainRight) <= 1, 'main must fill the space beside the visible navigation without a blank grid track'));
      for (const theme of ['light', 'dark']) {
        await evaluate(`window.setFixtureTheme(${JSON.stringify(theme)})`);
        await frames();
        for (const mode of ['minimal', 'galaxy']) {
          await evaluate(`(() => { const buttons = document.querySelectorAll('.owb-rgraph__renderer button'); buttons[${mode === 'minimal' ? 0 : 1}].click(); document.querySelector('.owb-rgraph').scrollTop = 0; })()`);
          await frames();
          if (mode === 'minimal') {
            await evaluate(`document.querySelector('[aria-label="空间主题"] button:nth-child(${theme === 'light' ? 2 : 1})').click()`);
            await frames();
          }
          const label = `${width}x${height}/${theme}/${mode}`;
          const activeTheme = await evaluate(`({ shell: document.documentElement.dataset.theme, spatial: document.querySelector('.owb-rgraph__spatial').classList.contains('owb-rgraph__spatial--light') ? 'light' : 'dark' })`);
          check(label, () => { assert.equal(activeTheme.shell, theme); if (mode === 'minimal') assert.equal(activeTheme.spatial, theme); });
          const layout = await evaluate(`(() => { const graph = document.querySelector('.owb-rgraph'); const main = document.querySelector('.owb-main'); return { width: graph.clientWidth, client: graph.clientHeight, scroll: graph.scrollHeight, bottom: graph.getBoundingClientRect().bottom, mainBottom: main.getBoundingClientRect().bottom, overflow: getComputedStyle(graph).overflowY }; })()`);
          check(label, () => { assert.equal(layout.width > 940, width === 1728, 'cover both inspector layout breakpoints'); assert.ok(layout.bottom <= layout.mainBottom + 1, 'graph must fit its shell'); assert.ok(layout.scroll > layout.client, 'long graph must have reachable overflow'); assert.match(layout.overflow, /auto|scroll/); });
          const beforeWheel = await wheel('.owb-rgraph__spatial-stage canvas', 0, 180);
          const scrollTop = await evaluate('document.querySelector(".owb-rgraph").scrollTop');
          check(label, () => assert.ok(scrollTop > beforeWheel, 'wheel over canvas must scroll the overview'));
          await evaluate('document.querySelector(".owb-rgraph").scrollTop = 0');
          const input = await evaluate(`(() => { const canvas = document.querySelector('.owb-rgraph__spatial-stage canvas'); return [new WheelEvent('wheel', { deltaX: 120, bubbles: true, cancelable: true }), new WheelEvent('wheel', { deltaY: -30, ctrlKey: true, bubbles: true, cancelable: true })].map(event => { canvas.dispatchEvent(event); return event.defaultPrevented; }); })()`);
          check(label, () => { assert.equal(input[0], false, 'horizontal wheel must not be swallowed'); assert.equal(input[1], true, 'Ctrl+wheel must retain camera zoom'); });
          await evaluate('document.querySelector(".owb-rgraph__spatial-objects").scrollLeft = 0');
          await wheel('.owb-rgraph__spatial-objects', 160, 0);
          const horizontal = await evaluate('document.querySelector(".owb-rgraph__spatial-objects").scrollLeft');
          check(label, () => assert.ok(horizontal > 0, 'object strip must accept native horizontal wheel'));
          const paged = await evaluate(`(() => { const list = document.querySelector('.owb-rgraph__spatial-objects'); list.scrollLeft = 0; const next = document.querySelector('[aria-label="向右翻页"]'); if (!next) return false; next.click(); return true; })()`);
          check(label, () => assert.ok(paged, 'object strip must offer next-page control'));
          if (paged) {
            await frames();
            const nextPosition = await evaluate('document.querySelector(".owb-rgraph__spatial-objects").scrollLeft');
            check(label, () => assert.ok(nextPosition > 0, 'next page must move the object strip'));
            await evaluate('document.querySelector(\'[aria-label="向左翻页"]\').click()');
            await frames();
            const previousPosition = await evaluate('document.querySelector(".owb-rgraph__spatial-objects").scrollLeft');
            check(label, () => assert.ok(previousPosition < nextPosition, 'previous page must move the object strip back'));
          }
          const reached = await evaluate(`(() => { const graph = document.querySelector('.owb-rgraph'); graph.scrollTop = graph.scrollHeight; const footer = document.querySelector('.owb-rgraph__timestamp').getBoundingClientRect(); const bounds = graph.getBoundingClientRect(); return footer.top >= bounds.top && footer.bottom <= bounds.bottom; })()`);
          check(label, () => assert.ok(reached, 'bottom list footer must be reachable'));
          await evaluate('document.querySelector(".owb-rgraph__list button").click()');
          await frames();
          const detailsVisible = await evaluate(`(() => { const graph = document.querySelector('.owb-rgraph').getBoundingClientRect(); const header = document.querySelector('.owb-rgraph__inspector header').getBoundingClientRect(); return header.top >= graph.top && header.bottom <= graph.bottom; })()`);
          check(label, () => assert.ok(detailsVisible, 'selecting a lower result must keep the details header reachable'));
          const coveredDetails = await evaluate(`(() => { const inspector = document.querySelector('.owb-rgraph__inspector'), r = inspector.getBoundingClientRect(), g = document.querySelector('.owb-rgraph').getBoundingClientRect(); return [...document.querySelectorAll('.owb-rgraph__spatial-label')].some(el => { const b = el.getBoundingClientRect(), left = Math.max(b.left, r.left), right = Math.min(b.right, r.right), top = Math.max(b.top, r.top, g.top), bottom = Math.min(b.bottom, r.bottom, g.bottom); return right > left && bottom > top && !inspector.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)); }); })()`);
          check(label, () => assert.equal(coveredDetails, false, 'canvas labels must not cover the details panel'));
          await evaluate('document.querySelector(".owb-rgraph__inspector header button").click()');
          await frames();
          console.log(JSON.stringify({ label, layout, scrollTop, horizontal, reached, detailsVisible }));
        }
      }
    }
    check('browser console', () => assert.deepEqual(errors, []));
    assert.deepEqual(failures, []);
    console.log('Graph scrolling: 16 viewport/theme/mode combinations passed with real React and WebGL.');
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
