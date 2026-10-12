import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { EngineEvent, GroupConversation, GroupTimeline, TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult } from '@roleweave/shared';
import { api, startTestServer, type TestServer } from './helpers.js';

const example = fileURLToPath(new URL('../../../../examples/cxo-company/', import.meta.url));
interface Scenario { id: string; owner: string; roles: Array<{ id: string; reportTo: string | null }>; relay: string[]; parallel: string[] }

/** Synthetic execution proves routing/records, not a model's answer quality. */
class ExampleDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    const index = this.calls.push(request) - 1;
    const runId = request.envelope.turnId;
    const timestamp = new Date().toISOString();
    const output = JSON.stringify({ status: 'answered', answer: `CXO-EVIDENCE-${index}: ${request.positionId} 的合成阶段产出。未知客户反馈仍待验证。`, citations: [{ label: '合成案例资料', uri: './knowledge/README.md' }] });
    const events: EngineEvent[] = [
      { type: 'run.started', runId, timestamp },
      { type: 'run.completed', runId, timestamp, output, terminalReason: 'goal_met' },
    ];
    for (const event of events) request.onEvent?.(event);
    return { status: 'trusted', events, diagnostic: '' };
  }
}

async function waitForTurns(server: TestServer, ref: string, count: number): Promise<TurnRecord[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await api(server.baseUrl, `/groups/${ref}/turns`, { token: server.token });
    assert.equal(response.status, 200);
    const turns = (response.body as GroupTimeline).items.flatMap(item => item.kind === 'member' ? [item.turn] : []);
    if (turns.length === count && turns.every(turn => turn.status !== 'running')) return turns;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('CXO group did not reach recorded terminal states');
}

for (const scenarioId of ['starter', 'ai-product-company']) {
  test(`${scenarioId}: existing workspace/group routes preserve the org and relay trusted results`, async () => {
    const source = JSON.parse(await fs.readFile(path.join(example, 'scenarios.json'), 'utf8')) as { scenarios: Scenario[] };
    const scenario = source.scenarios.find(scene => scene.id === scenarioId)!;
    const walkthrough = JSON.parse(await fs.readFile(path.join(example, 'walkthroughs/product-validation.json'), 'utf8')) as { brief: string; relayInput: string; parallelInput: string };
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-cxo-'));
    await fs.cp(path.join(example, 'scenarios', scenarioId), workspace, { recursive: true });
    const originalOrg = await fs.readFile(path.join(workspace, 'organization.v1alpha1.json'), 'utf8');
    const driver = new ExampleDriver();
    const server = await startTestServer(undefined, driver);
    try {
      const opened = await api(server.baseUrl, '/workspace/open', { method: 'POST', token: server.token, body: { path: workspace } });
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const tree = await api(server.baseUrl, '/org/tree', { token: server.token });
      assert.equal(tree.status, 200);
      assert.equal((tree.body as { positionCount: number }).positionCount, scenario.roles.length);
      for (const [mode, members, instruction] of [['relay', scenario.relay, walkthrough.relayInput], ['parallel', scenario.parallel, walkthrough.parallelInput]] as const) {
        const created = await api(server.baseUrl, '/groups', { method: 'POST', token: server.token, body: { memberPositionIds: members } });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const group = created.body as GroupConversation;
        const start = driver.calls.length;
        const input = `${walkthrough.brief}\n\n${instruction}`;
        const accepted = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: 'POST', token: server.token, body: { input, engine: 'qoder', mentions: members, mode } });
        assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
        const turns = await waitForTurns(server, group.conversationRef, members.length);
        const calls = driver.calls.slice(start);
        if (mode === 'relay') assert.deepEqual(calls.map(call => call.positionId), members);
        else assert.deepEqual(calls.map(call => call.positionId).sort(), [...members].sort(), 'parallel scheduling has no promised start order');
        assert.ok(turns.every(turn => turn.status === 'completed' && turn.input === input));
        if (mode === 'relay') for (let index = 1; index < calls.length; index++) assert.ok(calls[index]!.envelope.input.includes(`CXO-EVIDENCE-${start + index - 1}`), 'predecessor trusted output must reach the next role');
        else for (const call of calls) assert.ok(!call.envelope.input.includes('CXO-EVIDENCE-'), 'parallel workers must not receive sibling output');
        const reopened = await startTestServer(undefined, driver);
        try {
          const response = await api(reopened.baseUrl, '/workspace/open', { method: 'POST', token: reopened.token, body: { path: workspace } });
          assert.equal(response.status, 200);
          const before = driver.calls.length;
          const restored = await waitForTurns(reopened, group.conversationRef, members.length);
          assert.deepEqual(restored.map(turn => turn.turnId).sort(), turns.map(turn => turn.turnId).sort());
          assert.equal(driver.calls.length, before, 'readback must not replay executions');
        } finally { await reopened.close(); }
      }
      assert.equal(await fs.readFile(path.join(workspace, 'organization.v1alpha1.json'), 'utf8'), originalOrg, 'group membership must not change reporting lines or grants');
    } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
}
