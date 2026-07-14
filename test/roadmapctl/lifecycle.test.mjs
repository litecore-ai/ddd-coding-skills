import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseRun } from '../../src/roadmapctl/schema.mjs';
import { lifecycleFixture } from './helpers.mjs';

function completeRun(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 0,
    runId: '20260714T050000Z-a1b2c3d4',
    selector: 'P1.1',
    scope: ['P1.1.1', 'P1.1.2'],
    status: 'active',
    originalBranch: 'main',
    runBranch: 'ddd/run/20260714T050000Z-a1b2c3d4',
    baselineSha: '0'.repeat(40),
    manifestAuthorization: { mode: 'approved', hash: `sha256:${'0'.repeat(64)}` },
    maxAttemptsPerItem: 3,
    currentItemId: 'P1.1.1',
    attempts: {
      'P1.1.1': [{
        number: 1,
        state: 'in_progress',
        itemBaselineSha: '0'.repeat(40),
        implementationSha: null,
        changedFiles: [],
        acIds: [],
        evidence: {},
        reason: null,
        startedAt: '2026-07-14T05:00:00.000Z',
        finishedAt: null
      }]
    },
    events: [{
      sequence: 1,
      at: '2026-07-14T05:00:00.000Z',
      type: 'item-started',
      itemId: 'P1.1.1',
      details: {}
    }],
    pendingTransaction: null,
    ...overrides
  };
}

test('run schema accepts the exact lifecycle journal and rejects unknown nested keys', () => {
  const parsed = parseRun(completeRun());
  assert.equal(parsed.currentItemId, 'P1.1.1');
  assert(Object.isFrozen(parsed.attempts['P1.1.1'][0]));

  const invalid = completeRun();
  invalid.attempts['P1.1.1'][0].unchecked = true;
  assert.throws(() => parseRun(invalid), /unchecked|unknown key/);
});

test('start expands the complete scope and creates one active journal', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);

  const started = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  assert.deepEqual(started.scope, ['P1.1.1', 'P1.1.2']);
  assert.match(started.runId, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
  assert.equal(started.status, 'active');

  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${started.runId}.json`), 'utf8'));
  assert.equal(journal.selector, 'P1.1');
  assert.equal(journal.manifestAuthorization.mode, 'approved');
  assert.equal(journal.currentItemId, null);
  const pointer = JSON.parse(await readFile(join(repo.root, '.ddd/active-run.json'), 'utf8'));
  assert.equal(pointer.runId, started.runId);

  const duplicate = await repo.rawCli(['start', 'P1.1', '--manifest-approved']);
  assert.notEqual(duplicate.exitCode, 0);
});

test('next returns exactly one dependency-ordered item and rejects concurrent assignment', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);

  const first = await repo.cli(['next', runId]);
  assert.equal(first.item.id, 'P1.1.1');
  assert.equal(first.attempt, 1);
  assert.equal(first.item.spec.status, 'approved');

  const concurrent = await repo.rawCli(['next', runId]);
  assert.notEqual(concurrent.exitCode, 0);
  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  assert.equal(journal.currentItemId, 'P1.1.1');
  assert.equal(journal.attempts['P1.1.1'].length, 1);
});

test('start fails closed when the approved spec binding is stale', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const roadmapPath = join(repo.root, 'docs/roadmap/roadmap.json');
  const roadmap = JSON.parse(await readFile(roadmapPath, 'utf8'));
  roadmap.nodes[2].spec.hash = `sha256:${'f'.repeat(64)}`;
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.git(['add', '--', 'docs/roadmap/roadmap.json']);
  await repo.git(['commit', '-m', 'test: stale spec binding']);

  const result = await repo.rawCli(['start', 'P1.1', '--manifest-approved']);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'INVALID');
  await assert.rejects(readFile(join(repo.root, '.ddd/active-run.json'), 'utf8'));
});
