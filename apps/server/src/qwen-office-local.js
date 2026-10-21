// @ts-check
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 1024 * 1024;
const record = (/** @type {unknown} */ value) => value !== null && typeof value === "object" && !Array.isArray(value);
const modelId = (/** @type {unknown} */ value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
const failure = (/** @type {string} */ code) => Object.assign(new Error("Qwen Office local task failed"), { code });

/** Desktop/supervisor-owned transport, separate from Office's account ticket. */
export function qwenOfficeLocalBridgeConfigured(/** @type {NodeJS.ProcessEnv} */ env) {
  const endpoint = env.ROLEWEAVE_QWEN_OFFICE_BRIDGE;
  if (!endpoint || !/^[a-f0-9]{64}$/.test(env.ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN ?? "")) return false;
  if (process.platform === "win32") return /^\\\\\.\\pipe\\roleweave-qwen-office-[a-f0-9-]{36}$/.test(endpoint);
  if (!path.isAbsolute(endpoint) || path.basename(endpoint) !== "bridge.sock" || !/^rw-qwen-office-/.test(path.basename(path.dirname(endpoint)))) return false;
  try {
    const directory = fs.lstatSync(path.dirname(endpoint)), socket = fs.lstatSync(endpoint);
    return directory.isDirectory() && !directory.isSymbolicLink() && socket.isSocket() && !socket.isSymbolicLink()
      && directory.uid === process.getuid?.() && socket.uid === process.getuid?.()
      && (directory.mode & 0o777) === 0o700 && (socket.mode & 0o777) === 0o600;
  } catch { return false; }
}

/** @param {NodeJS.ProcessEnv} env @param {"probe"|"catalog"|"complete"} operation
 * @param {Record<string,unknown>} [payload]
 * @param {{signal?:AbortSignal,timeoutMs?:number,onProgress?:(event:{status:"running"|"waiting_for_input"})=>void}} [options]
 * @returns {Promise<any>} */
export function requestQwenOfficeLocal(env, operation, payload = {}, { signal, timeoutMs = operation === "complete" ? 180_000 : 5000, onProgress } = {}) {
  if (!qwenOfficeLocalBridgeConfigured(env)) return Promise.reject(failure("qwen_office.client_unavailable"));
  const id = randomUUID();
  const frame = JSON.stringify({ id, operation, payload, token: env.ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN });
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(failure("qwen_office.input_limit"));
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0, progressCount = 0, buffer = Buffer.alloc(0);
    const socket = net.createConnection(/** @type {string} */ (env.ROLEWEAVE_QWEN_OFFICE_BRIDGE));
    const finish = (/** @type {Error|null} */ error, /** @type {unknown} */ result = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(failure("qwen_office.cancelled"));
    const timer = setTimeout(() => finish(failure("qwen_office.deadline_exceeded")), Math.min(Math.max(timeoutMs, 1), 180_000));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(`${frame}\n`));
    socket.on("error", () => finish(failure("qwen_office.client_unavailable")));
    socket.once("end", () => { if (!settled) finish(failure("qwen_office.protocol_invalid")); });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) { finish(failure("qwen_office.output_limit")); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while (!settled && (newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line));
          if (!record(value) || value.id !== id) throw Error();
          // A native tool result must not turn this private channel capability
          // into model text, history or a displayed model name.
          const capability = /** @type {string} */ (env.ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN);
          const publicFrame = JSON.stringify(value);
          const encodedCapability = Buffer.from(capability).toString("base64").replace(/=+$/, "");
          if (publicFrame.toLowerCase().includes(capability) || publicFrame.includes(encodedCapability)) {
            finish(failure("qwen_office.credential_reflection")); return;
          }
          if (value.event !== undefined) {
            if (operation !== "complete" || Object.keys(value).sort().join(",") !== "event,id" || !record(value.event)
                || Object.keys(value.event).join(",") !== "status" || !["running", "waiting_for_input"].includes(value.event.status)
                || ++progressCount > 64) throw Error();
            onProgress?.(value.event);
            continue;
          }
          if (buffer.length || Object.keys(value).sort().join(",") !== (value.error === undefined ? "id,result" : "error,id")) throw Error();
          if (value.error !== undefined) {
            if (typeof value.error !== "string" || !/^qwen_office\.[a-z_]{1,64}$/.test(value.error)) throw Error();
            finish(failure(value.error)); return;
          }
          const result = value.result;
          if (!record(result)) throw Error();
          if (operation === "probe") {
            if (typeof result.configured !== "boolean" || typeof result.code !== "string" || !/^qwen_office\.[a-z_]{1,64}$/.test(result.code)
                || (result.version !== undefined && (typeof result.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result.version)))) throw Error();
            finish(null, { configured: result.configured, code: result.code, ...(result.version ? { version: result.version } : {}) });
          } else if (operation === "catalog") {
            if (!Array.isArray(result.models) || result.models.length > 256 || result.models.some((/** @type {any} */ model) => !record(model) || !modelId(model.id)
                || (model.name !== undefined && (typeof model.name !== "string" || model.name.length > 100 || /[\x00-\x1f\x7f]/.test(model.name))))) throw Error();
            finish(null, { models: result.models.map((/** @type {any} */ model) => ({ id: model.id, ...(model.name ? { name: model.name } : {}) })) });
          } else {
            if (typeof result.text !== "string" || !result.text.trim() || Buffer.byteLength(result.text) > 640 * 1024
                || (result.model !== undefined && !modelId(result.model))) throw Error();
            /** @type {Record<string,number>} */
            const usage = {};
            if (result.usage !== undefined) {
              if (!record(result.usage)) throw Error();
              for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
                if (result.usage[key] !== undefined) {
                  if (!Number.isSafeInteger(result.usage[key]) || result.usage[key] < 0) throw Error();
                  usage[key] = result.usage[key];
                }
              }
            }
            finish(null, { text: result.text, ...(result.model ? { model: result.model } : {}), ...(Object.keys(usage).length ? { usage } : {}) });
          }
        } catch { finish(failure("qwen_office.protocol_invalid")); }
      }
    });
  });
}

export async function probeQwenOfficeLocal(/** @type {NodeJS.ProcessEnv} */ env) {
  try { return await requestQwenOfficeLocal(env, "probe", {}, { timeoutMs: 3000 }); }
  catch (error) {
    const code = /** @type {any} */ (error)?.code;
    return { configured: false, code: typeof code === "string" && /^qwen_office\.[a-z_]{1,64}$/.test(code) ? code : "qwen_office.client_unavailable" };
  }
}
