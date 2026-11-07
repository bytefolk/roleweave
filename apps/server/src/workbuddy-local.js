// @ts-check
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 1024 * 1024;
const record = (/** @type {unknown} */ value) => value !== null && typeof value === "object" && !Array.isArray(value);
const modelId = (/** @type {unknown} */ value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);

/** @param {string} code */
function failure(code) { return Object.assign(new Error("WorkBuddy local request failed"), { code }); }

/** The channel is created by the owning desktop or WSL supervisor. */
export function workbuddyLocalBridgeConfigured(/** @type {NodeJS.ProcessEnv} */ env) {
  const endpoint = env.ROLEWEAVE_WORKBUDDY_BRIDGE;
  const token = env.ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN;
  if (!endpoint || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
  if (process.platform === "win32") return /^\\\\\.\\pipe\\roleweave-workbuddy-[a-f0-9-]{36}$/.test(endpoint);
  if (!path.isAbsolute(endpoint) || path.basename(endpoint) !== "bridge.sock" || !/^rw-workbuddy-/.test(path.basename(path.dirname(endpoint)))) return false;
  try {
    const directory = fs.lstatSync(path.dirname(endpoint)), socket = fs.lstatSync(endpoint);
    return directory.isDirectory() && !directory.isSymbolicLink() && socket.isSocket() && !socket.isSymbolicLink()
      && directory.uid === process.getuid?.() && socket.uid === process.getuid?.()
      && (directory.mode & 0o777) === 0o700 && (socket.mode & 0o777) === 0o600;
  } catch { return false; }
}

/** @param {NodeJS.ProcessEnv} env @param {"probe"|"catalog"|"complete"} operation
 * @param {Record<string,unknown>} [payload]
 * @param {{signal?:AbortSignal,timeoutMs?:number}} [options] @returns {Promise<any>} */
export function requestWorkbuddyLocal(env, operation, payload = {}, { signal, timeoutMs = operation === "complete" ? 60_000 : 5000 } = {}) {
  if (!workbuddyLocalBridgeConfigured(env)) return Promise.reject(failure("workbuddy.client_unavailable"));
  const id = randomUUID();
  const frame = JSON.stringify({ id, operation, payload, token: env.ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN });
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(failure("workbuddy.input_limit"));
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0, buffer = Buffer.alloc(0);
    const socket = net.createConnection(/** @type {string} */ (env.ROLEWEAVE_WORKBUDDY_BRIDGE));
    const finish = (/** @type {Error|null} */ error, /** @type {unknown} */ result = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(failure("workbuddy.cancelled"));
    const timer = setTimeout(() => finish(failure("workbuddy.deadline_exceeded")), Math.min(Math.max(timeoutMs, 1), 60_000));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(`${frame}\n`));
    socket.on("error", () => finish(failure("workbuddy.client_unavailable")));
    socket.once("end", () => { if (!settled) finish(failure("workbuddy.protocol_invalid")); });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) { finish(failure("workbuddy.output_limit")); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        if (buffer.length !== newline + 1) throw Error();
        const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, newline)));
        if (!record(value) || value.id !== id || Object.keys(value).sort().join(",") !== (value.error === undefined ? "id,result" : "error,id")) throw Error();
        if (value.error !== undefined) {
          if (typeof value.error !== "string" || !/^workbuddy\.[a-z_]{1,64}$/.test(value.error)) throw Error();
          finish(failure(value.error)); return;
        }
        const result = value.result;
        if (!record(result)) throw Error();
        if (operation === "probe") {
          if (typeof result.configured !== "boolean" || typeof result.code !== "string" || !/^workbuddy\.[a-z_]{1,64}$/.test(result.code)
            || (result.version !== undefined && (typeof result.version !== "string" || !/^\d+\.\d+\.\d+$/.test(result.version)))) throw Error();
          finish(null, { configured: result.configured, code: result.code, ...(result.version ? { version: result.version } : {}) });
        } else if (operation === "catalog") {
          if (!Array.isArray(result.models) || result.models.length > 256 || result.models.some((/** @type {any} */ model) => !record(model) || !modelId(model.id)
            || (model.name !== undefined && (typeof model.name !== "string" || model.name.length > 100 || /[\x00-\x1f\x7f]/.test(model.name))))
            || (result.defaultModel !== undefined && !modelId(result.defaultModel))) throw Error();
          finish(null, { models: result.models.map((/** @type {any} */ model) => ({ id: model.id, ...(model.name ? { name: model.name } : {}) })), ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}) });
        } else {
          if (!modelId(result.model) || typeof result.text !== "string" || Buffer.byteLength(result.text) > 655360
            || (payload.model !== undefined && payload.model !== result.model)) throw Error();
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
          finish(null, { model: result.model, text: result.text, usage });
        }
      } catch { finish(failure("workbuddy.protocol_invalid")); }
    });
  });
}

/** Local transport preflight; provider entitlement is verified by a real turn. */
export async function probeWorkbuddyLocal(/** @type {NodeJS.ProcessEnv} */ env) {
  try { return await requestWorkbuddyLocal(env, "probe", {}, { timeoutMs: 3000 }); }
  catch (error) { return { configured: false, code: /** @type {any} */ (error)?.code === "workbuddy.deadline_exceeded" ? "workbuddy.probe_timed_out" : "workbuddy.client_unavailable" }; }
}
