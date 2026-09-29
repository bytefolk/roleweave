const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  const entry = process.argv[2] ?? path.resolve(__dirname, '../apps/desktop/dist/renderer/index.html');
  const expected = pathToFileURL(path.resolve(entry)).href;
  const target = targets.find(page => page.type === 'page' && page.url === expected);
  assert.ok(target, 'start the target Electron app with --remote-debugging-port=9333');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async (selector, name) => {
    await evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(button => (button.getAttribute('aria-label') ?? button.textContent.trim()) === ${JSON.stringify(name)}); if (!button) throw new Error('Missing navigation: ' + ${JSON.stringify(name)}); button.click(); })()`);
    await frames();
  };
  const checks = [];
  const unavailableMenus = [];
  try {
    await send('Runtime.enable');
    for (const width of [1280, 960, 705, 704, 681, 680, 640]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      const narrow = await evaluate("matchMedia('(max-width: 44rem)').matches");
      for (const name of ['组织', '项目', '收件箱', '设置', '协作']) {
        await click('.ui-module-rail button', name);
        const layout = await evaluate(`(() => { const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width }; }; const sidebar = document.querySelector('.ui-app-shell__sidebar'); return { rail:rect('.ui-app-shell__rail'), main:rect('.ui-app-shell__main'), shell:rect('.ui-app-shell'), sidebarVisible:!!sidebar && getComputedStyle(sidebar).display !== 'none', switchers:document.querySelectorAll('[aria-label="项目入口"]').length }; })()`);
        assert.equal(layout.switchers, 1, `${name}: global workspace picker`);
        const menuVisible = await evaluate(`(() => { const menu = document.querySelector('.owb-project-location .owb-tree-more'); return !!menu && getComputedStyle(menu).opacity === '1' && menu.getBoundingClientRect().width > 0; })()`);
        if (!menuVisible) unavailableMenus.push(`${width}/${name}`);
        assert.equal(layout.sidebarVisible, name === '协作' && !narrow, `${name}: sidebar visibility`);
        assert.ok(Math.abs(layout.main.right - layout.shell.right) <= 1, `${name}: main fills right edge`);
        if (name !== '协作' || narrow) assert.ok(Math.abs(layout.main.left - layout.rail.right) <= 1, `${width}/${name}: no empty contact column`);
        const children = name === '项目' ? ['目标', '进度', '项目管理'] : name === '收件箱' ? ['上报', '审批'] : name === '组织' ? ['关系图谱', '组织架构'] : [];
        for (const child of children) {
          await click('.owb-context-header button', child);
          const context = await evaluate(`(() => { const main = document.querySelector('.ui-app-shell__main').getBoundingClientRect(); const rail = document.querySelector('.ui-app-shell__rail').getBoundingClientRect(); return { gap:main.left-rail.right, active:document.querySelector('.ui-module-rail [aria-current="page"]')?.getAttribute('aria-label'), contacts:!!document.querySelector('.ui-sidebar') }; })()`);
          assert.equal(context.active, name, `${child}: primary context remains selected`);
          assert.equal(context.contacts, false, `${child}: no employee sidebar`);
          assert.ok(Math.abs(context.gap) <= 1, `${child}: no empty contact column`);
          checks.push(`${width}/${name}/${child}`);
        }
        if (name === '协作') {
          if (narrow) {
            await click('.owb-contacts-toggle', '通讯录');
            assert.equal(await evaluate('getComputedStyle(document.querySelector(".ui-app-shell__sidebar")).display !== "none"'), true);
            const focusedContacts = await evaluate(`(() => { const app = document.querySelector('.owb-app'); app.classList.add('is-conversation-focused'); const visible = getComputedStyle(document.querySelector('.ui-app-shell__sidebar')).display !== 'none'; app.classList.remove('is-conversation-focused'); return visible; })()`);
            assert.ok(focusedContacts, 'explicit narrow contacts opening wins over focus-mode CSS');
          }
          await click('[aria-label="协作方式"] button', '群聊');
          await frames();
          const groups = await evaluate(`(() => { const list=document.querySelector('.owb-group-list-host .owb-groups__list'); const panel=document.querySelector('.owb-groups__panel'); return { hosted:!!list, duplicated:document.querySelectorAll('.owb-groups__list').length, width:panel?.getBoundingClientRect().width, mainWidth:document.querySelector('.owb-main').getBoundingClientRect().width }; })()`);
          assert.ok(groups.hosted, 'group list lives in the collaboration sidebar');
          assert.equal(groups.duplicated, 1, 'one group-list controller');
          assert.ok(groups.width > groups.mainWidth * 0.85, 'group conversation has no second list column');
          if (narrow) await click('.owb-contacts-toggle', '群聊列表');
          await click('[aria-label="协作方式"] button', '单聊');
        }
        checks.push(`${width}/${name}`);
      }
    }
    for (const width of [1280, 704, 640]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await frames();
      const compact = await evaluate(`(() => {
        const header=document.querySelector('.owb-context-header--employee'),panel=document.querySelector('.owb-turn-panel--embedded');
        const rect=header?.getBoundingClientRect();
        const controls=[...header.querySelectorAll('button')].filter(button=>button.getBoundingClientRect().width>0);
        const boxes=controls.map(button=>button.getBoundingClientRect());
        return {headerHeight:rect.height,duplicateHeader:!!panel?.querySelector('.owb-turn-panel__header'),border:panel&&getComputedStyle(panel).borderTopWidth,threadBackground:getComputedStyle(panel.querySelector('.owb-turn-thread')).backgroundColor,
          controlsInside:boxes.every(r=>r.left>=rect.left-1&&r.right<=rect.right+1&&r.top>=rect.top-1&&r.bottom<=rect.bottom+1),
          overlap:boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)),
          primaryTabs:header.querySelectorAll('[aria-label="员工视图"] .ant-btn-primary').length,
          overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
      assert.equal(compact.duplicateHeader, false, `${width}: no repeated conversation header`);
      assert.equal(compact.border, '0px', `${width}: embedded conversation has no card frame`);
      assert.equal(compact.threadBackground, 'rgba(0, 0, 0, 0)', `${width}: transcript shares the page surface`);
      assert.equal(compact.primaryTabs, 0, `${width}: navigation is not styled as primary actions`);
      assert.equal(compact.controlsInside, true, `${width}: conversation actions fit their header`);
      assert.equal(compact.overlap, false, `${width}: header actions do not overlap`);
      assert.equal(compact.overflow, false, `${width}: no horizontal page overflow`);
      if(width===1280)assert.ok(compact.headerHeight<=50, 'desktop has one compact navigation row');
      const positions = await evaluate(`(() => {
        const name = document.querySelector('.owb-context-header__name');
        const original = name.textContent;
        try {
          return ['CEO', 'Digital Employee Quickstart 项目负责人', '这是一个用于验证页签稳定性的超长员工名称'].map(text => {
            name.textContent = text;
            const buttons = [...document.querySelectorAll('[aria-label="员工视图"] button')];
            if (buttons.length !== 3 || buttons.some(button => button.getBoundingClientRect().height === 0)) throw new Error('Expected three visible employee tabs');
            return buttons.map(button => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, top: rect.top };
            });
          });
        } finally { name.textContent = original; }
      })()`);
      for (const position of positions.slice(1)) {
        for (let index = 0; index < position.length; index += 1) {
          assert.ok(Math.abs(position[index].left - positions[0][index].left) <= 1, `${width}: employee name must not move tabs horizontally`);
          assert.ok(Math.abs(position[index].top - positions[0][index].top) <= 1, `${width}: employee name must not move tabs vertically`);
        }
      }
      checks.push(`${width}/stable-employee-tabs`);
    }
    await send('Emulation.clearDeviceMetricsOverride');
    await frames();
    const narrow = await evaluate("matchMedia('(max-width: 44rem)').matches");
    if(narrow)await click('.owb-contacts-toggle', '通讯录');
    const sidebar = await evaluate(`(() => {
      const header=document.querySelector('.ui-sidebar__header'),search=document.querySelector('.ui-org-tree__search');
      return {height:header.getBoundingClientRect().height,gap:search.getBoundingClientRect().top-header.getBoundingClientRect().bottom,
        duplicate:!!header.querySelector('strong'),directActions:[...header.querySelectorAll('button')].some(b=>['创建员工','撤销'].includes(b.textContent))};
    })()`);
    assert.ok(sidebar.height<=52 && sidebar.gap<=20, 'contacts controls stay compact above the search field');
    assert.equal(sidebar.duplicate, false, 'no repeated collaboration heading');
    assert.equal(sidebar.directActions, false, 'infrequent directory actions stay in the menu');
    await click('.owb-collaboration-toolbar button', '通讯录操作');
    const menu = await evaluate(`new Promise((resolve,reject)=>{const started=Date.now();function check(){const items=[...document.querySelectorAll('[role=menuitem]')].filter(e=>e.getBoundingClientRect().height>0);if(items.length)return resolve(items.map(e=>e.textContent));if(Date.now()-started>5000)return reject(Error('Contact menu did not open'));requestAnimationFrame(check)}check()})`);
    assert.deepEqual(menu, ['创建员工','撤销']);
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    if(narrow)await click('.owb-contacts-close', '关闭侧栏');
    assert.deepEqual(errors, []);
    assert.deepEqual(unavailableMenus, [], 'global project menu is visibly discoverable');
    console.log(`Navigation: ${checks.length} live-app context/viewport checks passed.`);
  } finally {
    await send('Emulation.clearDeviceMetricsOverride');
    socket.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
