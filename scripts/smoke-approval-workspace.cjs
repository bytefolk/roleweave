const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  (async () => {
    const { createServer } = await import('vite');
    const server = await createServer({
      configFile: path.resolve(__dirname, '../apps/desktop/vite.config.ts'), appType: 'custom',
      server: { host: '127.0.0.1', port: 5212, strictPort: true, open: false },
    });
    server.middlewares.use('/__approval-workspace', async (_request, response, next) => {
      try {
        const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppShell, DSProvider } from '@fullstack-ai-infra/ui';
          import 'antd/dist/reset.css'; import '@fullstack-ai-infra/ui/styles.css'; import '@roleweave/ui/styles.css';
          ${['antd-skin', 'app', 'roleweave-theme', 'roleweave-components', 'roleweave-conversation', 'roleweave-data', 'workspace-polish', 'memory/memory-workspace', 'control-legibility'].map(file => `import '/src/${file}.css';`).join('\n')}
          import { ApprovalQueue } from '/src/approvals/ApprovalQueue.tsx';
          const h = React.createElement;
          const initialItems = Array.from({length: 25}, (_, i) => ({approvalId:'request-'+i, positionId:'employee-'+i, positionName:i===0?'客户端工程师':'工程师 '+i, category:i===1?'exec':'write', description:i===0?'更新桌面开发端口':'审阅工作区修改 '+i, target:i===0?'apps/desktop/src/main.js':'reports/report-'+i+'.md', decision:{kind:'pending'}, canDecide:true, requestedAt:'2026-09-26T10:00:00Z', expiresAt:'2099-10-01T10:00:00Z', scopeAllowed:i===1?['once','run']:['once'], source:{kind:'session',positionId:'employee-'+i,conversationId:'session-'+i,turnId:'turn-'+i,runId:'run-'+i,engine:'qoder'}, context:{risk:'high',requestedCapability:i===1?'exec':'write',impact:i===1?'command_execution':'workspace_write',parameterSummary:'Local fixture only', permissions:{mode:'approval_required',allowedTools:['fs.read'],deniedTools:[]},preview:{status:'available',version:'approval-change-preview.v1',previewId:'preview-'+i,previewFingerprint:'sha256:'+'a'.repeat(64),files:[{path:'apps/desktop/src/main.js',change:'modify',before:Array.from({length:40},(_,n)=>'const port'+n+' = 9000;').join('\\n'),after:Array.from({length:40},(_,n)=>'const port'+n+' = 9010;').join('\\n')}]}}}));
          window.owb = {approvalAudit:async ({id})=>({status:200,body:{events:[]}})};
          window.fixtureDecisions=[];
          function Fixture(){
            const [theme,setTheme]=React.useState('dark'),[items,setItems]=React.useState(initialItems),[revision,setRevision]=React.useState(0);
            window.setFixtureTheme=setTheme;
            window.resetApprovals=()=>{setItems(initialItems);setRevision(n=>n+1);window.fixtureDecisions=[];};
            window.showBatchApprovals=()=>{setItems(initialItems.slice(0,3).map(item=>({...item,category:'tool',source:initialItems[0].source,scopeAllowed:['once'],batchMaxItems:3,context:{...item.context,risk:'medium',requestedCapability:'tool'}})));setRevision(n=>n+1);};
            React.useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
            const decide=(kind)=>(id,reason,scope='once')=>{
              window.fixtureDecisions.push({id,kind,reason,scope});
              setItems(current=>current.map(item=>item.approvalId===id?{...item,busy:true,error:undefined}:item));
              window.finishApproval=(success)=>setItems(current=>current.map(item=>item.approvalId!==id?item:success?{...item,busy:false,canDecide:false,decision:kind==='granted'?{kind,scope}:{kind,reason},executionPhase:kind==='granted'?'completed':'denied'}:{...item,busy:false,error:'提交失败，请重试'}));
            };
            return h(DSProvider,{mode:theme},h('div',{className:'owb-app is-sidebarless-module'},h('header',{className:'owb-wintitle'},'审批交互验证 · 隔离数据'),h(AppShell,{moduleRail:'收件箱',topbar:'Local fixture'},h('div',{className:'owb-main'},h(ApprovalQueue,{key:revision,items,onApprove:decide('granted'),onDeny:decide('denied'),onApproveBatch:(ids)=>{window.fixtureBatch=ids;setItems(current=>current.map(item=>ids.includes(item.approvalId)?{...item,decision:{kind:'granted',scope:'once'},canDecide:false}:item));},onDenyBatch:async(ids)=>{window.fixtureBatch=ids;return {succeeded:ids,failed:[]};}})))));
          }
          createRoot(document.getElementById('root')).render(h(Fixture));
        </script></body></html>`;
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/__approval-workspace', html));
      } catch (error) { next(error); }
    });
    await server.listen();
    const url = 'http://127.0.0.1:5212/__approval-workspace';
    if (process.argv.includes('--serve')) {
      console.log(url);
      for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await server.close(); process.exit(0); });
      return;
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roleweave-approval-workspace-'));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(require('electron'), [__filename, temp, url], { env, stdio:'inherit' });
        child.once('error',reject); child.once('exit',code=>resolve(code??1));
      });
    } finally { await server.close(); fs.rmSync(temp,{recursive:true,force:true}); }
  })().catch(error=>{console.error(error);process.exitCode=1;});
} else {
  const {app,BrowserWindow}=require('electron');
  app.setPath('userData',path.join(process.argv[2],'profile'));
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:1280,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    const errors=[], warnings=new Set();
    win.webContents.on('console-message',event=>{
      if(event.level==='warning' || event.message.startsWith('Warning:')) warnings.add(event.message);
      else if(event.level==='error'){errors.push(event.message);console.error(event.message);}
    });
    await win.loadURL(process.argv[3]);
    const evaluate=source=>win.webContents.executeJavaScript(source);
    const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const waitFor=condition=>evaluate(`new Promise((resolve,reject)=>{const start=performance.now();const check=()=>{if(${condition})return resolve(true);if(performance.now()-start>10000)return reject(new Error('Timed out: '+${JSON.stringify(condition)}));requestAnimationFrame(check);};check();})`);
    await waitFor('document.querySelector(".owb-approval-detail")');
    for(const [width,height] of [[1280,800],[960,680],[640,680]]){
      win.setContentSize(width,height);await frames();
      for(const theme of ['light','dark']){
        await evaluate(`window.setFixtureTheme(${JSON.stringify(theme)});window.resetApprovals()`);await frames();
        const geometry=await evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}};return {queue:rect('.owb-approval-queue'),main:rect('.owb-main'),detail:rect('.owb-approval-detail'),footer:rect('.owb-approval-detail__footer'),list:rect('.owb-approval-workspace__queue'),body:rect('.owb-approval-detail__body'),buttons:[...document.querySelectorAll('.owb-approval-detail__footer button')].map(e=>e.getBoundingClientRect().bottom),overflow:document.documentElement.scrollWidth>innerWidth};})()`);
        assert.ok(geometry.footer.bottom<=geometry.main.bottom+1,'decision footer fits the viewport');
        assert.ok(geometry.footer.top>=geometry.detail.top,'footer is not above detail');
        assert.ok(geometry.body.bottom<=geometry.footer.top+1,'body does not overlap controls');
        assert.ok(geometry.buttons.every(bottom=>bottom<=geometry.main.bottom+1),'decision buttons remain visible');
        assert.equal(geometry.overflow,false,'no horizontal page overflow');
        assert.equal(await evaluate('!!document.querySelector(".ant-drawer")'),false);
        assert.equal(await evaluate('window.fixtureDecisions.length'),0);
        assert.equal(await evaluate('!!document.querySelector("[data-testid=approval-filter-category]")'),false);
        await evaluate('document.querySelector(".owb-approval-detail__body").scrollTop=10000');await frames();
        assert.equal(await evaluate('document.querySelector(".owb-approval-detail__footer").getBoundingClientRect().bottom'),geometry.footer.bottom);
        await evaluate('document.querySelector("[data-testid=approval-approve-button]").click()');await frames();
        assert.equal(await evaluate('document.querySelector("[data-testid=approval-approve-button]").disabled'),true);
        await evaluate('window.finishApproval(false)');await frames();
        assert.ok(await evaluate('document.querySelector(".owb-approval-detail__footer").textContent.includes("提交失败")'));
        await evaluate('document.querySelector("[data-testid=approval-approve-button]").click();window.finishApproval(true)');await frames();
        assert.equal(await evaluate('document.querySelector(".owb-approval-detail").dataset.approvalId'),'request-0');
        assert.equal(await evaluate('document.querySelector("[data-testid=approval-approve-button]").disabled'),true);
        await evaluate('[...document.querySelectorAll(".owb-approval-detail__header button")].find(e=>e.textContent==="下一条").click()');await frames();
        assert.equal(await evaluate('document.querySelector(".owb-approval-detail").dataset.approvalId'),'request-1');
        const scopeActionsVisible=await evaluate(`(()=>{const footer=document.querySelector('.owb-approval-detail__footer').getBoundingClientRect();return [...document.querySelectorAll('.owb-approval-drawer__actions button')].every(button=>{const r=button.getBoundingClientRect();return r.top>=footer.top&&r.bottom<=footer.bottom;});})()`);
        assert.ok(scopeActionsVisible,'run-scope controls do not push verdict buttons below the footer');
        await evaluate('document.querySelector("[data-testid=approval-deny-button]").click();window.finishApproval(true)');await frames();
        assert.equal(await evaluate('window.fixtureDecisions.at(-1).kind'),'denied');
        await evaluate('[...document.querySelectorAll(".owb-approval-queue__toolbar button")].find(e=>e.textContent.includes("更多筛选")).click()');await frames();
        assert.ok(await evaluate('!!document.querySelector("[data-testid=approval-filter-category]")'));
        assert.ok(await evaluate('document.querySelector(".owb-approval-detail__footer").getBoundingClientRect().bottom<=document.querySelector(".owb-main").getBoundingClientRect().bottom+1'));
        await evaluate('window.showBatchApprovals()');await frames();
        await evaluate('[...document.querySelectorAll(".owb-approval-card__batch-select input")].slice(0,2).forEach(input=>input.click())');await frames();
        const batchGeometry=await evaluate(`(()=>{const list=document.querySelector('.owb-approval-queue__list').getBoundingClientRect(),queue=document.querySelector('.owb-approval-workspace__queue').getBoundingClientRect();return {height:list.height,bottom:list.bottom,queueBottom:queue.bottom};})()`);
        assert.ok(batchGeometry.height>=60,'batch selection leaves request rows reachable');
        assert.ok(batchGeometry.bottom<=batchGeometry.queueBottom+1,'batch controls fit beside the requests');
        await evaluate('[...document.querySelectorAll(".owb-approval-queue__batch-summary button")].find(button=>button.textContent==="批准所选项").click()');await frames();
        assert.deepEqual(await evaluate('window.fixtureBatch'),['request-0','request-1']);
        console.log(JSON.stringify({width,height,theme,footer:geometry.footer,decisions:await evaluate('window.fixtureDecisions.length')}));
      }
    }
    assert.deepEqual(errors,[]);
    for(const warning of warnings) console.warn(warning);
    console.log('Approval workspace: 6 viewport/theme combinations passed with isolated decisions.');
    app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
