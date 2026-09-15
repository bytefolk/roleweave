import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { startTestServer, api } from "../apps/server/dist/test/helpers.js";

const docBase = "http://127.0.0.1:3100";
const docBrowserOrigin = "http://localhost:3100";
const mailpitBase = "http://127.0.0.1:8025";
const memBase = "http://127.0.0.1:18080";
const runId = randomUUID().slice(0, 8);
const docEmail = `roleweave-doc-${runId}@local.test`;
const memEmail = `roleweave-mem-${runId}@local.test`;
const memPassword = randomBytes(32).toString("base64url");
const cookieJar = new Map();
const debug = process.env.ROLEWEAVE_VERIFY_DEBUG === "1";
function progress(stage) { if (debug) console.error(`[verify] ${stage}`); }

function fail(message) { throw new Error(message); }
function cookieHeader() { return [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; "); }
function rememberCookies(response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator > 0) cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
async function docFetch(pathname, options = {}) {
  const headers = new Headers(options.headers);
  const cookies = cookieHeader();
  if (cookies) headers.set("cookie", cookies);
  const response = await fetch(`${docBase}${pathname}`, { ...options, headers });
  rememberCookies(response);
  return response;
}
async function json(response, label) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`);
  return payload;
}
function appData(payload, label) {
  if (payload?.errno !== 0) fail(`${label} returned application error`);
  return payload.data;
}
function decodeHtml(value) { return value.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&"); }
function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}
async function authenticateDoc() {
  const before = await json(await fetch(`${mailpitBase}/api/v1/messages?limit=100`), "Mailpit message list");
  const priorIds = new Set((before.messages ?? []).map((message) => String(message.ID ?? message.Id ?? message.id ?? "")));
  const csrf = await json(await docFetch("/api/auth/csrf"), "Doc CSRF");
  const signIn = await docFetch("/api/auth/signin/nodemailer", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: docEmail, callbackUrl: `${docBase}/` }),
  });
  if (signIn.status >= 400) fail(`Doc sign-in returned HTTP ${signIn.status}`);
  const deadline = Date.now() + 30_000;
  let message;
  while (!message && Date.now() < deadline) {
    const messages = await json(await fetch(`${mailpitBase}/api/v1/messages?limit=100`), "Mailpit poll");
    message = (messages.messages ?? []).find((candidate) => {
      const id = String(candidate.ID ?? candidate.Id ?? candidate.id ?? "");
      return !priorIds.has(id) && JSON.stringify(candidate).toLowerCase().includes(docEmail.toLowerCase());
    });
    if (!message) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!message) fail("Doc sign-in email was not delivered to Mailpit");
  const messageId = String(message.ID ?? message.Id ?? message.id);
  const detail = await json(await fetch(`${mailpitBase}/api/v1/message/${encodeURIComponent(messageId)}`), "Mailpit message detail");
  const content = decodeHtml(collectStrings(detail).join("\n"));
  const match = content.match(/https?:\/\/[^\s"'<>]+\/api\/auth\/callback\/(?:nodemailer|resend)[^\s"'<>]*/i);
  if (!match) fail("Doc sign-in email did not include a callback URL");
  const callback = new URL(match[0]);
  const completed = await docFetch(`${callback.pathname}${callback.search}`, { redirect: "manual" });
  if (completed.status < 200 || completed.status >= 400) fail(`Doc callback returned HTTP ${completed.status}`);
  const session = await json(await docFetch("/api/auth/session"), "Doc session");
  if (session?.user?.email?.toLowerCase() !== docEmail.toLowerCase()) fail("Doc session was not authenticated as the validation user");
}
async function createDocAndPat() {
  progress("doc authenticate");
  await authenticateDoc();
  const title = `RoleWeave local agent verification ${runId}`;
  const content = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title }] },
      { type: "paragraph", content: [{ type: "text", text: "The local researcher agent created this shared document for RoleWeave verification." }] },
    ],
  };
  const created = appData(await json(await docFetch("/api/doc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, content }),
  }), "Doc create"), "Doc create");
  if (typeof created?.id !== "string" || !created.id) fail("Doc create did not return an ID");
  const tokenResponse = await json(await docFetch("/api/personal-access-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", origin: docBrowserOrigin },
    body: JSON.stringify({ name: `RoleWeave local verification ${runId}`, scopes: ["documents:read"], expiresInDays: 1 }),
  }), "Doc PAT create");
  const tokenPayload = tokenResponse?.data;
  if (typeof tokenPayload?.token !== "string" || !tokenPayload.token.startsWith("doc_pat_")) fail("Doc PAT was not returned");
  progress("doc ready");
  return { id: created.id, title, token: tokenPayload.token };
}
async function memFetch(pathname, { token, headers, ...options } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set("authorization", `Bearer ${token}`);
  return fetch(`${memBase}${pathname}`, { ...options, headers: requestHeaders });
}
async function createMemFileAndPat() {
  progress("mem register");
  const registration = await json(await memFetch("/v1/auth/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: memEmail, password: memPassword }),
  }), "Mem registration");
  if (typeof registration?.token !== "string") fail("Mem registration did not return a session token");
  progress("mem workspace");
  const sessionToken = registration.token;
  const workspace = await json(await memFetch("/v1/workspaces/current", { token: sessionToken }), "Mem workspace");
  if (typeof workspace?.id !== "string") fail("Mem current workspace did not return an ID");
  const workerToken = await json(await memFetch("/v1/auth/tokens", {
    token: sessionToken,
    method: "POST",
    headers: { "content-type": "application/json", "x-workspace-id": workspace.id },
    body: JSON.stringify({ name: `RoleWeave local verification ${runId}`, scopes: ["read"], expires_in: "24h" }),
  }), "Mem read token create");
  if (typeof workerToken?.token !== "string") fail("Mem read token was not returned");
  progress("mem file");
  const fileName = `roleweave-agent-verification-${runId}.md`;
  const file = await json(await memFetch(`/v1/files?stream=1&name=${encodeURIComponent(fileName)}&mime=text%2Fmarkdown&path=%2Froleweave`, {
    token: sessionToken,
    method: "POST",
    headers: { "content-type": "text/markdown", "x-workspace-id": workspace.id },
    body: "# RoleWeave local memory\n\nThe local researcher agent saved this file for the shared role workspace.\n",
  }), "Mem file create");
  if (typeof file?.file?.id !== "string") fail("Mem file create did not return an ID");
  progress("mem structured memory");
  const memory = await json(await memFetch("/v1/memories", {
    token: sessionToken,
    method: "POST",
    headers: { "content-type": "application/json", "x-workspace-id": workspace.id, "idempotency-key": randomUUID() },
    body: JSON.stringify({ kind: "fact", content: "The local researcher agent completed the RoleWeave Doc and Mem integration check.", path: "/roleweave", source: { type: "agent", ref: "roleweave-local-researcher" }, producer: { agent_id: "roleweave-local-researcher", task_id: runId } }),
  }), "Mem structured memory create");
  if (typeof memory?.memory?.id !== "string") fail("Mem structured memory did not return an ID");
  progress("mem ready");
  return { workspaceId: workspace.id, fileId: file.file.id, memoryId: memory.memory.id, token: workerToken.token };
}
async function verifyRoleWeave(doc, mem) {
  progress("roleweave control plane");
  const server = await startTestServer();
  try {
    const headers = { token: server.token };
    const docConfig = await api(server.baseUrl, "/services/configure", { method: "PUT", ...headers, body: { kind: "doc", apiUrl: docBase, webUrl: `${docBase}/work`, token: doc.token } });
    const memConfig = await api(server.baseUrl, "/services/configure", { method: "PUT", ...headers, body: { kind: "mem", apiUrl: memBase, webUrl: memBase, token: mem.token, workspaceId: mem.workspaceId } });
    assert.equal(docConfig.status, 200); assert.equal(memConfig.status, 200);
    assert.equal(JSON.stringify(docConfig.body).includes(doc.token), false);
    assert.equal(JSON.stringify(memConfig.body).includes(mem.token), false);
    const docProbe = await api(server.baseUrl, "/services/probe?kind=doc", headers);
    const memProbe = await api(server.baseUrl, "/services/probe?kind=mem", headers);
    assert.equal(docProbe.status, 200); assert.equal(memProbe.status, 200);
    assert.equal(docProbe.body?.state, "ready"); assert.equal(memProbe.body?.state, "ready");
    progress("roleweave doc read");
    const docs = await api(server.baseUrl, "/doc-plane/list", headers);
    assert.equal(docs.status, 200);
    const entry = docs.body?.entries?.find((candidate) => candidate.id === doc.id);
    assert.ok(entry, "RoleWeave did not receive the local Doc document");
    const document = await api(server.baseUrl, `/doc-plane/detail?id=${encodeURIComponent(doc.id)}`, headers);
    assert.equal(document.status, 200);
    assert.match(document.body?.content ?? "", /local researcher agent/);
    progress("roleweave mem read");
    const drive = await api(server.baseUrl, "/drive/list?q=roleweave-agent-verification", headers);
    assert.equal(drive.status, 200);
    const object = drive.body?.objects?.find((candidate) => candidate.id === mem.fileId);
    assert.ok(object, "RoleWeave did not receive the local Mem file");
    const detail = await api(server.baseUrl, `/drive/detail?id=${encodeURIComponent(mem.fileId)}`, headers);
    assert.equal(detail.status, 200);
    progress("roleweave verified");
    return { docProbe: docProbe.body.state, memProbe: memProbe.body.state };
  } finally { await server.close(); }
}

const doc = await createDocAndPat();
const mem = await createMemFileAndPat();
const result = await verifyRoleWeave(doc, mem);
console.log(JSON.stringify({
  verified: true,
  services: result,
  doc: { id: doc.id, title: doc.title },
  mem: { workspaceId: mem.workspaceId, fileId: mem.fileId, memoryId: mem.memoryId },
  credentialsLogged: false,
}));
