import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentHostRegistryError,
  getAgentHostCapabilities,
  listRegisteredAgentHosts,
  selectAgentHost,
} from "../src/agent-registry.js";

function health(overrides: Record<string, unknown> = {}) {
  return {
    engine: { available: true, version: "qoder-engine 0.1.0" },
    hosts: {
      qoder: { configured: true, ready: true },
      "claude-code": { configured: true, ready: true },
      "claude-local": { configured: true, ready: true },
    },
    localProbe: {
      qoder: { installed: true, supported: true, version: "qodercli 1.1.31" },
      "claude-code": { installed: true, supported: true, version: "Claude Code 2.1.223" },
      "claude-local": { installed: true, supported: true, version: "2.1.223" },
    },
    ...overrides,
  };
}

test("registers qoder, claude-code, and claude-local from a health snapshot", () => {
  const hosts = listRegisteredAgentHosts(health());

  assert.deepEqual(hosts.map((host) => host.id), ["qoder", "claude-code", "claude-local"]);
  assert.deepEqual(hosts.map((host) => host.label), ["Qoder", "Claude Code", "Claude Code（本地登录）"]);
  for (const host of hosts) {
    assert.equal(host.engine, host.id);
    assert.equal(host.availability.status, "available");
    assert.equal(host.availability.localProbe, "ready");
    assert.equal(host.availability.configured, true);
    assert.equal(host.availability.ready, true);
    assert.equal(host.reason, null);
    assert.ok(host.capabilities.includes("turns"));
    assert.ok(host.capabilities.includes("streaming"));
  }
  assert.deepEqual(hosts.map((host) => host.version), ["1.1.31", "2.1.223", "2.1.223"]);
});

test("fails closed for missing or malformed health input", () => {
  assert.deepEqual(listRegisteredAgentHosts(undefined), []);
  assert.deepEqual(listRegisteredAgentHosts(null), []);
  assert.deepEqual(listRegisteredAgentHosts({}), []);
  assert.deepEqual(listRegisteredAgentHosts({ engine: { available: "yes" }, hosts: {} }), []);
  assert.deepEqual(listRegisteredAgentHosts({ engine: { available: true }, hosts: { qoder: { ready: true } } }), []);
  assert.deepEqual(listRegisteredAgentHosts({
    engine: { available: true },
    hosts: { qoder: { configured: "yes", ready: true } },
  }), []);
});

test("keeps unavailable hosts visible but never marks them selectable", () => {
  const hosts = listRegisteredAgentHosts(health({
    hosts: {
      qoder: {
        configured: false,
        ready: false,
        nextStep: "设置 QODER_PERSONAL_ACCESS_TOKEN 后重启工作台",
      },
      "claude-code": {
        configured: true,
        ready: false,
        nextStep: "设置 ANTHROPIC_API_KEY 后重启工作台",
      },
      "claude-local": {
        configured: true,
        ready: false,
        nextStep: "安装 Claude Code 并确保 claude 在 PATH 上",
      },
    },
    localProbe: {
      qoder: { installed: false, supported: false, version: null, failure: "unavailable" },
      "claude-code": { installed: true, supported: true, version: "2.1.223" },
      "claude-local": { installed: true, supported: true, version: "2.1.223" },
    },
  }));

  assert.equal(hosts.length, 3);
  assert.equal(hosts[0]?.availability.status, "unavailable");
  assert.equal(hosts[0]?.availability.configured, false);
  assert.equal(hosts[0]?.availability.ready, false);
  assert.equal(hosts[0]?.availability.localProbe, "unavailable");
  assert.equal(hosts[0]?.reason, "未检测到可用的本地主机");
  assert.equal(hosts[1]?.availability.status, "unavailable");
  assert.equal(hosts[1]?.reason, "设置 ANTHROPIC_API_KEY 后重启工作台");
  assert.equal(hosts[2]?.availability.status, "unavailable");
  assert.equal(hosts[2]?.reason, "安装 Claude Code 并确保 claude 在 PATH 上");
});

test("engine availability is only a pipeline gate, not provider entitlement", () => {
  const input = health({
    engine: { available: false, version: "qoder-engine 0.1.0" },
    hosts: {
      qoder: { configured: true, ready: true },
      "claude-code": { configured: true, ready: true },
      "claude-local": { configured: true, ready: true },
    },
  });
  const hosts = listRegisteredAgentHosts(input);

  for (const host of hosts) {
    assert.equal(host.availability.configured, true);
    assert.equal(host.availability.ready, false);
    assert.equal(host.availability.status, "unavailable");
    assert.equal(host.reason, "本地执行引擎不可用");
  }
});

test("redacts paths, credentials, and raw probe output from version and reason", () => {
  const hosts = listRegisteredAgentHosts(health({
    hosts: {
      qoder: {
        configured: true,
        ready: false,
        version: "/Users/alice/.qoder/bin/qodercli --token qoder-secret",
        nextStep: "/Users/alice/.qoder/bin/qodercli token=qoder-secret",
      },
      "claude-code": {
        configured: true,
        ready: false,
        version: "Claude Code 2.1.223 account=anthropic-secret",
        nextStep: "ANTHROPIC_API_KEY=anthropic-secret",
      },
      "claude-local": {
        configured: true,
        ready: false,
        version: "stderr /tmp/claude 2.1.223 private-key=secret",
        nextStep: "claude binary at /tmp/claude private-key=secret",
      },
    },
    localProbe: {
      qoder: { installed: true, supported: false, version: "qodercli 1.2.0 private-token=qoder-secret", failure: "unsupported_version" },
      "claude-code": { installed: true, supported: false, version: "Claude Code 2.2.0 apiKey=anthropic-secret", failure: "unsupported_version" },
      "claude-local": { installed: true, supported: false, version: "/tmp/claude 2.2.0 secret", failure: "unsupported_version" },
    },
  }));
  const serialized = JSON.stringify(hosts);

  assert.deepEqual(hosts.map((host) => host.version), ["1.2.0", "2.2.0", "2.2.0"]);
  assert.doesNotMatch(serialized, /Users\/alice|\/tmp\/claude|qoder-secret|anthropic-secret|private-key|apiKey/iu);
  assert.equal(hosts[0]?.reason, "本地主机版本不受支持");
  assert.equal(hosts[1]?.reason, "本地主机版本不受支持");
  assert.equal(hosts[2]?.reason, "本地主机版本不受支持");
});

test("selects only a ready host and exposes stable error codes", () => {
  const hosts = listRegisteredAgentHosts(health({
    hosts: {
      qoder: { configured: true, ready: true },
      "claude-code": { configured: false, ready: false },
      "claude-local": { configured: true, ready: false },
    },
  }));

  assert.equal(selectAgentHost(hosts, "qoder"), hosts[0]);

  assert.throws(
    () => selectAgentHost(hosts, "claude-code"),
    (error: unknown) => error instanceof AgentHostRegistryError && error.code === "agent_host_unavailable" && error.hostId === "claude-code",
  );
  assert.throws(
    () => selectAgentHost(hosts, "missing"),
    (error: unknown) => error instanceof AgentHostRegistryError && error.code === "agent_host_unknown" && error.hostId === "missing",
  );
  assert.throws(
    () => selectAgentHost(hosts, ""),
    (error: unknown) => error instanceof AgentHostRegistryError && error.code === "agent_host_input_invalid",
  );
});

test("capability summaries are frozen, serializable, and independent of host mutations", () => {
  const hosts = listRegisteredAgentHosts(health());
  const host = hosts[0]!;
  const capabilities = getAgentHostCapabilities(host);

  assert.deepEqual(capabilities, ["turns", "streaming", "sessions", "groups", "approvals"]);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(JSON.stringify(capabilities), '["turns","streaming","sessions","groups","approvals"]');
  assert.notEqual(capabilities, host.capabilities);
  assert.deepEqual(host.capabilities, capabilities);
  assert.deepEqual(getAgentHostCapabilities({ id: "qoder", engine: "claude-code" }), []);
});

test("does not mutate the input health snapshot", () => {
  const input = health();
  const before = JSON.stringify(input);
  const hosts = listRegisteredAgentHosts(input);

  assert.equal(JSON.stringify(input), before);
  assert.notEqual(hosts[0], (input.hosts as Record<string, unknown>).qoder);
  assert.equal(Object.isFrozen(input), false);
});

test("maps timeout and unsupported local probes without probing again", () => {
  const hosts = listRegisteredAgentHosts(health({
    hosts: {
      qoder: { configured: true, ready: false },
      "claude-code": { configured: true, ready: false },
      "claude-local": { configured: true, ready: false },
    },
    localProbe: {
      qoder: { installed: true, supported: false, version: "1.1.99", failure: "timed_out" },
      "claude-code": { installed: true, supported: false, version: "2.2.0", failure: "unsupported_version" },
      "claude-local": { installed: false, supported: false, version: null, failure: "unavailable" },
    },
  }));

  assert.deepEqual(hosts.map((host) => host.availability.localProbe), ["timed_out", "unsupported_version", "unavailable"]);
  assert.deepEqual(hosts.map((host) => host.reason), ["本地版本探测超时", "本地主机版本不受支持", "未检测到可用的本地主机"]);
});

test("fails closed when an explicitly supplied local probe is malformed", () => {
  const hosts = listRegisteredAgentHosts(health({
    localProbe: {
      qoder: { installed: "true", supported: true, version: "1.1.31" },
      "claude-code": { installed: true, supported: true, version: "2.1.223" },
      "claude-local": { installed: true, supported: true, version: "2.1.223" },
    },
  }));

  assert.equal(hosts[0]?.availability.localProbe, "unknown");
  assert.equal(hosts[0]?.availability.ready, false);
  assert.equal(hosts[0]?.availability.status, "unavailable");
  assert.equal(hosts[0]?.reason, "主机尚未就绪");
  assert.equal(hosts[1]?.availability.ready, true);
  assert.equal(hosts[2]?.availability.ready, true);
});
