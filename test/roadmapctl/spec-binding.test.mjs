import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs/promises';
import test from 'node:test';

import { sha256Bytes, specHash } from '../../src/roadmapctl/canonical-json.mjs';
import { RoadmapController } from '../../src/roadmapctl/controller.mjs';
import { parseRoadmap } from '../../src/roadmapctl/schema.mjs';
import { specBindingFixture, validSpec } from './helpers.mjs';

test('bind-spec updates every item by stable ID and invalidates settled state', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);

  const result = await repo.cli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);

  assert.equal(result.featureId, 'P1.1');
  assert.match(result.specHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.items, {
    'P1.1.1': { acceptanceCriteria: ['AC-P1.1-001'] },
    'P1.1.2': { acceptanceCriteria: ['AC-P1.1-002'] }
  });
  const roadmap = parseRoadmap(JSON.parse(await repo.read('docs/roadmap/roadmap.json')));
  assert.equal(roadmap.revision, 1);
  for (const item of roadmap.nodes.filter(node => node.kind === 'item')) {
    assert.equal(item.status, 'planned');
    assert.equal(item.spec.hash, result.specHash);
  }
  assert.match(await repo.read('docs/roadmap/roadmap.md'), /GENERATED FILE/);
  assert.match(await repo.read('docs/specs/P1.1-profile.md'), /AC-P1\.1-001/);
  assert.match(result.bookkeepingSha, /^[a-f0-9]{40,64}$/);
});

test('bind-spec rejects missing and foreign item coverage without mutation', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  repo.spec.acceptanceCriteria[1].covers = ['P1.2.1'];
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(repo.spec, null, 2)}\n`);
  const before = await repo.read('docs/roadmap/roadmap.json');

  const result = await repo.rawCli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);

  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.stderr), {
    code: 'INVALID',
    message: 'invalid roadmap input'
  });
  assert.equal(await repo.read('docs/roadmap/roadmap.json'), before);
});

test('canonical spec hash ignores presentation and normalizes set-like arrays', () => {
  const first = validSpec();
  const second = validSpec({
    title: 'Renamed presentation',
    status: 'draft',
    models: [...first.models].reverse(),
    contracts: [...first.contracts].reverse(),
    consumers: [...first.consumers].reverse()
  });
  second.models[0].fields.reverse();
  assert.equal(specHash(second), specHash(first));
});

test('bind-spec refuses mutation while an affected item attempt is active', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  await repo.cli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);

  const result = await repo.rawCli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);

  assert.equal(result.exitCode, 6);
  assert.deepEqual(JSON.parse(result.stderr), {
    code: 'CONFLICT',
    message: 'operation conflicts with existing state'
  });
});

test('a changed shared contract invalidates start until the spec is reviewed and rebound', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  const original = '{"version":1}\n';
  repo.spec.sharedContracts = [{
    path: 'contracts/profile.json',
    hash: sha256Bytes(original)
  }];
  await repo.write('contracts/profile.json', original);
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(repo.spec, null, 2)}\n`);
  await repo.git(['add', '--', 'contracts/profile.json', 'docs/specs/P1.1-profile.json']);
  await repo.git(['commit', '-m', 'test: declare shared contract']);
  await repo.cli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);

  const changed = '{"version":2}\n';
  await repo.write('contracts/profile.json', changed);
  await repo.git(['add', '--', 'contracts/profile.json']);
  await repo.git(['commit', '-m', 'test: change shared contract']);
  const stale = await repo.rawCli(['start', 'P1.1', '--manifest-approved']);
  assert.equal(stale.exitCode, 3);

  repo.spec.sharedContracts[0].hash = sha256Bytes(changed);
  repo.spec.status = 'draft';
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(repo.spec, null, 2)}\n`);
  const draft = await repo.rawCli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);
  assert.equal(draft.exitCode, 3);
  repo.spec.status = 'approved';
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(repo.spec, null, 2)}\n`);
  const rebound = await repo.cli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);
  assert.match(rebound.specHash, /^sha256:[a-f0-9]{64}$/);
});

test('hash-file returns a controller-owned digest and rejects traversal', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  await repo.write('contracts/profile.json', '{"version":1}\n');
  const result = await repo.cli(['hash-file', 'contracts/profile.json']);
  assert.deepEqual(result, {
    path: 'contracts/profile.json',
    hash: sha256Bytes('{"version":1}\n')
  });
  const traversal = await repo.rawCli(['hash-file', '../outside.json']);
  assert.equal(traversal.exitCode, 3);
});

test('bind-spec preflights unrelated changes before mutating canonical state', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  await repo.write('notes/unrelated.txt', 'preserve me\n');
  const before = await repo.read('docs/roadmap/roadmap.json');

  const result = await repo.rawCli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);

  assert.equal(result.exitCode, 6);
  assert.equal(await repo.read('docs/roadmap/roadmap.json'), before);
  assert.equal(await repo.read('notes/unrelated.txt'), 'preserve me\n');
});

test('start rejects a roadmap AC mapping that does not exactly match spec covers', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  await repo.cli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  roadmap.nodes.find(node => node.id === 'P1.1.2').spec.acceptanceCriteria = ['AC-P1.1-001'];
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.git(['add', '--', 'docs/roadmap/roadmap.json']);
  await repo.git(['commit', '-m', 'test: forge item coverage']);

  const result = await repo.rawCli(['start', 'P1.1.2', '--manifest-approved']);

  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.stderr), {
    code: 'INVALID',
    message: 'invalid roadmap input'
  });
});

test('bind-spec refuses to launder a dirty roadmap change into its bookkeeping commit', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  const baselineHead = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  roadmap.nodes.push(
    { id: 'P2', kind: 'phase', title: 'Forged' },
    { id: 'P2.1', kind: 'feature', parentId: 'P2', title: 'Forged completion' },
    {
      ...roadmap.nodes.find(node => node.id === 'P1.1.1'),
      id: 'P2.1.1',
      parentId: 'P2.1',
      spec: {
        path: 'docs/specs/P2.1-forged.json',
        hash: `sha256:${'0'.repeat(64)}`,
        acceptanceCriteria: ['AC-P2.1-001']
      },
      status: 'done'
    }
  );
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  const forged = await repo.read('docs/roadmap/roadmap.json');

  const result = await repo.rawCli(['bind-spec', 'P1.1', 'docs/specs/P1.1-profile.json']);

  assert.equal(result.exitCode, 6);
  assert.equal(await repo.read('docs/roadmap/roadmap.json'), forged);
  assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), baselineHead);
});

test('bind-spec rolls back every canonical file when a generated-view write fails', async t => {
  const repo = await specBindingFixture();
  t.after(repo.cleanup);
  const beforeRoadmap = await repo.read('docs/roadmap/roadmap.json');
  const beforeSpec = await repo.read('docs/specs/P1.1-profile.json');
  let injectFailure = true;
  const fs = {
    ...fileSystem,
    rename: async (source, destination) => {
      if (injectFailure && destination.endsWith('docs/specs/P1.1-profile.md')) {
        injectFailure = false;
        const error = new Error('injected generated-view failure');
        error.code = 'EIO';
        throw error;
      }
      return fileSystem.rename(source, destination);
    }
  };
  const controller = await RoadmapController.open(repo.root, { fs });

  await assert.rejects(
    controller.bindSpec('P1.1', 'docs/specs/P1.1-profile.json'),
    error => error.code === 'SPEC_BINDING_TRANSACTION_FAILED'
  );

  assert.equal(await repo.read('docs/roadmap/roadmap.json'), beforeRoadmap);
  assert.equal(await repo.read('docs/specs/P1.1-profile.json'), beforeSpec);
  await assert.rejects(repo.read('docs/roadmap/roadmap.md'), error => error.code === 'ENOENT');
  await assert.rejects(repo.read('docs/specs/P1.1-profile.md'), error => error.code === 'ENOENT');
  assert.equal((await repo.git(['status', '--porcelain=v1'])).stdout, '');
});
