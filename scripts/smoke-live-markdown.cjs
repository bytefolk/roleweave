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
      server: { host: '127.0.0.1', port: 5216, strictPort: true, open: false },
    });
    server.middlewares.use('/__live-markdown', async (_request, response, next) => {
      try {
        const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title>正文即时编辑 · 本地验收</title></head><body><div id="root"></div><script type="module">
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppShell, DSProvider } from '@fullstack-ai-infra/ui';
          import 'antd/dist/reset.css'; import '@fullstack-ai-infra/ui/styles.css'; import '@roleweave/ui/styles.css';
          ${['antd-skin', 'app', 'roleweave-theme', 'roleweave-components', 'roleweave-conversation', 'roleweave-data', 'workspace-polish', 'memory/memory-workspace', 'control-legibility'].map(file => `import '/src/${file}.css';`).join('\n')}
          import { DocsPanel } from '/src/docs/DocsPanel.tsx';
          const h=React.createElement;
          const initial=${JSON.stringify('# 即时编辑\n\n直接在正文中输入，标题、**粗体**和列表会原地呈现。\n\n## 今天的计划\n\n- 整理知识\n- [ ] 验证自动保存\n\n| 项目 | 状态 |\n| --- | --- |\n| 正文编辑 | 可以直接修改 |\n\n[第二篇](./SECOND.md) · [[SECOND]]\n\n```js\nconst ready = true;\n```\n')};
          let revision=1;
          const files=new Map([['knowledge/README.md',initial],['knowledge/SECOND.md',${JSON.stringify('# 第二篇\n\n另一篇文档。\n')}],['SKILL.md',${JSON.stringify('# 只读绑定文档\n')}]]);
          const versions=new Map([...files.keys()].map(key=>[key,'2026-09-26T00:00:01.000Z']));
          const responseFor=(file)=>({schemaVersion:'docs-file.v1',positionId:'editor-fixture',path:file,content:files.get(file),version:versions.get(file),modifiedAt:versions.get(file),size:files.get(file).length});
          const listDocs=async()=>({schemaVersion:'docs-file-list.v1',positionId:'editor-fixture',files:[...files.keys()].map(file=>({path:file,kind:'file',size:files.get(file).length,modifiedAt:versions.get(file)}))});
          const readDoc=async(_id,file)=>responseFor(file);
          window.fixtureWrites=[];
          const writeDoc=async(id,file,content,version)=>{
            if(version!==versions.get(file))throw Object.assign(new Error('文档已在外部更新'),{name:'DocsConflictError'});
            files.set(file,content);versions.set(file,new Date(Date.UTC(2026,8,26,0,0,++revision)).toISOString());
            window.fixtureWrites.push({id,file,content,version});return responseFor(file);
          };
          window.fixtureContent=(file='knowledge/README.md')=>files.get(file);
          window.fixtureRenames=[]; window.fixtureDeletes=[];
          const renameDoc=async(_id,from,to)=>{
            if(files.has(to))throw new Error('文档已存在');
            files.set(to,files.get(from));versions.set(to,versions.get(from));files.delete(from);versions.delete(from);
            window.fixtureRenames.push({from,to});return {to};
          };
          const deleteDoc=async(_id,file)=>{window.fixtureDeletes.push(file);files.delete(file);versions.delete(file);};
          function Fixture(){
            const [theme,setTheme]=React.useState('dark'),[writable,setWritable]=React.useState(true),[reload,setReload]=React.useState(0);
            React.useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
            window.fixtureExternalUpdate=(content)=>{files.set('knowledge/README.md',content);versions.set('knowledge/README.md',new Date(Date.UTC(2026,8,26,0,0,++revision)).toISOString());setReload(n=>n+1);};
            return h(DSProvider,{mode:theme},h('div',{className:'owb-app is-sidebarless-module'},
              h('header',{className:'owb-wintitle'},'正文即时编辑 · 隔离测试数据，不修改你的文档'),
              h(AppShell,{moduleRail:'文档',topbar:h('div',null,h('button',{onClick:()=>setTheme(t=>t==='dark'?'light':'dark')},'切换主题'),h('button',{onClick:()=>setWritable(v=>!v)},writable?'切为只读':'允许编辑'))},
                h('div',{className:'owb-main'},h('div',{className:'owb-memory-module'},h('div',{className:'owb-memory-module__body'},h('div',{className:'owb-memory-workspace'},h(DocsPanel,{knowledgeFirst:true,positionId:'editor-fixture',listDocs,readDoc,writeDoc:writable?writeDoc:undefined,renameDoc:writable?renameDoc:undefined,deleteDoc:writable?deleteDoc:undefined,reloadToken:reload}))))))));
          }
          createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Fixture)));
        </script></body></html>`;
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/__live-markdown', html));
      } catch (error) { next(error); }
    });
    await server.listen();
    const url = 'http://127.0.0.1:5216/__live-markdown';
    if (process.argv.includes('--serve')) {
      console.log(url);
      for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await server.close(); process.exit(0); });
      return;
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roleweave-live-markdown-'));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(require('electron'), [__filename, temp, url], { env, stdio: 'inherit' });
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
    } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(process.argv[2], 'profile'));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const errors = [], remoteRequests = [], warnings = new Set();
    win.webContents.on('console-message', event => {
      if (/^Warning: \[antd: (List|Alert)\]/.test(event.message)) warnings.add(event.message);
      else if (event.level === 'error') errors.push(event.message);
    });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const remote = /^https?:/.test(details.url) && new URL(details.url).hostname !== '127.0.0.1';
      if (remote) remoteRequests.push(details.url);
      callback({ cancel: remote });
    });
    await win.loadURL(process.argv[3]);
    const evaluate = source => win.webContents.executeJavaScript(source);
    const waitFor = condition => evaluate(`new Promise((resolve,reject)=>{const start=performance.now();const check=()=>{if(${condition})return resolve(true);if(performance.now()-start>10000)return reject(new Error('Timed out: '+${JSON.stringify(condition)}));requestAnimationFrame(check);};check();})`);
    const click = text => evaluate(`[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.replace(/\\s/g,'')===${JSON.stringify(text)}).click()`);
    const documentAction = async text => {
      await waitFor('document.querySelector("button[aria-label=更多文档操作]")&&!document.querySelector("button[aria-label=更多文档操作]").disabled');
      await evaluate('document.querySelector("button[aria-label=更多文档操作]").click()');
      await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.offsetParent!==null&&e.textContent.replace(/\\s/g,'')===${JSON.stringify(text)})`);
      await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.offsetParent!==null&&e.textContent.replace(/\\s/g,'')===${JSON.stringify(text)}).click()`);
    };
    const editor = '[contenteditable="true"][aria-label="文档内容"]';
    await waitFor(`document.querySelector('${editor} h1')`);
    assert.equal(await evaluate('document.querySelectorAll("[role=toolbar][aria-label=文档工具栏]").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll("[role=toolbar][aria-label=文档工具栏] button").length'), 2);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${editor} h1'),'::before').content`), 'none', 'no H-level chips in the gutter');
    assert.equal(await evaluate('window.fixtureWrites.length'), 0);
    assert.equal(await evaluate(`document.querySelectorAll('${editor}').length`), 1);
    assert.equal(await evaluate('document.querySelectorAll(".owb-doc-viewer__body").length'), 0);
    await evaluate(`(()=>{const el=document.querySelector('${editor} h1');el.closest('[contenteditable]').focus();const range=document.createRange();range.selectNodeContents(el.lastChild);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
    await win.webContents.insertText('标题已经修改');
    await waitFor('window.fixtureWrites.length>0');
    assert.ok((await evaluate('window.fixtureContent()')).includes('# 标题已经修改'));
    assert.ok((await evaluate('window.fixtureContent()')).includes('[[SECOND]]'));
    const savedCount = await evaluate('window.fixtureWrites.length');
    await documentAction('源码');
    await waitFor('document.querySelector("textarea[aria-label=文档内容]")');
    assert.ok((await evaluate('document.querySelector("textarea[aria-label=文档内容]").value')).includes('# 标题已经修改'));
    await documentAction('阅读');
    await waitFor('document.querySelector(".owb-doc-viewer__body h1")');
    assert.equal(await evaluate(`document.querySelector('${editor}')`), null);
    await documentAction('即时编辑');
    await waitFor(`document.querySelector('${editor} h1')`);
    assert.equal(await evaluate('window.fixtureWrites.length'), savedCount);
    const cell = `${editor} tbody td`;
    await evaluate(`(()=>{const el=document.querySelector('${cell}');el.closest('[contenteditable]').focus();const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
    await win.webContents.insertText('表格也能编辑');
    await waitFor('window.fixtureContent().includes("表格也能编辑")');
    win.show();
    win.focus();
    await waitFor('document.hasFocus()');
    await documentAction('阅读');
    await waitFor('document.querySelector(".owb-doc-viewer__body")');
    assert.equal(await evaluate(`document.querySelector('${editor}')`), null);
    await documentAction('即时编辑');
    await waitFor(`document.querySelector('${editor}')`);
    const modifier = process.platform === 'darwin' ? 'meta' : 'control';
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Z',modifiers:[modifier]});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Z',modifiers:[modifier]});
    await waitFor('!window.fixtureContent().includes("表格也能编辑")');
    await documentAction('阅读');
    await documentAction('即时编辑');
    await waitFor(`document.querySelector('${editor}')`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Z',modifiers:[modifier,'shift']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Z',modifiers:[modifier,'shift']});
    await waitFor('window.fixtureContent().includes("表格也能编辑")');
    await click('切为只读');
    await waitFor('document.querySelector(".owb-doc-viewer__body")');
    assert.equal(await evaluate(`document.querySelector('${editor}')`), null);
    assert.equal(await evaluate('!!document.querySelector(".owb-docs-panel__mode-switch")'), false);
    await click('允许编辑');
    await waitFor(`document.querySelector('${editor} h1')`);
    await evaluate(`window.fixtureExternalUpdate(${JSON.stringify('# 外部更新\n\n加载新的正文。\n')})`);
    await waitFor(`document.querySelector('${editor}').textContent.includes('外部更新')`);
    const writesBeforeComposition = await evaluate('window.fixtureWrites.length');
    await evaluate(`(()=>{const el=document.querySelector('${editor}');el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.querySelector('h1').lastChild.textContent='合成中的修改';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true}));window.fixtureExternalUpdate(${JSON.stringify('# 外部冲突版本\n')});})()`);
    await waitFor('document.body.textContent.includes("文档已在外部更新")');
    assert.equal(await evaluate('window.fixtureWrites.length'), writesBeforeComposition);
    await evaluate(`document.querySelector('${editor}').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'合成中的修改'}))`);
    await click('比较');
    assert.ok((await evaluate('document.querySelector("[aria-label=版本比较]").textContent')).includes('合成中的修改'));
    assert.ok((await evaluate('document.querySelector("[aria-label=版本比较]").textContent')).includes('外部冲突版本'));
    await click('重新加载');
    await waitFor(`document.querySelector('${editor}').textContent.includes('外部冲突版本')`);
    assert.equal(await evaluate('window.fixtureWrites.length'), writesBeforeComposition);
    await evaluate(`window.fixtureExternalUpdate(${JSON.stringify('\n')})`);
    await waitFor(`document.querySelector('${editor}').textContent.trim()===''`);
    await evaluate(`document.querySelector('${editor}').focus()`);
    await win.webContents.insertText('# ');
    await win.webContents.insertText('从空白开始');
    await waitFor(`document.querySelector('${editor} h1')?.textContent.includes('从空白开始')`);
    win.show();
    win.focus();
    await waitFor('document.hasFocus()');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    try {
      await waitFor(`document.querySelector('${editor} p')`);
    } catch (error) {
      console.error(await evaluate(`JSON.stringify({html:document.querySelector('${editor}').outerHTML,active:document.activeElement?.outerHTML,selection:getSelection()?.toString()})`));
      throw error;
    }
    await win.webContents.insertText('- ');
    await win.webContents.insertText('即时列表');
    try {
      await waitFor(`document.querySelector('${editor} li')?.textContent.includes('即时列表')`);
    } catch (error) {
      console.error(await evaluate(`document.querySelector('${editor}').outerHTML`));
      throw error;
    }
    await waitFor('window.fixtureContent().includes("即时列表")');
    for (const [key, text] of [['B', '粗体快捷键'], ['I', '斜体快捷键']]) {
      await evaluate(`window.fixtureExternalUpdate(${JSON.stringify('# 格式快捷键\n\n')}+${JSON.stringify(text)}+'\\n')`);
      await waitFor(`document.querySelector('${editor} p')?.textContent.includes(${JSON.stringify(text)})`);
      await evaluate(`(()=>{const root=document.querySelector('${editor}'),p=root.querySelector('p');root.focus();const range=document.createRange();range.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(range)})()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:[modifier]});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:[modifier]});
      await waitFor(key === 'B' ? `window.fixtureContent().includes('**${text}**')` : `window.fixtureContent().includes('*${text}*')||window.fixtureContent().includes('_${text}_')`);
    }
    const selectParagraph = waitText => evaluate(`(()=>{const root=document.querySelector('${editor}'),p=[...root.querySelectorAll('p,li')].find(n=>n.textContent.includes(${JSON.stringify(waitText)}));root.focus();const range=document.createRange();range.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(range)})()`);
    const externalUpdate = async (content, waitText) => {
      await evaluate(`window.fixtureExternalUpdate(${JSON.stringify(content)})`);
      await waitFor(`document.querySelector('${editor}').textContent.includes(${JSON.stringify(waitText)})`);
    };
    const press = (keyCode, modifiers) => {
      win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
      win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
    };
    const shortcutStep = async (content, waitText, keyCode, modifiers, condition) => {
      await externalUpdate(content, waitText);
      if (keyCode) {
        await selectParagraph(waitText);
        press(keyCode, modifiers);
      }
      await waitFor(condition);
    };
    await shortcutStep('# 快捷键补充\n\n删除线目标\n', '删除线目标', 'X', [modifier, 'shift'], `window.fixtureContent().includes('~~删除线目标~~')`);
    await shortcutStep('# 快捷键补充\n\n标题目标\n', '标题目标', '2', [modifier], `window.fixtureContent().includes('## 标题目标')`);
    assert.equal(await evaluate(`document.querySelectorAll('${editor} h2').length`), 1);
    await shortcutStep('# 快捷键补充\n\n链接目标\n', '链接目标', 'K', [modifier], `window.fixtureContent().includes('[链接目标](https://)')`);
    await shortcutStep('# 快捷键补充\n\n代码目标\n', '代码目标', 'U', [modifier], `window.fixtureContent().includes('\`\`\`')`);
    await externalUpdate('# 快捷键补充\n\n- 一项\n- 二项目标\n', '二项目标');
    await waitFor(`document.querySelectorAll('${editor} li').length===2`);
    await selectParagraph('二项目标');
    // A modifier-free keyup lets Vditor re-enable indent/outdent for the list item.
    press('ArrowLeft', []);
    press('O', [modifier, 'shift']);
    await new Promise(r=>setTimeout(r,400));
    await evaluate(`[...document.querySelectorAll('.vditor-toolbar__item button')].find(b=>b.getAttribute('data-type')==='indent').click()`);
    await new Promise(r=>setTimeout(r,700));
    await waitFor(`/- 一项\\n +- 二项目标/.test(window.fixtureContent())`);
    press('ArrowLeft', []);
    press('I', [modifier, 'shift']);
    await waitFor(`/- 一项\\n- 二项目标/.test(window.fixtureContent())`);
    await shortcutStep('# 快捷键补充\n\n分割线目标\n', '分割线目标', 'H', [modifier, 'shift'], `/\\n(\\*\\*\\*|---)\\n/.test(window.fixtureContent())`);
    const manualSaveCount = await evaluate('window.fixtureWrites.length');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:[modifier]});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'S',modifiers:[modifier]});
    await waitFor(`window.fixtureWrites.length>${manualSaveCount}`);
    const columns = Array.from({ length: 24 }, (_, index) => `COLUMN_${index}`);
    const wideTable = `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.map((column) => `${column}_wide_cell`).join(' | ')} |`;
    const longDocument = `# 滚动验收\n\n${Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段正文，用于验证纵向滚轮能够访问完整内容。`).join('\n\n')}\n\n${wideTable}\n\n\`\`\`text\nWIDE_CODE_START_${'x'.repeat(500)}_WIDE_CODE_END\n\`\`\`\n\n文末滚动标记\n`;
    await evaluate(`window.fixtureExternalUpdate(${JSON.stringify(longDocument)})`);
    await waitFor(`document.querySelector('${editor}').textContent.includes('文末滚动标记')`);
    win.webContents.debugger.attach('1.3');
    for (const width of [1280, 768, 375]) {
      win.setContentSize(width, width === 1280 ? 900 : 680);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await evaluate(`document.querySelector('${editor}').scrollTop=0`);
      const scrollBox = await evaluate(`(() => { const e=document.querySelector('${editor}'),r=e.getBoundingClientRect(); return {client:e.clientHeight,scroll:e.scrollHeight,top:r.top,bottom:r.bottom,windowHeight:innerHeight,x:r.left+r.width/2,y:r.top+Math.min(80,r.height/2)}; })()`);
      console.log('Editor scroll bounds:', width, JSON.stringify(scrollBox));
      assert.ok(scrollBox.client > 0 && scrollBox.scroll > scrollBox.client, 'long prose has a bounded vertical viewport');
      assert.ok(scrollBox.bottom <= scrollBox.windowHeight + 1, 'editor stays inside the visible pane');
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:scrollBox.x, y:scrollBox.y, deltaX:0, deltaY:450 });
      await waitFor(`document.querySelector('${editor}').scrollTop>0`);
      const downPosition = await evaluate(`document.querySelector('${editor}').scrollTop`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:scrollBox.x, y:scrollBox.y, deltaX:0, deltaY:-200 });
      await waitFor(`document.querySelector('${editor}').scrollTop<${downPosition}`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:scrollBox.x, y:scrollBox.y, deltaX:0, deltaY:scrollBox.scroll });
      await waitFor(`(() => { const e=document.querySelector('${editor}');return e.scrollTop+e.clientHeight>=e.scrollHeight-1; })()`);
      assert.ok(await evaluate(`(() => { const e=document.querySelector('${editor}'),p=[...e.querySelectorAll('p')].find(n=>n.textContent.includes('文末滚动标记')),r=p.getBoundingClientRect(),b=e.getBoundingClientRect(); return r.top>=b.top&&r.bottom<=b.bottom+1; })()`), 'last paragraph is reachable');
      for (const selector of ['table', 'pre > code']) {
        const box = await evaluate(`(() => {
          const e=document.querySelector('${editor}'),target=e.querySelector(${JSON.stringify(selector)});
          if(!target)throw Error('Missing scroll target');
          e.scrollTop+=target.getBoundingClientRect().top-e.getBoundingClientRect().top-Math.min(30,e.clientHeight/4);
          let scroller=target;
          while(scroller!==e&&!(scroller.scrollWidth>scroller.clientWidth&&['auto','scroll'].includes(getComputedStyle(scroller).overflowX)))scroller=scroller.parentElement;
          window.fixtureHorizontalScroller=scroller;
          scroller.scrollLeft=0;
          const r=target.getBoundingClientRect(),b=e.getBoundingClientRect();
          return {client:scroller.clientWidth,scroll:scroller.scrollWidth,x:b.left+b.width/2,y:Math.max(b.top+10,Math.min(r.top+12,b.bottom-10))};
        })()`);
        assert.ok(box.scroll > box.client, `${selector}: wide content has a horizontal viewport`);
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:box.x, y:box.y, deltaX:450, deltaY:0 });
        await waitFor('window.fixtureHorizontalScroller.scrollLeft>0');
        const rightPosition = await evaluate('window.fixtureHorizontalScroller.scrollLeft');
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:box.x, y:box.y, deltaX:-200, deltaY:0 });
        await waitFor(`window.fixtureHorizontalScroller.scrollLeft<${rightPosition}`);
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:box.x, y:box.y, deltaX:box.scroll, deltaY:0 });
        await waitFor('window.fixtureHorizontalScroller.scrollLeft+window.fixtureHorizontalScroller.clientWidth>=window.fixtureHorizontalScroller.scrollWidth-1');
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false, `page overflow at ${width}`);
      await click('切换主题');
    }
    win.webContents.debugger.detach();
    win.setContentSize(1280, 900);
    win.show(); win.focus();
    await waitFor('document.hasFocus()');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const title = await evaluate(`(() => { const r=document.querySelector('.owb-docs-panel__title').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
    win.webContents.sendInputEvent({type:'mouseDown',...title,button:'left',clickCount:2});
    win.webContents.sendInputEvent({type:'mouseUp',...title,button:'left',clickCount:2});
    await waitFor('document.activeElement?.getAttribute("aria-label")==="新文档文件名"&&document.activeElement.selectionStart===0&&document.activeElement.selectionEnd===document.activeElement.value.length');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await waitFor('![...document.querySelectorAll("[role=dialog]")].some(e=>e.offsetParent!==null)');
    assert.equal(await evaluate('window.fixtureRenames.length'), 0);
    for (const [index, name] of ['RENAMED.md','README.md'].entries()) {
      if(index===0){
        win.webContents.sendInputEvent({type:'mouseDown',...title,button:'left',clickCount:2});
        win.webContents.sendInputEvent({type:'mouseUp',...title,button:'left',clickCount:2});
      } else await documentAction('重命名');
      await waitFor('document.activeElement?.getAttribute("aria-label")==="新文档文件名"&&document.activeElement.selectionStart===0&&document.activeElement.selectionEnd===document.activeElement.value.length');
      await win.webContents.insertText(name);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await waitFor(`window.fixtureRenames.length===${index+1}&&document.querySelector('.owb-docs-panel__title')?.textContent===${JSON.stringify(name.replace('.md',''))}`);
    }
    await documentAction('快捷键');
    await waitFor('[...document.querySelectorAll("[role=dialog]")].some(e=>e.offsetParent!==null&&e.textContent.includes("加粗")&&e.textContent.includes("链接"))');
    assert.ok((await evaluate('[...document.querySelectorAll("[role=dialog] tbody tr")].length')) >= 15);
    await evaluate('[...document.querySelectorAll("[role=dialog]")].find(d=>d.offsetParent!==null).querySelector(".ant-modal-close").click()');
    await waitFor('![...document.querySelectorAll("[role=dialog]")].some(e=>e.offsetParent!==null)');
    await documentAction('删除');
    await waitFor('[...document.querySelectorAll("[role=dialog]")].some(e=>e.offsetParent!==null)');
    assert.equal(await evaluate('window.fixtureDeletes.length'), 0);
    await click('取消');
    assert.equal(await evaluate('window.fixtureDeletes.length'), 0);
    assert.deepEqual(remoteRequests, [], 'editor does not fetch remote resources');
    for (const warning of warnings) console.warn(warning);
    assert.deepEqual(errors, [], 'no browser console errors');
    console.log('Live Markdown: compact menus, title rename, delete confirmation, save/bold/italic/strike/heading/link/code/indent/rule shortcuts, read-only/IME safeguards, bidirectional wheel scrolling and three viewport sizes passed.');
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
