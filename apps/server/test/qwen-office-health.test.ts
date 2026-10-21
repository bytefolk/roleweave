import assert from "node:assert/strict";
import test from "node:test";
import { hostHealth } from "../src/routes/health.js";

test("Office health distinguishes startup, login and protocol recovery without marking a failed probe ready", () => {
  for (const [code, expected] of [
    ["control_disabled", /Windows.*\.qwenworkcn\/\.env.*QWENWORK_DESKTOP_CONTROL_ENABLED=true/],
    ["client_signed_out", /重新登录/],
    ["connection_failed", /连接已断开/],
    ["response_invalid", /接口不兼容/],
    ["platform_unavailable", /Windows 桌面客户端/],
  ] as const) {
    const host = hostHealth({ env: {}, engineAvailable: true, engineVersion: "qoder-engine 0.2.0",
      bundledElectronEngine: true, qwenOfficeLocal: { configured: false, code: `qwen_office.${code}` } })["qwen-office-local"];
    assert.equal(host.ready, false);
    assert.equal(host.configured, false);
    assert.match(host.nextStep ?? "", expected);
    assert.equal(host.localProbe?.failure, `qwen_office.${code}`);
  }
  const ready = hostHealth({ env: {}, engineAvailable: true, engineVersion: "qoder-engine 0.2.0",
    bundledElectronEngine: true, qwenOfficeLocal: { configured: true, code: "qwen_office.ready", version: "1.3.0" } })["qwen-office-local"];
  assert.equal(ready.ready, true);
  assert.equal(ready.nextStep, undefined);
});
