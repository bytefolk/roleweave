import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { ServiceConnectionView, ServiceProbe } from "@roleweave/shared";
import { configureService, disconnectService, normalizeServiceUrl, requestService, resolveServiceConnection } from "../src/services/connections.js";
import { latestServiceRelease } from "../src/services/probes.js";
import { api, startTestServer } from "./helpers.js";

async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return { base, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const json = (res: http.ServerResponse, body: unknown, status=200) => { res.writeHead(status, {"content-type":"application/json"}); res.end(JSON.stringify(body)); };

test("service configuration is authenticated, redacted, instance local and token-bound to its API address", async () => {
  const server = await startTestServer(); const other = await startTestServer();
  try {
    const input = {kind:"doc",apiUrl:"http://localhost:3100/",token:"doc_pat_private"};
    assert.equal((await api(server.baseUrl,"/services/configure",{method:"PUT",body:input})).status,401);
    const saved = await api(server.baseUrl,"/services/configure",{method:"PUT",token:server.token,body:input});
    assert.equal(saved.status,200); assert.equal((saved.body as ServiceConnectionView).tokenConfigured,true);
    assert.equal(JSON.stringify(saved.body).includes("doc_pat_private"),false);
    assert.equal(JSON.stringify((await api(server.baseUrl,"/services",{token:server.token})).body).includes("doc_pat_private"),false);
    assert.equal(resolveServiceConnection(other.ctx,"doc"),null);
    configureService(server.ctx,{kind:"doc",apiUrl:"http://localhost:3100"});
    assert.equal(resolveServiceConnection(server.ctx,"doc")?.token,"doc_pat_private");
    configureService(server.ctx,{kind:"doc",apiUrl:"https://new.example.test"});
    assert.equal(resolveServiceConnection(server.ctx,"doc")?.token,undefined);
    disconnectService(server.ctx,"doc");
    assert.equal(resolveServiceConnection(server.ctx,"doc"),null);
    assert.equal((await api(server.baseUrl,"/services/probe?kind=doc",{token:server.token})).status,200);
  } finally { await server.close(); await other.close(); }
});

test("connection URLs and workspace identifiers cannot smuggle credentials or insecure remote transport", async () => {
  for (const value of ["file:///tmp/a","javascript:alert(1)","http://example.test","https://user:secret@example.test","https://example.test/?token=secret","https://example.test/#secret"]) assert.throws(()=>normalizeServiceUrl(value));
  assert.equal(normalizeServiceUrl("https://example.test/services/doc/"),"https://example.test/services/doc");
  assert.equal(normalizeServiceUrl("http://[::1]:8787/"),"http://[::1]:8787");
  const server=await startTestServer();
  try {
    for (const body of [null,{kind:"bad",apiUrl:"https://example.test"},{kind:"mem",apiUrl:"http://localhost:8787",workspaceId:"bad"},{kind:"doc",apiUrl:"http://localhost:3100",token:"bad\nheader"}]) {
      assert.equal((await api(server.baseUrl,"/services/configure",{method:"PUT",token:server.token,body})).status,400);
    }
  } finally { await server.close(); }
});

test("doc probe checks live read contracts and never invents a runtime version; incompatible updates fail closed", async () => {
  let malformed = false; let denied=false;
  const remote=await upstream((req,res)=>{
    assert.equal(req.headers.authorization,"Bearer private-doc-token");
    if (denied) return json(res,{error:"private-doc-token"},401);
    if (req.url==="/api/health") return json(res,{service:"doc-web",status:"ok"});
    if (req.url==="/api/v1/me") return json(res,{data:{authenticated:true,scopes:["documents:read"]}});
    return json(res,malformed ? {items:[]} : {data:[]});
  });
  const server=await startTestServer();
  try {
    configureService(server.ctx,{kind:"doc",apiUrl:remote.base,token:"private-doc-token"});
    const probe=async()=> (await api(server.baseUrl,"/services/probe?kind=doc",{token:server.token})).body as ServiceProbe;
    let result=await probe();assert.equal(result.state,"ready");assert.equal(result.version,null);
    malformed=true;result=await probe();assert.equal(result.state,"incompatible");
    assert.equal((await api(server.baseUrl,"/doc-plane/list",{token:server.token})).status,502);
    denied=true;result=await probe();assert.equal(result.state,"unauthorized");assert.equal(JSON.stringify(result).includes("private-doc-token"),false);
  } finally {await server.close();await remote.close();}
});

test("mem probe sends the selected workspace and checks API capability, not edge health HTML", async () => {
  const workspaceId="b8128793-68c8-4248-9163-ce9aee431086";
  const remote=await upstream((req,res)=>{
    assert.equal(req.headers["x-workspace-id"],workspaceId);
    assert.equal(req.headers.authorization,"Bearer private-mem-token");
    if(req.url==="/v1/version")return json(res,{version:"v0.1.1"});
    if(req.url==="/v1/capabilities")return json(res,{features:{memory:true},permissions:{read:true}});
    if(req.url?.startsWith("/v1/files"))return json(res,{files:null});
    res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html>edge");
  });
  const server=await startTestServer();
  try {
    configureService(server.ctx,{kind:"mem",apiUrl:remote.base,token:"private-mem-token",workspaceId});
    const response=await api(server.baseUrl,"/services/probe?kind=mem",{token:server.token});
    assert.equal((response.body as ServiceProbe).state,"ready");assert.equal((response.body as ServiceProbe).version,"v0.1.1");
  } finally {await server.close();await remote.close();}
});

test("service requests refuse redirects, oversized bodies and reflected error secrets", async t => {
  let targetRequests=0;
  const target=await upstream((_req,res)=>{targetRequests++;json(res,{});});
  const redirect=await upstream((_req,res)=>{res.writeHead(302,{location:target.base});res.end();});
  try {
    await assert.rejects(requestService({kind:"doc",apiUrl:redirect.base,webUrl:redirect.base,token:"never-forward"},"/api/v1/me"),/unsafe response/);
    assert.equal(targetRequests,0);
  } finally {await redirect.close();await target.close();}
  t.mock.method(globalThis,"fetch",async (_url: unknown, options: RequestInit)=>{
    assert.equal(options.redirect,"error"); assert.ok(options.signal instanceof AbortSignal);
    throw new Error("reflected-secret-from-upstream");
  });
  await assert.rejects(requestService({kind:"mem",apiUrl:"https://example.test",webUrl:"https://example.test"},"/v1/files"),error=>error instanceof Error && !error.message.includes("reflected-secret"));
  t.mock.restoreAll();
  t.mock.method(globalThis,"fetch",async()=>new Response("{}",{headers:{"content-type":"application/json","content-length":"999999999"}}));
  await assert.rejects(requestService({kind:"doc",apiUrl:"https://example.test",webUrl:"https://example.test"},"/api/v1/me"));
});

test("official release checks are distinct from deployed versions and mem service upgrades", async t => {
  let expected="doc";
  t.mock.method(globalThis,"fetch",async (url: URL, options: RequestInit)=>{
    assert.equal(url.origin,"https://api.github.com");assert.equal(url.pathname,`/repos/bytefolk/${expected}/releases/latest`);
    assert.equal((options.headers as Record<string,string>).authorization,undefined);
    return expected==="doc" ? new Response("",{status:404}) : new Response(JSON.stringify({tag_name:"v0.1.1",published_at:"2026-08-26"}),{headers:{"content-type":"application/json"}});
  });
  const doc=await latestServiceRelease("doc");assert.equal(doc.state,"unpublished");assert.equal(doc.version,null);
  expected="mem";const mem=await latestServiceRelease("mem");assert.equal(mem.state,"available");assert.equal(mem.artifact,"mcp-client");
});

test("doc identifiers and response identities cannot redirect a document read", async () => {
  let requests=0;
  const remote=await upstream((_req,res)=>{requests++;json(res,{data:{id:"wrong",title:"wrong document",updatedAt:"2026-09-13",content:{type:"doc"}}});});
  const server=await startTestServer();
  try {
    configureService(server.ctx,{kind:"doc",apiUrl:remote.base,token:"private-doc-token"});
    const rejected=await api(server.baseUrl,"/doc-plane/detail?id=..",{token:server.token});
    assert.equal(rejected.status,400);assert.equal(requests,0);
    const mismatch=await api(server.baseUrl,"/doc-plane/detail?id=expected",{token:server.token});
    assert.equal(mismatch.status,502);assert.equal(requests,1);
  } finally {await server.close();await remote.close();}
});

test("invalid legacy env can be replaced without blocking every service setting", async t => {
  const server=await startTestServer();
  const previous=process.env.MEM_URL;process.env.MEM_URL="http://insecure.internal";
  t.after(()=>{if(previous===undefined)delete process.env.MEM_URL;else process.env.MEM_URL=previous;});
  try {
    assert.equal((await api(server.baseUrl,"/services",{token:server.token})).status,200);
    const result=configureService(server.ctx,{kind:"mem",apiUrl:"https://new.example.test",token:"new-token"});
    assert.equal(result.configured,true);assert.equal(result.apiUrl,"https://new.example.test");
  } finally {await server.close();}
});

test("doc page bounds reject oversized upstream lists before processing", async () => {
  const remote=await upstream((_req,res)=>json(res,{data:Array.from({length:101},(_,i)=>({id:`doc-${i}`,title:"doc",updatedAt:"today"}))}));
  const server=await startTestServer();
  try {
    configureService(server.ctx,{kind:"doc",apiUrl:remote.base,token:"doc-token"});
    assert.equal((await api(server.baseUrl,"/doc-plane/list",{token:server.token})).status,502);
  } finally {await server.close();await remote.close();}
});

test("mem probe rejects a file shape that the drive adapter cannot read", async () => {
  const remote=await upstream((req,res)=>{
    if(req.url==="/v1/version")return json(res,{version:"dev"});
    if(req.url==="/v1/capabilities")return json(res,{permissions:{read:true}});
    return json(res,{files:[{id:"file-1",path:"/notes"}]});
  });
  const server=await startTestServer();
  try {
    configureService(server.ctx,{kind:"mem",apiUrl:remote.base,token:"mem-token"});
    const response=await api(server.baseUrl,"/services/probe?kind=mem",{token:server.token});
    assert.equal((response.body as ServiceProbe).state,"incompatible");
  } finally {await server.close();await remote.close();}
});
