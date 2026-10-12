import readline from "node:readline";
import { createClaudeReadTools } from "../src/claude-workspace-tools.js";

const tools = createClaudeReadTools(JSON.parse(process.argv[2]));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let active = 0;
let pendingBytes = 0;
process.stdin.on("data", chunk => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const newline = bytes.lastIndexOf(10);
  pendingBytes = newline >= 0 ? bytes.length - newline - 1 : pendingBytes + bytes.length;
  if (pendingBytes > 1024 * 1024 || bytes.length > 2 * 1024 * 1024) { process.stdin.destroy(); lines.close(); process.exitCode = 1; }
});
function reply(id, body) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n"); }
lines.on("line", async line => {
  if (Buffer.byteLength(line) > 1024 * 1024) { lines.close(); process.exitCode = 1; return; }
  let request;
  try { request = JSON.parse(line); } catch { reply(null, { error: { code: -32700, message: "Invalid JSON" } }); return; }
  if (!request || typeof request !== "object" || Array.isArray(request)) { reply(null, { error: { code: -32600, message: "Invalid request" } }); return; }
  if (request.id === undefined) return;
  if (request.jsonrpc !== "2.0" || active >= 8) { reply(request.id, { error: { code: -32600, message: "Invalid or busy request" } }); return; }
  active++;
  try {
    let result;
    if (request.method === "initialize") result = { protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(request.params?.protocolVersion) ? request.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "roleweave-workspace-read", version: "1.0.0" } };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools: tools.definitions };
    else if (request.method === "tools/call") {
      try { result = { content: [{ type: "text", text: JSON.stringify(await tools.call(request.params?.name, request.params?.arguments)) }] }; }
      catch { result = { isError: true, content: [{ type: "text", text: "工具未执行：资源未授权、文件不可安全读取或参数无效。不会扩展权限，请检查员工读取范围。" }] }; }
    } else { reply(request.id, { error: { code: -32601, message: "Method not found" } }); return; }
    reply(request.id, { result });
  } finally { active--; }
});
