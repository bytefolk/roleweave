import { randomBytes, randomInt } from "node:crypto";

export const SCHEMA = "phone-link.v1";
export const PAIR_TTL_MS = 5 * 60 * 1000;
export const MAX_COMMAND_BYTES = 8 * 1024;
const MAX_DEVICES = 8;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function newId() {
  return randomBytes(16).toString("hex");
}

function sixDigitCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function send(socket, payload) {
  if (socket && typeof socket.send === "function" && socket.readyState !== 3) {
    socket.send(JSON.stringify(payload));
  }
}

export function createPhoneLinkRelay(options = {}) {
  const hostToken = options.hostToken;
  if (typeof hostToken !== "string" || !/^[a-f0-9]{64}$/.test(hostToken)) {
    throw new Error("hostToken must be 64 lowercase hex characters");
  }
  const now = options.now ?? (() => Date.now());

  let hostSocket = null;
  const devices = new Map();
  const phones = new Map();
  let pairing = null;
  let orgSnapshot = null;

  function hostOnline() {
    return hostSocket !== null;
  }

  function expirePairing() {
    if (pairing && pairing.expiresAt <= now()) pairing = null;
  }

  const relay = {
    schema: SCHEMA,

    protocol() {
      return { schema: SCHEMA };
    },

    status() {
      expirePairing();
      return {
        schema: SCHEMA,
        hostOnline: hostOnline(),
        deviceCount: devices.size,
      };
    },

    issueDevice() {
      if (!hostOnline()) {
        return { ok: false, code: "host_offline", message: "RoleWeave host is not connected" };
      }
      if (devices.size >= MAX_DEVICES) {
        return { ok: false, code: "device_limit", message: "too many paired phones" };
      }
      const deviceId = newId();
      const deviceToken = randomBytes(32).toString("hex");
      devices.set(deviceToken, { deviceId, createdAt: now() });
      send(hostSocket, { v: 1, type: "pair.completed", deviceId });
      return { ok: true, deviceId, deviceToken };
    },

    claim() {
      return this.issueDevice();
    },

    connectHost(socket, token) {
      if (token !== hostToken) {
        send(socket, { v: 1, type: "error", code: "unauthorized", message: "invalid host token" });
        socket.close?.();
        return false;
      }
      if (hostSocket && hostSocket !== socket) hostSocket.close?.();
      hostSocket = socket;
      send(socket, { v: 1, type: "host.accepted", schema: SCHEMA });
      return true;
    },

    disconnectHost(socket) {
      if (hostSocket === socket) {
        hostSocket = null;
        orgSnapshot = null;
      }
    },

    publishOrg(snapshot) {
      if (!isRecord(snapshot) || !Array.isArray(snapshot.roles)) {
        return { ok: false, code: "snapshot_invalid", message: "org snapshot must include roles" };
      }
      orgSnapshot = snapshot;
      return { ok: true };
    },

    orgSnapshot() {
      return orgSnapshot;
    },

    revokeByToken(deviceToken) {
      const device = devices.get(deviceToken);
      if (!device) return { ok: false, code: "unauthorized", message: "invalid device token" };
      return this.revoke(device.deviceId);
    },

    startPair() {
      if (!hostOnline()) {
        return { ok: false, code: "host_offline", message: "RoleWeave host is not connected" };
      }
      const code = sixDigitCode();
      pairing = { code, expiresAt: now() + PAIR_TTL_MS };
      const result = { ok: true, code, expiresAt: pairing.expiresAt };
      send(hostSocket, { v: 1, type: "pair.ready", code, expiresAt: pairing.expiresAt });
      return result;
    },

    pair(code) {
      expirePairing();
      if (!hostOnline()) {
        return { ok: false, code: "host_offline", message: "RoleWeave host is not connected" };
      }
      if (typeof code !== "string" || !/^[0-9]{6}$/.test(code) || !pairing || pairing.code !== code) {
        return { ok: false, code: "pair_invalid", message: "pairing code is invalid or expired" };
      }
      if (devices.size >= MAX_DEVICES) {
        return { ok: false, code: "device_limit", message: "too many paired phones" };
      }
      pairing = null;
      return this.issueDevice();
    },

    revoke(deviceId) {
      for (const [token, device] of devices) {
        if (device.deviceId === deviceId) {
          devices.delete(token);
          const phone = phones.get(token);
          if (phone) {
            send(phone, { v: 1, type: "error", code: "revoked", message: "device grant revoked" });
            phone.close?.();
            phones.delete(token);
          }
          return { ok: true, deviceId };
        }
      }
      return { ok: false, code: "not_found", message: "device not paired" };
    },

    connectPhone(socket, deviceToken) {
      const device = devices.get(deviceToken);
      if (!device) {
        send(socket, { v: 1, type: "error", code: "unauthorized", message: "invalid device token" });
        socket.close?.();
        return false;
      }
      const previous = phones.get(deviceToken);
      if (previous && previous !== socket) previous.close?.();
      phones.set(deviceToken, socket);
      send(socket, { v: 1, type: "phone.accepted", deviceId: device.deviceId, schema: SCHEMA });
      return true;
    },

    disconnectPhone(socket) {
      for (const [token, current] of phones) {
        if (current === socket) phones.delete(token);
      }
    },

    submitCommand(deviceToken, commandId, text, positionId) {
      const device = devices.get(deviceToken);
      if (!device) return { ok: false, code: "unauthorized", message: "invalid device token" };
      if (!hostOnline()) return { ok: false, code: "host_offline", message: "RoleWeave host is not connected" };
      if (typeof commandId !== "string" || commandId.length < 8 || commandId.length > 128) {
        return { ok: false, code: "command_invalid", message: "commandId is invalid" };
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        return { ok: false, code: "command_invalid", message: "text is required" };
      }
      if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES) {
        return { ok: false, code: "command_invalid", message: "text exceeds 8 KiB" };
      }
      const payload = {
        v: 1,
        type: "command.submit",
        commandId,
        text: text.trim(),
        deviceId: device.deviceId,
      };
      if (typeof positionId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(positionId)) {
        payload.positionId = positionId;
      }
      send(hostSocket, payload);
      const phone = phones.get(deviceToken);
      send(phone, { v: 1, type: "command.status", commandId, state: "accepted" });
      return { ok: true, commandId };
    },

    publishStatus(commandId, state, summary, deviceId) {
      const allowed = new Set(["accepted", "running", "completed", "failed", "busy", "needs_approval"]);
      if (!allowed.has(state)) return { ok: false, code: "status_invalid", message: "unknown command state" };
      const message = {
        v: 1,
        type: "command.status",
        commandId,
        state,
        ...(typeof summary === "string" && summary.length > 0 ? { summary: summary.slice(0, 2000) } : {}),
      };
      if (!hostOnline()) return { ok: false, code: "host_offline", message: "RoleWeave host is not connected" };
      for (const [token, device] of devices) {
        if (deviceId && device.deviceId !== deviceId) continue;
        send(phones.get(token), message);
      }
      return { ok: true };
    },

    handleHostMessage(socket, raw) {
      if (!isRecord(raw) || raw.v !== 1 || typeof raw.type !== "string") {
        send(socket, { v: 1, type: "error", code: "bad_request", message: "invalid message" });
        return;
      }
      if (raw.type === "host.hello") {
        this.connectHost(socket, raw.token);
        return;
      }
      if (hostSocket !== socket) {
        send(socket, { v: 1, type: "error", code: "unauthorized", message: "host not accepted" });
        return;
      }
      if (raw.type === "pair.start") {
        const result = this.startPair();
        if (!result.ok) send(socket, { v: 1, type: "error", code: result.code, message: result.message });
        return;
      }
      if (raw.type === "pair.revoke") {
        const result = this.revoke(raw.deviceId);
        send(socket, result.ok
          ? { v: 1, type: "pair.revoked", deviceId: raw.deviceId }
          : { v: 1, type: "error", code: result.code, message: result.message });
        return;
      }
      if (raw.type === "command.status") {
        this.publishStatus(raw.commandId, raw.state, raw.summary, raw.deviceId);
        return;
      }
      if (raw.type === "org.snapshot") {
        const result = this.publishOrg(raw.snapshot);
        if (!result.ok) send(socket, { v: 1, type: "error", code: result.code, message: result.message });
      }
    },

    handlePhoneMessage(socket, deviceToken, raw) {
      if (!isRecord(raw) || raw.v !== 1 || typeof raw.type !== "string") {
        send(socket, { v: 1, type: "error", code: "bad_request", message: "invalid message" });
        return;
      }
      if (raw.type === "command.submit") {
        const result = this.submitCommand(deviceToken, raw.commandId, raw.text, raw.positionId);
        if (!result.ok) send(socket, { v: 1, type: "error", code: result.code, message: result.message });
      }
    },
  };

  return relay;
}
