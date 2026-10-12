import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCxoAssets, exampleRoot, readCxoSources, renderCxoFiles } from '../cxo-examples.mjs';

test('CXO catalog distinguishes repeated acronyms and has usable provenance and scene references', async () => {
  const { catalog, definitions } = await readCxoSources();
  assert.equal(catalog.roles.length, 25);
  assert.equal(catalog.roles.filter(role => role.acronym === 'CDO').length, 3);
  assert.equal(catalog.roles.filter(role => role.acronym === 'CPO').length, 2);
  assert.equal(catalog.roles.filter(role => role.acronym === 'CCO').length, 3);
  assert.deepEqual(definitions.scenarios.map(scene => scene.roles.length), [3, 9]);
  assert.deepEqual(catalog.permissions.defaultWrites, []);
  assert.equal(catalog.permissions.defaultNetwork, 'deny');
  await checkCxoAssets();
});

test('generated workspaces reflect source definitions without runtime bindings or broader grants', async () => {
  const { definitions } = await readCxoSources();
  const digests = new Map();
  for (const scene of definitions.scenarios) {
    const directory = path.join(exampleRoot, 'scenarios', scene.id);
    const org = JSON.parse(await fs.readFile(path.join(directory, 'organization.v1alpha1.json'), 'utf8'));
    assert.deepEqual(org.roles.map(role => ({ id: role.id, reportTo: role.reportTo })), scene.roles);
    for (const role of org.roles) {
      digests.set(role.id, role.package.digest);
      assert.equal(role.mode, 'read_only');
      assert.deepEqual(role.toolAllow, ['Read', 'Grep', 'Glob']);
      const position = path.join(directory, role.package.localReference.slice('/workspace/'.length));
      const employee = JSON.parse(await fs.readFile(path.join(position, 'employee.json'), 'utf8'));
      assert.equal(employee.policy.network, 'deny');
      assert.deepEqual(employee.policy.filesystem.write, []);
      assert.deepEqual(employee.policy.mcpTools, []);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(position, 'budget.json'), 'utf8')), role.budget);
      await assert.rejects(fs.access(path.join(position, '.workbench/agent-binding.v1.json')), { code: 'ENOENT' });
    }
    for (const runtime of ['.roleweave', '.digital-employee']) await assert.rejects(fs.access(path.join(directory, runtime)), { code: 'ENOENT' });
  }
  // Compare source rendering with snapshots. Official framework digest validation
  // is separate; a stored digest is deliberately not claimed to recompute it here.
  const rendered = await renderCxoFiles(entries => {
    const manifest = JSON.parse(entries.find(entry => entry.path === './employee.json').bytes.toString('utf8'));
    return digests.get(manifest.name);
  });
  for (const [relative, expected] of rendered) assert.equal(await fs.readFile(path.join(exampleRoot, relative), 'utf8'), expected, relative);
});

test('asset checks reject changed package bytes and changed catalog sources', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxo-assets-'));
  try {
    await fs.cp(exampleRoot, directory, { recursive: true });
    await fs.appendFile(path.join(directory, 'scenarios/starter/positions/chief-executive-officer/SKILL.md'), '\nChanged duties\n');
    await assert.rejects(checkCxoAssets(directory), /stale or changed generated asset/);
    await fs.cp(exampleRoot, directory, { recursive: true });
    const file = path.join(directory, 'role-catalog/catalog.json');
    const catalog = JSON.parse(await fs.readFile(file, 'utf8'));
    catalog.roles[0].mission = 'Changed source';
    await fs.writeFile(file, JSON.stringify(catalog));
    await assert.rejects(checkCxoAssets(directory), /stale or changed generated asset/);
    catalog.roles[1].id = catalog.roles[0].id;
    await fs.writeFile(file, JSON.stringify(catalog));
    await assert.rejects(readCxoSources(directory), /role ids must be unique/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
