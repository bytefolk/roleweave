import assert from "node:assert/strict";
import test from "node:test";
import { hostHealth } from "../src/routes/health.js";
import { employeeModelConfig } from "../src/model-selection.js";

test("Gemini Host is ready with an installed CLI and cached local login", () => {
  const result = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: {},
    gemini: { installed: true, version: "1.2.0", client: "antigravity" },
  }).gemini;

  assert.equal(result.configured, true);
  assert.equal(result.ready, true);
  assert.equal(result.nextStep, undefined);
  assert.equal(result.modelPinnable, true);
});

test("Gemini API key remains an optional supported authentication path", () => {
  const result = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-3-flash" },
    gemini: { installed: true, version: "0.32.1", client: "gemini" },
  }).gemini;

  assert.equal(result.configured, true);
  assert.equal(result.ready, true);
  assert.equal(result.model, "gemini-3-flash");
});

test("Gemini Host reports both supported client launchers when none is installed", () => {
  const result = hostHealth({
    engineAvailable: true,
    bundledElectronEngine: true,
    env: {},
  }).gemini;

  assert.equal(result.configured, false);
  assert.equal(result.ready, false);
  assert.match(result.nextStep ?? "", /Gemini CLI.*Antigravity CLI.*agy/);
});

test("Gemini model selection never imports the Codex catalog", async () => {
  const config = await employeeModelConfig("gemini", undefined, true, {
    HOME: "/does-not-exist",
    GEMINI_MODEL: "gemini-3.8-flash-high",
  });

  assert.equal(config.editable, true);
  assert.equal(config.allowCustomModel, true);
  assert.equal(config.customModelFormat, "strict");
  assert.equal(config.selected, "provider-default");
  assert.equal(config.options[0]?.id, "provider-default");
  assert.equal(config.options[0]?.resolvedModel, "gemini-3.8-flash-high");
  assert.equal(config.connection?.billing, "subscription");
});
