import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { p11SevenLeafLifecycleFixture } from './helpers.mjs';

const LEAF_IDS = Array.from({ length: 7 }, (_, index) => `P1.1.${index + 1}`);

async function currentAttempt(repo, runId, itemId) {
  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  return journal.attempts[itemId].at(-1);
}

test('P1.1 remains in progress with exactly six leaves incomplete after its first of seven leaves finishes', async t => {
  const repo = await p11SevenLeafLifecycleFixture();
  t.after(repo.cleanup);

  const started = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  assert.deepEqual(started.scope, LEAF_IDS);
  assert.equal((await repo.cli(['next', started.runId])).item.id, 'P1.1.1');

  const implementationSha = await repo.implementationCommit('profile-model.txt', 'P1.1.1\n');
  await repo.cli([
    'record', started.runId, 'P1.1.1', '--commit', implementationSha, '--ac', 'AC-P1.1-001'
  ]);
  await repo.cli(['verify', started.runId, 'P1.1.1']);

  const attempt = await currentAttempt(repo, started.runId, 'P1.1.1');
  const audit = {
    gate: 'audit',
    type: 'attestation',
    producer: 'ddd-audit',
    schema: 'ddd-audit/v1',
    status: 'passed',
    bindings: attempt.evidence.tests.bindings,
    auditRange: {
      from: attempt.evidence.tests.bindings.itemBaselineSha,
      to: attempt.evidence.tests.bindings.implementationSha
    },
    auditCounts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  };
  await repo.write('.ddd/audit-P1.1.1.json', `${JSON.stringify(audit, null, 2)}\n`);
  await repo.cli(['attest', started.runId, 'P1.1.1', 'audit', '.ddd/audit-P1.1.1.json']);
  assert.equal((await repo.cli(['finish', started.runId, 'P1.1.1'])).state, 'done');

  const status = await repo.cli(['status', started.runId]);
  assert.equal(status.leaves['P1.1.1'], 'done');
  assert.equal(status.leaves['P1.1.2'], 'ready');
  assert.equal(status.aggregates['P1.1'], 'in_progress');
  assert.deepEqual(status.remaining, LEAF_IDS.slice(1));

  const headBeforeClose = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  const journalBeforeClose = JSON.parse(await repo.read(`.ddd/runs/${started.runId}.json`));
  const prematureClose = await repo.rawCli(['close', started.runId, '--require-success']);
  assert.notEqual(prematureClose.exitCode, 0);
  const afterRejectedClose = await repo.cli(['status', started.runId]);
  const journalAfterClose = JSON.parse(await repo.read(`.ddd/runs/${started.runId}.json`));
  assert.equal(afterRejectedClose.status, 'active');
  assert.equal(afterRejectedClose.aggregates['P1.1'], 'in_progress');
  assert.deepEqual(afterRejectedClose.remaining, LEAF_IDS.slice(1));
  assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), headBeforeClose);
  assert.equal(journalAfterClose.revision, journalBeforeClose.revision);
  assert.equal(journalAfterClose.status, 'active');
  assert.equal(JSON.parse(await repo.read('.ddd/active-run.json')).runId, started.runId);
  await assert.rejects(repo.read(`docs/runs/${started.runId}.json`));

  const markdown = await repo.read('docs/roadmap/roadmap.md');
  const incompleteHeadings = markdown.split('\n')
    .filter(line => /^#### P1\.1\.\d+ /.test(line) && !line.endsWith('— done'))
    .map(line => line.match(/^#### (P1\.1\.\d+) /)[1]);
  assert.deepEqual(incompleteHeadings, LEAF_IDS.slice(1));
  assert.match(markdown, /^### P1\.1 Profile — in_progress$/m);
  assert.doesNotMatch(markdown, /\[[xX]\].*P1\.1(?:\s|$)/m);
});
