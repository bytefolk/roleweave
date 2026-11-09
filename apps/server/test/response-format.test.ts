import assert from "node:assert/strict";
import test from "node:test";
import { withResponsePresentation } from "../src/turns/response-format.js";

test("presentation guidance requests rich replies while preserving explicit user formats and the original request", () => {
  const input = "只用三行纯文本回复，不要调用工具。";
  const result = withResponsePresentation(input);
  assert.match(result, /unless the current user requests a specific output format/);
  assert.match(result, /\*\*bold\*\*/);
  assert.match(result, /\[descriptive text\]\(https:\/\/example.com\)/);
  assert.match(result, /does not authorize tools/);
  assert.ok(result.endsWith(`Current user request:\n${input}`));
  const maximum = "x".repeat(256 * 1024);
  assert.equal(withResponsePresentation(maximum), maximum);
});
