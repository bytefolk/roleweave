import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { SCHEMA, createPhoneLinkRelay } from "../src/index.mjs";

function socket() {
  const inbox = [];
  return {
    inbox,
    readyState: 1,
    send(text) {
      inbox.push(JSON.parse(text));
    },
    close() {
      this.readyState = 3;
    },
  };
}

function hostToken() {
  return randomBytes(32).toString("hex");
}

test("protocol discovery", () => {
  const relay = createPhoneLinkRelay({ hostToken: hostToken() });
  assert.deepEqual(relay.protocol(), { schema: SCHEMA });
});

test("rejects a bad host token", () => {
  const relay = createPhoneLinkRelay({ hostToken: hostToken() });
  const host = socket();
  assert.equal(relay.connectHost(host, "00".repeat(32)), false);
  assert.equal(host.inbox[0].code, "unauthorized");
});

test("host hello uses the constructor token", () => {
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token });
  const host = socket();
  const phone = socket();
  assert.equal(relay.connectHost(host, token), true);
  assert.equal(host.inbox[0].type, "host.accepted");
  const started = relay.startPair();
  assert.equal(started.ok, true);
  assert.match(started.code, /^[0-9]{6}$/);
  const paired = relay.pair(started.code);
  assert.equal(paired.ok, true);
  assert.equal(relay.connectPhone(phone, paired.deviceToken), true);
  const submitted = relay.submitCommand(paired.deviceToken, "cmd-00000001", "总结今天的 PR");
  assert.equal(submitted.ok, true);
  assert.equal(host.inbox.some((m) => m.type === "command.submit" && m.text === "总结今天的 PR"), true);
  assert.equal(phone.inbox.some((m) => m.type === "command.status" && m.state === "accepted"), true);
  relay.publishStatus("cmd-00000001", "completed", "已处理 2 条 PR", paired.deviceId);
  assert.equal(phone.inbox.some((m) => m.state === "completed" && m.summary === "已处理 2 条 PR"), true);
});

test("expired or wrong pairing code fails closed", () => {
  let t = 1_000;
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token, now: () => t });
  const host = socket();
  relay.connectHost(host, token);
  const started = relay.startPair();
  assert.equal(relay.pair("000000").ok, false);
  t += 6 * 60 * 1000;
  assert.equal(relay.pair(started.code).ok, false);
});

test("commands fail when the host is offline", () => {
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token });
  const host = socket();
  relay.connectHost(host, token);
  const code = relay.startPair().code;
  const paired = relay.pair(code);
  relay.disconnectHost(host);
  const result = relay.submitCommand(paired.deviceToken, "cmd-offline1", "还在吗");
  assert.equal(result.ok, false);
  assert.equal(result.code, "host_offline");
});

test("claim pairs without a typed code when the host is online", () => {
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token });
  const host = socket();
  const phone = socket();
  assert.equal(relay.claim().ok, false);
  relay.connectHost(host, token);
  const claimed = relay.claim();
  assert.equal(claimed.ok, true);
  assert.equal(relay.status().hostOnline, true);
  assert.equal(relay.connectPhone(phone, claimed.deviceToken), true);
  const submitted = relay.submitCommand(claimed.deviceToken, "cmd-claim01", "合 PR", "issue-researcher");
  assert.equal(submitted.ok, true);
  assert.equal(host.inbox.some((m) => m.positionId === "issue-researcher"), true);
});

test("host org snapshot is served until the host disconnects", () => {
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token });
  const host = socket();
  relay.connectHost(host, token);
  assert.equal(relay.orgSnapshot(), null);
  assert.equal(relay.publishOrg({ name: "live-ws", roles: [{ id: "repo-owner" }] }).ok, true);
  assert.equal(relay.orgSnapshot().name, "live-ws");
  relay.disconnectHost(host);
  assert.equal(relay.orgSnapshot(), null);
});

test("phone can revoke its own grant by token", () => {
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token });
  const host = socket();
  const phone = socket();
  relay.connectHost(host, token);
  const claimed = relay.claim();
  relay.connectPhone(phone, claimed.deviceToken);
  assert.equal(relay.revokeByToken("nope").ok, false);
  assert.equal(relay.revokeByToken(claimed.deviceToken).ok, true);
  assert.equal(relay.submitCommand(claimed.deviceToken, "cmd-after-revoke", "hi").ok, false);
});

test("revoke drops the phone grant", () => {
  const token = hostToken();
  const relay = createPhoneLinkRelay({ hostToken: token });
  const host = socket();
  const phone = socket();
  relay.connectHost(host, token);
  const paired = relay.pair(relay.startPair().code);
  relay.connectPhone(phone, paired.deviceToken);
  assert.equal(relay.revoke(paired.deviceId).ok, true);
  assert.equal(relay.submitCommand(paired.deviceToken, "cmd-revoked1", "hello").ok, false);
});
