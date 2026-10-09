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
          const employees = Array.from({ length: 24 }, (_, i) => ({ id: 'agent:' + i, kind: 'agent', label: 'Employee ' + i, state: 'ready', positionId: String(i), evidence, facts: Array.from({ length: 20 }, (_, n) => ({ key: 'Fact ' + n, value: 'Detail ' + n })) }));
          const documentResource = { id: 'resource:brief', kind: 'resource', label: 'brief.md', state: 'ready', positionId: '0', resourcePath: 'knowledge/brief.md', evidence: { ...evidence, basis: 'observed' } };
          const nodes = [...employees, documentResource];
          const data = { schemaVersion: 'relationship-graph.v1', workspaceId: 'scroll-fixture', revision: '1', generatedAt: evidence.observedAt, nodes, edges: employees.slice(1).map((node, i) => ({ id: 'edge:' + i, source: employees[0].id, target: node.id, kind: 'reports_to', evidence, permission: 'not_applicable' })), coverage: [{ source: 'fixture', state: 'error' }], truncated: false, limits: { nodes: 500, edges: 1000 } };
          window.openedResources = [];
          function Fixture() {
            const [theme, setTheme] = React.useState('dark');
            window.setFixtureTheme = setTheme;
            React.useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
            return h(DSProvider, { mode: theme },
              h('div', { className: 'owb-app' }, h('header', { className: 'owb-wintitle' }, 'Graph scroll verification'),
                h(AppShell, { moduleRail: 'Modules', sidebar: 'Organization', topbar: 'Local test workspace' },
                  h('div', { className: 'owb-main' }, h('nav', { className: 'owb-org-views' }, 'Organization overview'),
                    h('div', { style: { display: 'contents' } }, h(RelationshipGraph, { data, loading: false, onReload() {}, onOpenAgent() {}, onOpenResource(positionId, resourcePath) { window.openedResources.push([positionId, resourcePath]); } }))))));
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
    await waitFor('document.querySelector(".owb-rgraph__renderer button")');
    await evaluate(`Array.from(document.querySelectorAll('.owb-rgraph__renderer button')).find(button => button.textContent === '极简关系图').click()`);
    await waitFor('document.querySelector(".owb-rgraph__spatial-stage canvas") && document.querySelector(".owb-rgraph__spatial-label")');
    const failures = [];
    const check = (name, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } };
    const wheel = async (selector, scrollSelector, deltaX, deltaY, modifiers = 0) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
      await frames();
      const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); const pane = document.querySelector(${JSON.stringify(scrollSelector)}).getBoundingClientRect(); const left = Math.max(r.left, pane.left, 0), right = Math.min(r.right, pane.right, innerWidth), top = Math.max(r.top, pane.top, 0), bottom = Math.min(r.bottom, pane.bottom, innerHeight); if (right <= left || bottom <= top) throw new Error('Wheel target is outside its pane'); return { x: (left + right) / 2, y: (top + bottom) / 2 }; })()`);
      const baseline = await evaluate(`document.querySelector(${JSON.stringify(scrollSelector)}).scrollTop`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY, modifiers });
      await frames();
      return baseline;
    };
    const pressEnter = async () => {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      await frames();
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
          await evaluate(mode === 'minimal'
            ? "Array.from(document.querySelectorAll('.owb-rgraph__renderer button')).find(button => button.textContent === '极简关系图').click(); document.querySelector('.owb-rgraph').scrollTop = 0;"
            : "Array.from(document.querySelectorAll('.owb-rgraph__renderer button')).find(button => button.textContent === '空间关系图').click(); document.querySelector('.owb-rgraph').scrollTop = 0;");
          await frames();
          if (mode === 'minimal') {
            await evaluate(`document.querySelector('[aria-label="空间主题"] button:nth-child(${theme === 'light' ? 2 : 1})').click()`);
            await frames();
          }
          const label = `${width}x${height}/${theme}/${mode}`;
          const activeTheme = await evaluate(`({ shell: document.documentElement.dataset.theme, spatial: document.querySelector('.owb-rgraph__spatial').classList.contains('owb-rgraph__spatial--light') ? 'light' : 'dark' })`);
          check(label, () => { assert.equal(activeTheme.shell, theme); if (mode === 'minimal') assert.equal(activeTheme.spatial, theme); });
          const layout = await evaluate(`(() => { const graph = document.querySelector('.owb-rgraph'); const shell = document.querySelector('.owb-main'); const workspace = document.querySelector('.owb-rgraph__workspace'); const main = document.querySelector('.owb-rgraph__main'); const list = document.querySelector('.owb-rgraph__list'); const navigation = document.querySelector('.owb-rgraph__object-navigation'); return { width: graph.clientWidth, client: graph.clientHeight, scroll: graph.scrollHeight, bottom: graph.getBoundingClientRect().bottom, mainBottom: shell.getBoundingClientRect().bottom, workspaceBottom: workspace.getBoundingClientRect().bottom, overflow: getComputedStyle(graph).overflowY, paneOverflow: getComputedStyle(main).overflowY, paneClient: main.clientHeight, paneScroll: main.scrollHeight, listClient: list.clientHeight, listScroll: list.scrollHeight, objectCount: list.querySelectorAll('button').length, stripPresent: !!navigation }; })()`);
          check(label, () => {
            assert.equal(layout.width > 940, width === 1728, 'cover both inspector layout breakpoints');
            assert.ok(layout.bottom <= layout.mainBottom + 1, 'graph must fit its shell');
            assert.ok(layout.workspaceBottom <= layout.bottom + 1, 'workspace must fit the bounded root');
            assert.ok(layout.scroll <= layout.client + 2, 'columns must own overflow instead of growing a page below the shell');
            assert.equal(layout.overflow, 'hidden');
            assert.match(layout.paneOverflow, /auto|scroll/);
            assert.equal(layout.stripPresent, false, 'formal graph must not render duplicate filmstrip navigation');
            assert.equal(layout.objectCount, 25, 'the unique Sidebar must retain every projected fixture object');
            assert.ok(layout.listClient > 0 && layout.listScroll > layout.listClient, 'a long Sidebar must have reachable list overflow');
          });
          await evaluate("document.querySelector('.owb-rgraph__list').scrollTop = 0; document.querySelector('.owb-rgraph__main').scrollTop = 0");
          const beforeListWheel = await wheel('.owb-rgraph__list', '.owb-rgraph__list', 0, 180);
          const listScrollTop = await evaluate('document.querySelector(".owb-rgraph__list").scrollTop');
          check(label, () => assert.ok(listScrollTop > beforeListWheel, 'ordinary wheel must scroll the Sidebar list'));
          const beforeWheel = await wheel('.owb-rgraph__spatial-stage canvas', '.owb-rgraph__main', 0, 180);
          const paneScrollTop = await evaluate('document.querySelector(".owb-rgraph__main").scrollTop');
          check(label, () => { if (layout.paneScroll > layout.paneClient + 1) assert.ok(paneScrollTop > beforeWheel, 'wheel over an overflowing canvas must scroll its center pane'); });
          await evaluate('document.querySelector(".owb-rgraph__main").scrollTop = 0');
          const input = await evaluate(`(() => { const canvas = document.querySelector('.owb-rgraph__spatial-stage canvas'); return [new WheelEvent('wheel', { deltaX: 120, bubbles: true, cancelable: true }), new WheelEvent('wheel', { deltaY: -30, ctrlKey: true, bubbles: true, cancelable: true })].map(event => { canvas.dispatchEvent(event); return event.defaultPrevented; }); })()`);
          check(label, () => { assert.equal(input[0], false, 'horizontal wheel must not be swallowed'); assert.equal(input[1], true, 'Ctrl+wheel must retain camera zoom'); });
          const reached = await evaluate(`(() => { const pane = document.querySelector('.owb-rgraph__main'); pane.scrollTop = pane.scrollHeight; const footer = document.querySelector('.owb-rgraph__timestamp').getBoundingClientRect(); const bounds = pane.getBoundingClientRect(); return footer.top >= bounds.top - 1 && footer.bottom <= bounds.bottom + 1; })()`);
          check(label, () => assert.ok(reached, 'center-pane footer must remain reachable'));
          const keyboardReachable = await evaluate(`(() => { const list = document.querySelector('.owb-rgraph__list'); const button = [...list.querySelectorAll('button')].find(button => button.textContent.includes('brief.md')); window.openedResources = []; button.focus(); button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const row = button.getBoundingClientRect(), bounds = list.getBoundingClientRect(); return document.activeElement === button && row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1; })()`);
          check(label, () => assert.ok(keyboardReachable, 'the last resource must be reachable and focusable in the Sidebar'));
          await pressEnter();
          const openedBeforeAction = await evaluate('window.openedResources');
          check(label, () => assert.deepEqual(openedBeforeAction, [], 'keyboard selection must inspect without opening a resource'));
          await evaluate(`Array.from(document.querySelectorAll('.owb-rgraph__inspector button')).find(button => button.textContent === '打开文档').click()`);
          const opened = await evaluate('window.openedResources');
          check(label, () => assert.deepEqual(opened, [['0', 'knowledge/brief.md']], 'resource action must preserve exact owner and path'));
          await evaluate(`Array.from(document.querySelectorAll('.owb-rgraph__list button')).find(button => button.textContent.startsWith('Employee 23')).focus()`);
          await pressEnter();
          await frames();
          const detailsVisible = await evaluate(`(() => { const graph = document.querySelector('.owb-rgraph').getBoundingClientRect(); const header = document.querySelector('.owb-rgraph__inspector header').getBoundingClientRect(); return header.top >= graph.top && header.bottom <= graph.bottom; })()`);
          check(label, () => assert.ok(detailsVisible, 'selecting a lower result must keep the details header reachable'));
          await evaluate('document.querySelector(".owb-rgraph__inspector").scrollTop = 0');
          const beforeDetailsWheel = await wheel('.owb-rgraph__inspector', '.owb-rgraph__inspector', 0, 180);
          const detailScrollTop = await evaluate('document.querySelector(".owb-rgraph__inspector").scrollTop');
          check(label, () => assert.ok(detailScrollTop > beforeDetailsWheel, 'long metadata must scroll in the evidence pane'));
          const coveredDetails = await evaluate(`(() => { const inspector = document.querySelector('.owb-rgraph__inspector'), r = inspector.getBoundingClientRect(), g = document.querySelector('.owb-rgraph').getBoundingClientRect(); return [...document.querySelectorAll('.owb-rgraph__spatial-label')].some(el => { const b = el.getBoundingClientRect(), left = Math.max(b.left, r.left), right = Math.min(b.right, r.right), top = Math.max(b.top, r.top, g.top), bottom = Math.min(b.bottom, r.bottom, g.bottom); return right > left && bottom > top && !inspector.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)); }); })()`);
          check(label, () => assert.equal(coveredDetails, false, 'canvas labels must not cover the details panel'));
          await evaluate('document.querySelector(".owb-rgraph__inspector header button").click()');
          await frames();
          const focusReturned = await evaluate('document.activeElement === document.querySelector(".owb-rgraph__results") && document.querySelector(".owb-rgraph__inspector").hidden');
          check(label, () => assert.ok(focusReturned, 'closing evidence must return focus to the visible Sidebar results'));
          console.log(JSON.stringify({ label, layout, listScrollTop, paneScrollTop, reached, detailsVisible, detailScrollTop, opened, focusReturned }));
        }
      }
    }
    check('browser console', () => assert.deepEqual(errors, []));
    assert.deepEqual(failures, []);
    console.log('Graph panes: 16 viewport/theme/mode combinations passed with real Sidebar keyboard navigation and WebGL.');
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
