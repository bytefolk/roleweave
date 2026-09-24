import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import type { ExperimentsResponse } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";
import { parseSendGateChoice } from "../src/turns/send-gate-advice.js";

const binding = (experiment: ExperimentsResponse) => ({
  workspacePath: experiment.workspacePath,
  workspaceSession: experiment.workspaceSession,
  revision: experiment.revision,
});

async function localLaya(answer: Record<string, unknown>) {
  const requests: unknown[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += String(chunk); });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers: { humanGate: answer } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1/systemone`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("send-gate Choice parsing fails closed on a non-finite confidence", () => {
  assert.equal(parseSendGateChoice({
    type: "choice",
    selected: "approval_required",
    confidence: Number.NaN,
    probabilities: { keep: 0.1, approval_required: 0.9 },
  }), null);
});

test("send-gate advice stays disabled by default and returns the authoritative role mode", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    })).status, 200);
    const settings = await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    });
    assert.equal(settings.status, 200);
    const experiment = settings.body as ExperimentsResponse;

    const response = await api(server.baseUrl, "/turns/send-gate-advice", {
      method: "POST",
      token: server.token,
      body: {
        workspacePath: experiment.workspacePath,
        workspaceSession: experiment.workspaceSession,
        revision: experiment.revision,
        positionId: "community-operator",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      workspacePath: experiment.workspacePath,
      workspaceSession: experiment.workspaceSession,
      revision: experiment.revision,
      status: "disabled",
      reason: "flag_off",
      rule: { positionId: "community-operator", mode: "read_only" },
      suggestion: null,
    });
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("send-gate advice requires a separately confirmed summary and sends only the allowlisted Laya state", async () => {
  const laya = await localLaya({
    type: "choice",
    selected: "approval_required",
    confidence: 0.92,
    probabilities: { keep: 0.08, approval_required: 0.92 },
  });
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    server.ctx.config.layaEnabled = true;
    server.ctx.config.layaUrl = laya.url;
    assert.equal((await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    })).status, 200);
    const initial = (await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    })).body as ExperimentsResponse;
    const enabledResponse = await api(server.baseUrl, "/experiments", {
      method: "PATCH", token: server.token, body: { ...binding(initial), enabled: true },
    });
    assert.equal(enabledResponse.status, 200);
    const enabled = enabledResponse.body as ExperimentsResponse;

    const abstained = await api(server.baseUrl, "/turns/send-gate-advice", {
      method: "POST", token: server.token, body: { ...binding(enabled), positionId: "community-operator" },
    });
    assert.equal(abstained.status, 200);
    assert.equal((abstained.body as { status: string }).status, "abstained");
    assert.equal((abstained.body as { reason: string }).reason, "task_summary_required");
    assert.equal(laya.requests.length, 0);

    const ready = await api(server.baseUrl, "/turns/send-gate-advice", {
      method: "POST",
      token: server.token,
      body: {
        ...binding(enabled),
        positionId: "community-operator",
        taskSummary: { value: "Summarize contributor feedback", confirmed: true },
      },
    });
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, {
      ...binding(enabled),
      status: "ready",
      rule: { positionId: "community-operator", mode: "read_only" },
      suggestion: "approval_required",
    });
    assert.equal(laya.requests.length, 1);
    const outbound = laya.requests[0] as { state: unknown; questions: Record<string, unknown> };
    assert.deepEqual(outbound.state, {
      positionId: "community-operator",
      mode: "read_only",
      taskSummary: "Summarize contributor feedback",
    });
    assert.deepEqual(Object.keys(outbound.questions), ["humanGate"]);
    assert.equal(JSON.stringify(outbound).includes("DO NOT SEND composer draft"), false);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    await laya.close();
  }
});

test("send-gate advice rejects extra request and summary fields before inference", async () => {
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    assert.equal((await api(server.baseUrl, "/workspace/open", {
      method: "POST", token: server.token, body: { path: dir },
    })).status, 200);
    const experiment = (await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    })).body as ExperimentsResponse;
    for (const body of [
      { ...binding(experiment), positionId: "community-operator", input: "DO NOT SEND composer draft" },
      { ...binding(experiment), positionId: "community-operator", taskSummary: { value: "summary", confirmed: true, turnBody: "secret" } },
    ]) {
      const response = await api(server.baseUrl, "/turns/send-gate-advice", {
        method: "POST", token: server.token, body,
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("send-gate advice abstains on low-confidence or inconsistent Laya choices", async () => {
  const laya = await localLaya({
    type: "choice",
    selected: "approval_required",
    confidence: 0.4,
    probabilities: { keep: 0.1, approval_required: 0.9 },
  });
  const server = await startTestServer();
  const dir = await copyExampleWorkspace();
  try {
    server.ctx.config.layaEnabled = true;
    server.ctx.config.layaUrl = laya.url;
    await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: dir } });
    const initial = (await api(server.baseUrl, `/experiments?workspacePath=${encodeURIComponent(dir)}`, {
      token: server.token,
    })).body as ExperimentsResponse;
    const enabled = (await api(server.baseUrl, "/experiments", {
      method: "PATCH", token: server.token, body: { ...binding(initial), enabled: true },
    })).body as ExperimentsResponse;
    const response = await api(server.baseUrl, "/turns/send-gate-advice", {
      method: "POST",
      token: server.token,
      body: {
        ...binding(enabled),
        positionId: "community-operator",
        taskSummary: { value: "Review release access", confirmed: true },
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ...binding(enabled),
      status: "abstained",
      reason: "insufficient_information",
      rule: { positionId: "community-operator", mode: "read_only" },
      suggestion: null,
    });
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    await laya.close();
  }
});
