import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { EngineEvent, GroupConversation, GroupTimeline, TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult } from '@roleweave/shared';
import { api, startTestServer, type TestServer } from './helpers.js';

const example = fileURLToPath(new URL('../../../../examples/cxo-company/', import.meta.url));
interface Team { id: string; sponsor: string; lead: string; members: string[]; runbook: string }
interface Stage { id: string; mode: 'parallel' | 'relay'; mentions: string[]; instruction: string }
interface Runbook { id: string; teamId: string; stages: Stage[]; repair?: Stage & { reviewStage: string } }
interface Playbooks { maxRepairAttempts: number; runbooks: Runbook[]; crossTeam: { stages: Array<{ teamId: string; runbookId: string; requires: string[] }> } }

class RunbookDriver implements TurnRunDriver {
  calls: TurnRunRequest[] = [];
  private qaIndex = 0;
  constructor(private readonly qaVerdicts: string[] = ['NOT_VERIFIED']) {}
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    const index = this.calls.push(request) - 1;
    const answer = request.positionId === 'test-engineer'
      ? `VERDICT: ${this.qaVerdicts[Math.min(this.qaIndex++, this.qaVerdicts.length - 1)]}\nScope: synthetic fixture only; a real model or software was not tested.\nEvidence: FIXTURE-${index}`
      : `FIXTURE-${index}: ${request.positionId} 的合成阶段产物，保留未知项。`;
    const output = JSON.stringify({ status: 'answered', answer, citations: [{ label: '合成案例资料', uri: './knowledge/README.md' }] });
    const runId = request.envelope.turnId;
    const timestamp = new Date().toISOString();
    const events: EngineEvent[] = [
      { type: 'run.started', runId, timestamp },
      { type: 'run.completed', runId, timestamp, output, terminalReason: 'goal_met' },
    ];
    for (const event of events) request.onEvent?.(event);
    return { status: 'trusted', events, diagnostic: '' };
  }
}

async function setup(driver: RunbookDriver) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-cxo-teams-'));
  await fs.cp(path.join(example, 'scenarios/ai-product-delivery'), workspace, { recursive: true });
  const original = await fs.readFile(path.join(workspace, 'organization.v1alpha1.json'), 'utf8');
  const server = await startTestServer(undefined, driver);
  const opened = await api(server.baseUrl, '/workspace/open', { method: 'POST', token: server.token, body: { path: workspace } });
  assert.equal(opened.status, 200);
  const teams = (JSON.parse(await fs.readFile(path.join(example, 'teams.json'), 'utf8')) as { teams: Team[] }).teams;
  const playbooks = JSON.parse(await fs.readFile(path.join(example, 'walkthroughs/team-playbooks.json'), 'utf8')) as Playbooks;
  const task = JSON.parse(await fs.readFile(path.join(example, 'walkthroughs/product-delivery.json'), 'utf8')) as { brief: string };
  return { server, workspace, original, teams, playbooks, task };
}

async function createGroup(server: TestServer, team: Team): Promise<GroupConversation> {
  const response = await api(server.baseUrl, '/groups', { method: 'POST', token: server.token, body: { memberPositionIds: team.members } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as GroupConversation;
}

async function dispatch(server: TestServer, driver: RunbookDriver, group: GroupConversation, stage: Stage, brief: string, handoff = ''): Promise<TurnRecord[]> {
  const input = `${brief}\n[operator-phase:${stage.id}]\n${stage.instruction}\n[operator-selected-handoff]\n${handoff}`;
  const start = driver.calls.length;
  const accepted = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: 'POST', token: server.token, body: { input, engine: 'qoder', mentions: stage.mentions, mode: stage.mode } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const spawns = (accepted.body as { spawns: Array<{ turnId: string }> }).spawns;
  const ids = new Set(spawns.map(spawn => spawn.turnId));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const timeline = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { token: server.token });
    assert.equal(timeline.status, 200);
    const turns = (timeline.body as GroupTimeline).items.flatMap(item => item.kind === 'member' && ids.has(item.turn.turnId) ? [item.turn] : []);
    if (turns.length === spawns.length && turns.every(turn => turn.status !== 'running')) {
      assert.ok(turns.every(turn => turn.status === 'completed' && turn.input === input));
      const calls = driver.calls.slice(start);
      assert.deepEqual(calls.map(call => call.positionId).sort(), [...stage.mentions].sort());
      if (stage.mode === 'relay') assert.deepEqual(calls.map(call => call.positionId), stage.mentions);
      if (handoff) for (const call of calls) assert.ok(call.envelope.input.includes(handoff), 'operator-selected handoff must reach every requested worker');
      return turns;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('runbook stage did not produce recorded terminal results');
}

const selectedOutputs = (turns: TurnRecord[]) => turns.map(turn => typeof turn.output === 'string' ? turn.output : JSON.stringify(turn.output)).join('\n');

test('four team runbooks use explicit recipients and carry operator-selected outputs across team boundaries', async () => {
  const driver = new RunbookDriver();
  const { server, workspace, original, teams, playbooks, task } = await setup(driver);
  try {
    const results = new Map<string, string>();
    for (const transition of playbooks.crossTeam.stages) {
      const team = teams.find(team => team.id === transition.teamId)!;
      const runbook = playbooks.runbooks.find(book => book.id === transition.runbookId)!;
      const group = await createGroup(server, team);
      const before = driver.calls.length;
      const rejected = await api(server.baseUrl, `/groups/${group.conversationRef}/turns`, { method: 'POST', token: server.token, body: { input: 'Do not dispatch the sponsor implicitly', engine: 'qoder', mentions: [team.sponsor], mode: 'parallel' } });
      assert.ok(rejected.status >= 400 && rejected.status < 500);
      assert.equal(driver.calls.length, before);
      let handoff = transition.requires.map(id => results.get(id)!).join('\n');
      for (const stage of runbook.stages) {
        const turns = await dispatch(server, driver, group, stage, task.brief, handoff);
        handoff = selectedOutputs(turns);
      }
      results.set(team.id, handoff);
    }
    assert.equal(results.size, 4);
    assert.ok(results.get('engineering')!.includes('VERDICT: NOT_VERIFIED'), 'missing runtime evidence must remain visible in the QA output');
    assert.ok(driver.calls.every(call => teams.some(team => team.members.includes(call.positionId))), 'only execution team recipients are called');
    assert.equal(await fs.readFile(path.join(workspace, 'organization.v1alpha1.json'), 'utf8'), original);
  } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});

for (const verdicts of [['FAIL', 'PASS'], ['FAIL', 'FAIL', 'FAIL']]) {
  test(`engineering QA ${verdicts.join(' → ')}: completed turns preserve verdicts; repair and escalation remain operator actions`, async () => {
    const driver = new RunbookDriver(verdicts);
    const { server, workspace, original, teams, playbooks, task } = await setup(driver);
    try {
      const team = teams.find(team => team.id === 'engineering')!;
      const runbook = playbooks.runbooks.find(book => book.teamId === team.id)!;
      const group = await createGroup(server, team);
      const review = runbook.stages.find(stage => stage.id === runbook.repair!.reviewStage)!;
      let handoff = '';
      let verdict = '';
      for (let attempt = 1; attempt <= playbooks.maxRepairAttempts; attempt++) {
        const turns = await dispatch(server, driver, group, review, task.brief, handoff);
        const qa = turns.find(turn => turn.positionId === 'test-engineer')!;
        const output: unknown = typeof qa.output === 'string' ? JSON.parse(qa.output) : qa.output;
        assert.ok(output && typeof output === 'object' && 'answer' in output && typeof output.answer === 'string');
        const answer = output.answer;
        verdict = answer.includes('VERDICT: PASS') ? 'PASS' : 'FAIL';
        assert.equal(qa.status, 'completed', 'execution status must not be confused with an acceptance verdict');
        if (verdict === 'PASS') break;
        const before = driver.calls.length;
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(driver.calls.length, before, 'a FAIL answer must not auto-dispatch repairs');
        if (attempt === playbooks.maxRepairAttempts) break; // Operator escalates; do not create another model attempt.
        const repairTurns = await dispatch(server, driver, group, { ...runbook.repair!, id: `repair-${attempt}` }, task.brief, answer);
        assert.ok(repairTurns.every(turn => runbook.repair!.mentions.includes(turn.positionId)));
        handoff = selectedOutputs(repairTurns);
      }
      assert.equal(verdict, verdicts.at(-1));
      const qaCalls = driver.calls.filter(call => call.positionId === 'test-engineer').length;
      assert.equal(qaCalls, verdicts.length);
      if (verdict === 'FAIL') assert.equal(qaCalls, playbooks.maxRepairAttempts, 'bounded example stops for operator escalation');
      assert.ok(driver.calls.every(call => team.members.includes(call.positionId)), 'blocked work must not activate another team');
      assert.equal(await fs.readFile(path.join(workspace, 'organization.v1alpha1.json'), 'utf8'), original);
    } finally { await server.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
}
