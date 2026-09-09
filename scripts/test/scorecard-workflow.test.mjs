import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readWorkflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const pr = readWorkflow("scorecard-pr.yml");
const main = readWorkflow("bytefolk-scorecard.yml");

test("required Scorecard check runs on every PR update targeting main", () => {
  assert.match(pr, /on:\n  pull_request:\n    branches:\n      - main\n/);
  assert.match(pr, /name: OpenSSF Scorecard\n/);
  assert.doesNotMatch(pr, /^\s+(paths|paths-ignore|types|if|continue-on-error):/m);
  assert.doesNotMatch(pr, /^\s+pull_request_target:/m);
});

test("PR scan analyzes the checkout without publication privileges or secrets", () => {
  assert.match(pr, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(pr, /:\s*write\b|secrets\.|upload-sarif@/);
  assert.match(pr, /persist-credentials: false/);
  assert.doesNotMatch(pr, /^\s+ref:/m);
  assert.match(pr, /uses: ossf\/scorecard-action@[a-f0-9]{40}/);
  assert.match(pr, /publish_results: false/);
  assert.match(pr, /path: results.sarif/);
  assert.match(pr, /if-no-files-found: error/);
  for (const [, action] of pr.matchAll(/uses: (\S+)/g)) {
    assert.match(action, /@[a-f0-9]{40}$/);
  }
});

test("default-branch repository scan retains publication and scheduled coverage", () => {
  assert.match(main, /push:\n    branches:\n      - main/);
  assert.match(main, /schedule:/);
  assert.match(main, /publish_results: true/);
  assert.match(main, /security-events: write/);
  assert.match(main, /id-token: write/);
  assert.match(main, /github\/codeql-action\/upload-sarif@/);
});
