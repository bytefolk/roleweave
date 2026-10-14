/** Build example assets; never a runtime template registry or CXO dispatch rule. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const exampleRoot = path.join(repositoryRoot, 'examples/cxo-company');
const sourcePaths = ['role-catalog/catalog.json', 'role-catalog/sources.json', 'scenarios.json', 'walkthroughs/product-validation.json', 'execution-catalog/catalog.json', 'methods.json', 'teams.json', 'walkthroughs/product-delivery.json', 'walkthroughs/team-playbooks.json', 'templates/handoff.md', 'templates/review.md', 'templates/escalation.md', 'templates/retrospective.md'];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

export async function readCxoSources(root = exampleRoot) {
  const values = await Promise.all(sourcePaths.slice(0, 9).map(async relative => JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'))));
  const [catalog, cxoReferences, definitions, walkthrough, executionCatalog, methods, teamDefinitions, deliveryWalkthrough, playbooks] = values;
  const references = { sources: [...cxoReferences.sources, ...methods.sources] };
  const roles = new Map([...catalog.roles, ...executionCatalog.roles].map(role => [role.id, role]));
  assert.equal(roles.size, catalog.roles.length + executionCatalog.roles.length, 'role ids must be unique, independent of acronyms');
  const cxoIds = new Set(catalog.roles.map(role => role.id));
  const sourceIds = new Set(references.sources.map(source => source.id));
  assert.equal(sourceIds.size, references.sources.length, 'source ids must be unique');
  for (const role of roles.values()) {
    assert.match(role.id, /^[a-z][a-z0-9-]+$/);
    for (const field of ['title', 'name', 'domain', 'mission', ...(cxoIds.has(role.id) ? ['acronym'] : [])]) assert.ok(typeof role[field] === 'string' && role[field].trim(), `${role.id}: ${field}`);
    for (const field of ['responsibilities', 'inputs', 'outputs', 'collaborators', 'teamRoles', 'boundaries', 'sources']) {
      assert.ok(Array.isArray(role[field]) && (field === 'teamRoles' || role[field].length > 0) && role[field].every(item => typeof item === 'string' && item.trim()), `${role.id}: ${field}`);
    }
    for (const id of role.collaborators) assert.ok(roles.has(id), `${role.id}: unknown collaborator ${id}`);
    for (const id of role.sources) assert.ok(sourceIds.has(id), `${role.id}: unknown source ${id}`);
  }
  const scenarioIds = new Set();
  for (const scenario of definitions.scenarios) {
    assert.match(scenario.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(!scenarioIds.has(scenario.id), 'scenario ids must be unique');
    scenarioIds.add(scenario.id);
    const members = new Map(scenario.roles.map(role => [role.id, role]));
    assert.equal(members.size, scenario.roles.length);
    assert.ok(members.has(scenario.owner));
    assert.equal(members.get(scenario.owner).reportTo, null);
    assert.equal(scenario.roles.filter(role => role.reportTo === null).length, 1, 'one organization owner');
    for (const role of members.values()) {
      assert.ok(roles.has(role.id), `unknown catalog role ${role.id}`);
      if (role.reportTo !== null) assert.ok(members.has(role.reportTo));
      const visited = new Set();
      let current = role.id;
      while (current !== null) {
        assert.ok(!visited.has(current), 'reporting cycle');
        visited.add(current);
        current = members.get(current).reportTo;
      }
    }
    for (const field of ['relay', 'parallel']) {
      assert.ok(scenario[field].length >= 2);
      assert.equal(new Set(scenario[field]).size, scenario[field].length);
      for (const id of scenario[field]) assert.ok(members.has(id), `unknown ${field} member ${id}`);
    }
    assert.ok(['walkthroughs/product-validation.json', 'walkthroughs/product-delivery.json'].includes(scenario.walkthrough), 'known example walkthrough required');
  }
  const teams = new Map(teamDefinitions.teams.map(team => [team.id, team]));
  assert.equal(teams.size, teamDefinitions.teams.length, 'unique team ids required');
  const delivery = definitions.scenarios.find(scenario => scenario.id === teamDefinitions.scenarioId);
  assert.ok(delivery, 'team scene must exist');
  assert.equal(delivery.walkthrough, 'walkthroughs/product-delivery.json');
  assert.equal(playbooks.scenarioId, delivery.id);
  assert.equal(playbooks.control, 'manual', 'runbooks are operator instructions, not a workflow engine');
  assert.ok(Number.isInteger(playbooks.maxRepairAttempts) && playbooks.maxRepairAttempts >= 1 && playbooks.maxRepairAttempts <= 3, 'bounded manual repair attempts required');
  const memberIds = new Set(delivery.roles.map(role => role.id));
  const texts = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim());
  for (const team of teams.values()) {
    assert.match(team.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(cxoIds.has(team.sponsor) && memberIds.has(team.sponsor), 'team sponsor must be an instantiated CXO');
    assert.ok(texts(team.members) && team.members.length >= 2 && team.members.length <= 32 && new Set(team.members).size === team.members.length && team.members.includes(team.lead), 'group-compatible unique members must include the lead');
    for (const id of team.members) assert.ok(memberIds.has(id), 'team member must exist in the scene');
    assert.ok(!team.members.includes(team.sponsor), 'sponsorship does not silently join the execution group');
  }
  const runbookIds = new Set();
  for (const runbook of playbooks.runbooks) {
    assert.ok(!runbookIds.has(runbook.id), 'unique runbook ids required');
    runbookIds.add(runbook.id);
    const team = teams.get(runbook.teamId);
    assert.ok(team && team.runbook === runbook.id, 'runbook and team must resolve each other');
    assert.ok(texts(runbook.sources) && runbook.sources.every(id => sourceIds.has(id)));
    const stageIds = new Set();
    const validateStage = stage => {
      assert.ok(['parallel', 'relay'].includes(stage.mode), 'stage must use an existing group mode');
      assert.ok(texts(stage.mentions) && new Set(stage.mentions).size === stage.mentions.length && stage.mentions.every(id => team.members.includes(id)), 'stage recipients must be explicit members of that team');
      assert.ok(typeof stage.instruction === 'string' && stage.instruction.trim());
      assert.ok(texts(stage.outputs));
    };
    for (const stage of runbook.stages) {
      assert.match(stage.id, /^[a-z][a-z0-9-]+$/);
      assert.ok(!stageIds.has(stage.id), 'unique stage ids required');
      stageIds.add(stage.id);
      validateStage(stage);
      assert.ok(texts(stage.acceptance));
    }
    assert.ok(stageIds.size > 0);
    assert.ok(texts(runbook.finalReview.reviewers) && runbook.finalReview.reviewers.every(id => team.members.includes(id)) && texts(runbook.finalReview.criteria));
    assert.equal(runbook.finalReview.decisionOwner, 'operator');
    if (runbook.repair) {
      validateStage(runbook.repair);
      assert.equal(runbook.repair.onVerdict, 'FAIL');
      assert.ok(stageIds.has(runbook.repair.reviewStage));
      assert.equal(runbook.repair.onExhausted, 'operator_escalation');
      assert.ok(runbook.finalReview.reviewers.every(id => !runbook.repair.mentions.includes(id)), 'repair implementers and QA reviewers must be distinct');
    }
  }
  assert.equal(runbookIds.size, teams.size, 'every team needs a runbook');
  const completed = new Set();
  for (const stage of playbooks.crossTeam.stages) {
    assert.ok(teams.has(stage.teamId) && teams.get(stage.teamId).runbook === stage.runbookId);
    assert.ok(!completed.has(stage.teamId), 'cross-team stages must be unique');
    assert.ok(Array.isArray(stage.requires) && stage.requires.every(id => completed.has(id)), 'dependencies must be earlier completed teams, not a cycle or forward reference');
    completed.add(stage.teamId);
  }
  assert.equal(completed.size, teams.size);
  return { catalog, executionCatalog, references, definitions, walkthrough, deliveryWalkthrough, teamDefinitions, playbooks };
}

export async function renderCxoFiles(computeDigest, root = exampleRoot) {
  const { catalog, executionCatalog, references, definitions, walkthrough, deliveryWalkthrough, teamDefinitions, playbooks } = await readCxoSources(root);
  const roles = new Map([...catalog.roles, ...executionCatalog.roles].map(role => [role.id, role]));
  const files = new Map();
  const inputSchema = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'examples/oss-maintainer/positions/repo-owner/schemas/input.schema.json'), 'utf8'));
  const outputSchema = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'examples/oss-maintainer/positions/repo-owner/schemas/output.schema.json'), 'utf8'));
  for (const scenario of definitions.scenarios) {
    const task = scenario.walkthrough === 'walkthroughs/product-delivery.json' ? deliveryWalkthrough : walkthrough;
    const isDelivery = scenario.id === teamDefinitions.scenarioId;
    const createdAt = scenario.createdAt ?? definitions.createdAt;
    const scenarioRoot = `scenarios/${scenario.id}`;
    const scenarioRoles = new Map(scenario.roles.map(role => [role.id, role]));
    const directoryFor = id => {
      const segments = [];
      for (let current = id; current !== null; current = scenarioRoles.get(current).reportTo) segments.unshift(current);
      return `positions/${segments.join('/')}`;
    };
    const organization = { $schema: 'https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/workspace-org.schema.json', schemaVersion: 'workspace-org.v1', business: `cxo-${scenario.id}`, description: `${scenario.name}：${scenario.description}`, owner: scenario.owner, roles: [], updatedAt: createdAt };
    for (const member of scenario.roles) {
      const role = roles.get(member.id);
      const budget = member.id === scenario.owner
        ? { perTask: { tokens: 40000, iterations: 12 }, perDay: { tokens: 400000, iterations: 96 } }
        : { perTask: { tokens: 20000, iterations: 8 }, perDay: { tokens: 200000, iterations: 64 } };
      const roleFiles = new Map();
      const employee = { $schema: 'https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/employee-package.schema.json', schemaVersion: 'employee-package.v1alpha1', name: role.id, version: '0.1.0', description: role.mission, license: 'Apache-2.0', authors: ['bytefolk'], host: { protocol: 'agent-host.v1', requiredCapabilities: [] }, entrypoints: { skill: './SKILL.md', inputSchema: './schemas/input.schema.json', outputSchema: './schemas/output.schema.json' }, policy: { mode: 'read_only', network: 'deny', filesystem: { read: ['./knowledge/**'], write: [] }, mcpTools: [] }, assets: ['./knowledge/README.md', './evals/cases.json'] };
      roleFiles.set('employee.json', json(employee));
      const bullets = items => items.map(item => `- ${item}`).join('\n');
      const sources = role.sources.map(id => references.sources.find(source => source.id === id));
      const teamSuggestion = role.teamRoles.length ? `可建议的执行岗位：${role.teamRoles.join('、')}。提出组队草稿，不代表已招聘或已分配任务。` : '本岗位提交自己的专业交付物。成员选择、修复和跨团队交接由用户显式发起。';
      roleFiles.set('SKILL.md', `---\nname: ${JSON.stringify(role.id)}\ndescription: ${JSON.stringify(role.mission)}\n---\n\n# ${role.name}${role.acronym ? `（${role.acronym}）` : ''}\n\n${role.title}\n\n${role.mission}\n\n## 职责\n\n${bullets(role.responsibilities)}\n\n## 输入\n\n${bullets(role.inputs)}\n\n## 交付物\n\n${bullets(role.outputs)}\n\n## 协作\n\n${bullets(role.collaborators)}\n\n${teamSuggestion}\n\n## 边界\n\n${bullets(role.boundaries)}\n- 本岗位仅阅读获准资料并在会话中输出方案；不写文件，不调用外部系统，不发送消息。\n- 区分事实、假设和待确认事项。缺少资料时提出问题，不编造证据。\n- 收到接力材料时延续可信结论并标记未知项；并行任务不得声称已读取其他成员本次输出。\n- 最终由用户验收；头衔与汇报关系不授予额外工具、资源或组织变更权限。\n\n## 输出格式\n\n遵守 schemas/output.schema.json：status、answer、citations。answer 内说明依据、方案、未知项及下一步；超出范围时使用 escalated。\n\n## 来源\n\n${sources.map(source => `- [${source.title}](${source.url})`).join('\n')}\n\n${role.acronym ? '这些来源用于确认职称与职责方向；AI 交付物和协作方式是示例设计。' : '这些来源用于借鉴团队和交付方法；岗位职责、提示词及合成任务是本案例的原创设计。'}\n`);
      roleFiles.set('schemas/input.schema.json', json(inputSchema));
      roleFiles.set('schemas/output.schema.json', json(outputSchema));
      const relevantTeams = isDelivery ? teamDefinitions.teams.filter(team => team.members.includes(role.id) || team.sponsor === role.id) : [];
      const teamKnowledge = relevantTeams.length ? `\n## 本岗位的团队与阶段\n\n${json(relevantTeams.map(team => ({ team: team.name, sponsor: team.sponsor, lead: team.lead, members: team.members, runbook: playbooks.runbooks.find(runbook => runbook.id === team.runbook) })))}\n用户显式发起每个阶段。回合 completed 不等于验收 PASS；没有运行证据的检查标为 NOT_VERIFIED。修复最多 ${playbooks.maxRepairAttempts} 次，达到上限后交给用户决定。\n\n## 交接要求\n\n交接保留目标、产物、证据、约束、未解决项、下一阶段请求及验收标准。跨群组的关键产物由用户审阅后放进下一阶段输入，不隐式共享。\n` : '';
      roleFiles.set('knowledge/README.md', `# 已批准的合成案例资料\n\n${task.brief}\n\n## 用户验收项\n\n${bullets(task.acceptance)}\n\n岗位默认仅有此知识目录的读取权限。全部客户与业务材料均为虚构示例；不包含凭据或真实客户资料。\n${teamKnowledge}`);
      roleFiles.set('evals/cases.json', json({ schemaVersion: 'employee-evals.v1alpha1', cases: [{ id: 'synthetic-scope', input: { message: '本岗位的案例资料是否是真实客户反馈？' }, expectedOutput: { status: 'answered', answer: '不是。资料是已批准的合成需求；客户反馈和模型效果仍需验证。', citations: [{ label: '合成案例资料', uri: './knowledge/README.md' }] } }] }));
      const digest = computeDigest([...roleFiles].map(([relative, content]) => ({ path: `./${relative}`, bytes: Buffer.from(content) })));
      roleFiles.set('budget.json', json(budget));
      const directory = directoryFor(role.id);
      for (const [relative, content] of roleFiles) files.set(`${scenarioRoot}/${directory}/${relative}`, content);
      files.set(`${scenarioRoot}/work/${role.id}/README.md`, `# ${role.name}工作目录\n\n供后续获得明确写授权时使用。当前只读案例在会话中交付方案；本目录不是写权限声明。\n`);
      organization.roles.push({ id: role.id, name: role.acronym ? `${role.acronym} · ${role.name}` : role.name, description: role.mission, reportTo: member.reportTo, package: { name: role.id, version: '0.1.0', digest, localReference: `/workspace/${directory}` }, mode: 'read_only', memoryScope: '/', toolAllow: ['Read', 'Grep', 'Glob'], toolDeny: [], metadata: { example: 'cxo-company', catalogRoleId: role.id }, budget });
    }
    files.set(`${scenarioRoot}/workspace.json`, json({ $schema: 'https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/workspace.schema.json', schemaVersion: 'workspace.v1alpha1', name: scenario.id, description: scenario.description, template: `cxo-example-${scenario.id}`, createdAt, organization: './organization.v1alpha1.json', positions: './positions', context: './context' }));
    files.set(`${scenarioRoot}/organization.v1alpha1.json`, json(organization));
    files.set(`${scenarioRoot}/context/README.md`, `# ${scenario.name}\n\n${task.brief}\n\ncontext 文件不会因存在而自动被 Agent 读取。将需求放进本次输入；同一份合成资料也已封装到每个岗位的 knowledge/README.md。\n`);
    files.set(`${scenarioRoot}/work/README.md`, '# 工作目录\n\n岗位定义位于 positions/，不要让 Agent 修改。当前案例只在会话中交付方案。后续文件交付按岗位授权到 work/<positionId>/。\n');
    files.set(`${scenarioRoot}/README.md`, `# ${scenario.name}\n\n${scenario.description}\n\n这是生成的工作区快照。使用前复制整个目录到仓库外；通过 RoleWeave 打开副本，不修改或运行已提交的目录。\n\n接力顺序：${scenario.relay.join(' → ')}。\n\n并行成员：${scenario.parallel.join('、')}。\n\n操作步骤见 [案例说明](../../README.md) 和 [示范任务](../../walkthroughs/${isDelivery ? 'execution-teams.md' : 'README.md'})。\n\n未绑定 Agent、未启动任务。template 字段是案例来源标签，不是框架新增的 CLI 内置模板。\n`);
  }
  const catalogReadme = ['# CXO 岗位参考库', '', '稳定 ID 区分职责；缩写只用于展示。以下是参考职能，不是必须同时招聘的岗位。', '', '| 稳定 ID | 缩写 | 岗位 | 职责 |', '| --- | --- | --- | --- |', ...catalog.roles.map(role => `| ${role.id} | ${role.acronym} | ${role.name} | ${role.mission} |`), '', '每条定义包含职责、输入、交付物、协作岗位、执行团队建议、边界和来源。目录默认权限见 catalog.json；实际生效权限取决于场景岗位包和平台配置。', '', '来源见 [sources.json](sources.json)。AI 化职责与团队组合是案例建议；历史来源不表示当前任职。', ''].join('\n');
  files.set('role-catalog/README.md', catalogReadme);
  files.set('execution-catalog/README.md', ['# 执行岗位参考库', '', '十四个专业岗位组成产品、研发、市场、交付运营四类团队。职能与协作方法由案例配置，头衔不授予权限。', '', '| 稳定 ID | 团队 | 岗位 | 交付职责 |', '| --- | --- | --- | --- |', ...executionCatalog.roles.map(role => `| ${role.id} | ${role.domain} | ${role.name} | ${role.mission} |`), '', '定义见 [catalog.json](catalog.json)，方法来源见 [methods.json](../methods.json)，团队和负责人见 [teams.json](../teams.json)。', ''].join('\n'));
  return files;
}

export async function checkCxoAssets(root = exampleRoot) {
  await readCxoSources(root);
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'generated-files.json'), 'utf8'));
  for (const [relative, expected] of Object.entries({ ...receipt.sources, ...receipt.files })) {
    assert.ok(!path.isAbsolute(relative) && relative.split('/').every(part => part && part !== '..' && part !== '.'), 'portable receipt path required');
    assert.equal(sha256(await fs.readFile(path.join(root, relative))), expected, `stale or changed generated asset: ${relative}; regenerate using the framework`);
  }
  return { roles: receipt.roleCount, executionRoles: receipt.executionRoleCount, teams: receipt.teamCount, scenarios: receipt.scenarioCount, files: Object.keys(receipt.files).length };
}

async function generate(frameworkRoot) {
  assert.ok(frameworkRoot, 'generate requires --framework-root <built digital-employee checkout>');
  const framework = path.resolve(frameworkRoot);
  const core = await import(pathToFileURL(path.join(framework, 'dist/packages/core/index.js')).href);
  assert.equal(typeof core.computeEmployeePackageDigest, 'function', 'framework must expose the package digest contract');
  const { catalog, executionCatalog, definitions, teamDefinitions } = await readCxoSources();
  for (const scenario of definitions.scenarios) {
    for (const runtime of ['.digital-employee', '.roleweave']) {
      await assert.rejects(fs.access(path.join(exampleRoot, 'scenarios', scenario.id, runtime)), { code: 'ENOENT' }, 'do not regenerate an opened workspace; use a clean source snapshot');
    }
  }
  const files = await renderCxoFiles(core.computeEmployeePackageDigest);
  for (const [relative, content] of files) {
    const target = path.join(exampleRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async relative => [relative, sha256(await fs.readFile(path.join(exampleRoot, relative)))])));
  const manifest = JSON.parse(await fs.readFile(path.join(framework, 'package.json'), 'utf8'));
  const receipt = { schemaVersion: 'cxo-example-generation.v1', framework: { name: manifest.name, declaredVersion: manifest.version, digestDomain: core.EMPLOYEE_PACKAGE_DIGEST_DOMAIN }, roleCount: catalog.roles.length, executionRoleCount: executionCatalog.roles.length, teamCount: teamDefinitions.teams.length, scenarioCount: definitions.scenarios.length, sources: sourceHashes, files: Object.fromEntries([...files].map(([relative, content]) => [relative, sha256(content)])) };
  await fs.writeFile(path.join(exampleRoot, 'generated-files.json'), json(receipt));
  console.log(json(await checkCxoAssets()));
}

async function validateFramework(frameworkRoot) {
  assert.ok(frameworkRoot, 'validate requires --framework-root <built digital-employee checkout>');
  const framework = path.resolve(frameworkRoot);
  const inspection = await import(pathToFileURL(path.join(framework, 'dist/apps/cli/employee-package.js')).href);
  const { definitions } = await readCxoSources();
  let count = 0;
  const organizationChecks = [];
  for (const scenario of definitions.scenarios) {
    const workspace = path.join(exampleRoot, 'scenarios', scenario.id);
    const org = JSON.parse(await fs.readFile(path.join(workspace, 'organization.v1alpha1.json'), 'utf8'));
    for (const role of org.roles) {
      assert.ok(role.package.localReference.startsWith('/workspace/positions/'));
      const directory = path.join(workspace, role.package.localReference.slice('/workspace/'.length));
      const result = spawnSync(process.execPath, [path.join(framework, 'dist/apps/cli/bin.js'), 'validate', directory, '--json'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).status, 'valid');
      assert.equal(await inspection.computeEmployeePackageDirectoryDigest(directory), role.package.digest, `framework digest mismatch: ${role.id}`);
      count++;
    }
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'cxo-framework-'));
    try {
      await fs.cp(workspace, copy, { recursive: true });
      const invoke = args => {
        const result = spawnSync(process.execPath, [path.join(framework, 'dist/apps/cli/bin.js'), ...args, '--json'], { encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      };
      const first = invoke(['org', 'apply', copy]);
      assert.equal(first.status, 'applied');
      assert.equal(first.positions, scenario.roles.length);
      assert.ok(first.changes.hired.every(id => scenario.roles.some(role => role.id === id)), 'apply must not invent employees');
      assert.deepEqual(first.changes.moved, []);
      assert.deepEqual(first.changes.dismissed, []);
      const second = invoke(['org', 'apply', copy]);
      for (const changed of Object.values(second.changes)) assert.deepEqual(changed, [], 'repeat apply must be a no-op');
      const applied = JSON.parse(await fs.readFile(path.join(copy, '.digital-employee/org.json'), 'utf8'));
      assert.deepEqual(applied.roles.map(role => ({ id: role.id, reportTo: role.reportTo })).sort((a, b) => a.id.localeCompare(b.id)), [...scenario.roles].sort((a, b) => a.id.localeCompare(b.id)));
      organizationChecks.push({ scenario: scenario.id, positions: first.positions, repeatApply: 'no-op' });
    } finally { await fs.rm(copy, { recursive: true, force: true }); }
  }
  console.log(json({ validatedPackages: count, organizationChecks, modelCalls: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'check', option, frameworkRoot] = process.argv.slice(2);
  try {
    assert.ok(option === undefined || option === '--framework-root', 'unknown option');
    if (command === 'generate') await generate(frameworkRoot);
    else if (command === 'validate') await validateFramework(frameworkRoot);
    else { assert.equal(command, 'check', 'usage: cxo-examples.mjs check|generate|validate [--framework-root path]'); console.log(json(await checkCxoAssets())); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
