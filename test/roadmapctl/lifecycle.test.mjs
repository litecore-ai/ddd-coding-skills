import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseRun } from '../../src/roadmapctl/schema.mjs';
import { auditInputReport, auditReportPathFor, lifecycleFixture } from './helpers.mjs';

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

async function currentAttempt(repo, runId, itemId) {
  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  return journal.attempts[itemId].at(-1);
}

async function attestAudit(repo, runId, itemId, counts = { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }) {
  const attempt = await currentAttempt(repo, runId, itemId);
  const bindings = attempt.evidence.tests.bindings;
  const audit = auditInputReport({ runId, itemId, bindings, counts });
  const path = auditReportPathFor(runId, itemId, attempt.number);
  await repo.write(path, `${JSON.stringify(audit, null, 2)}\n`);
  return repo.cli(['attest', runId, itemId, 'audit', path]);
}

async function implementCurrent(repo, runId, itemId, path, { audit = true, counts } = {}) {
  const implementation = await repo.implementationCommit(path, `${itemId}\n`);
  await repo.cli(['record', runId, itemId, '--commit', implementation, '--ac', 'AC-P1.1-001']);
  await repo.cli(['verify', runId, itemId]);
  if (audit) await attestAudit(repo, runId, itemId, counts);
  return repo.cli(['finish', runId, itemId]);
}

async function verifyCurrent(repo, runId, itemId, path) {
  const implementation = await repo.implementationCommit(path, `${itemId}\n`);
  await repo.cli(['record', runId, itemId, '--commit', implementation, '--ac', 'AC-P1.1-001']);
  await repo.cli(['verify', runId, itemId]);
  await attestAudit(repo, runId, itemId);
  return implementation;
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

test('start requires explicit authorization and records an explicit sandbox assertion', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  assert.notEqual((await repo.rawCli(['start', 'P1.1'])).exitCode, 0);
  const started = await repo.cli(['start', 'P1.1', '--sandboxed']);
  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${started.runId}.json`), 'utf8'));
  assert.equal(journal.manifestAuthorization.mode, 'sandboxed');
});

test('controller state refuses an in-repository .ddd symlink escape', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const outside = await mkdtemp(join(tmpdir(), 'roadmap-state-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(repo.root, '.ddd'));

  const result = await repo.rawCli(['start', 'P1.1', '--manifest-approved']);
  assert.notEqual(result.exitCode, 0);
  await assert.rejects(access(join(outside, 'runs')));
  await assert.rejects(access(join(outside, 'active-run.json')));
});

test('explicit run commands reject a journal replaced by a symlink', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const outside = await mkdtemp(join(tmpdir(), 'roadmap-journal-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const journalPath = join(repo.root, '.ddd/runs', `${runId}.json`);
  const outsideJournal = join(outside, 'journal.json');
  await writeFile(outsideJournal, await readFile(journalPath));
  await rm(journalPath);
  await symlink(outsideJournal, journalPath);

  const result = await repo.rawCli(['status', runId]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'INVALID');
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

test('record, verify, and attest bind all evidence to one implementation commit', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementation = await repo.implementationCommit('first.txt', 'first\n');

  const recorded = await repo.cli([
    'record', runId, 'P1.1.1', '--commit', implementation, '--ac', 'AC-P1.1-001'
  ]);
  assert.equal(recorded.state, 'verifying');
  assert.equal(recorded.implementationSha, implementation);
  assert.deepEqual(recorded.changedFiles, ['first.txt']);

  const verified = await repo.cli(['verify', runId, 'P1.1.1']);
  assert.deepEqual(verified.gates, ['spec', 'tests', 'consumer', 'e2e']);
  let journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  let attempt = journal.attempts['P1.1.1'][0];
  assert.equal(attempt.evidence.tests.bindings.implementationSha, implementation);
  assert.equal(attempt.evidence.consumer.status, 'passed');
  assert.equal(attempt.evidence.e2e.status, 'passed');
  assert.doesNotMatch(JSON.stringify(attempt.evidence), /ok\n|stdout\"|stderr\"/);

  const bindings = attempt.evidence.tests.bindings;
  const audit = auditInputReport({ runId, itemId: 'P1.1.1', bindings });
  const auditPath = auditReportPathFor(runId, 'P1.1.1');
  await repo.write(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  const attested = await repo.cli(['attest', runId, 'P1.1.1', 'audit', auditPath]);
  assert.equal(attested.gate, 'audit');
  assert.equal(attested.status, 'passed');

  journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  attempt = journal.attempts['P1.1.1'][0];
  assert.equal(attempt.evidence.audit.producer, 'ddd-audit');
  assert.equal(attempt.evidence.audit.bindings.implementationSha, implementation);
});

test('record rejects undeclared acceptance criteria without advancing the attempt', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementation = await repo.implementationCommit('invalid.txt', 'invalid\n');

  const result = await repo.rawCli([
    'record', runId, 'P1.1.1', '--commit', implementation, '--ac', 'AC-P1.1-999'
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'INVALID');
  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  const attempt = journal.attempts['P1.1.1'][0];
  assert.equal(attempt.state, 'in_progress');
  assert.equal(attempt.implementationSha, null);
  assert.deepEqual(attempt.evidence, {});
});

test('two-leaf scope closes successfully only after both evidence-backed items finish', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  assert.equal((await repo.cli(['next', runId])).item.id, 'P1.1.1');
  assert.equal((await implementCurrent(repo, runId, 'P1.1.1', 'first.txt')).state, 'done');

  const middle = await repo.cli(['status', runId]);
  assert.equal(middle.leaves['P1.1.1'], 'done');
  assert.equal(middle.leaves['P1.1.2'], 'ready');
  assert.equal(middle.aggregates['P1.1'], 'in_progress');
  assert.deepEqual(middle.remaining, ['P1.1.2']);
  const premature = await repo.rawCli(['close', runId, '--require-success']);
  assert.notEqual(premature.exitCode, 0);

  assert.equal((await repo.cli(['next', runId])).item.id, 'P1.1.2');
  assert.equal((await implementCurrent(repo, runId, 'P1.1.2', 'second.txt')).state, 'done');
  const closed = await repo.cli(['close', runId, '--require-success']);
  assert.equal(closed.status, 'successful');
  const reportPath = join(repo.root, 'docs/runs', `${runId}.json`);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.status, 'successful');
  assert.equal(report.items['P1.1.1'].status, 'done');
  assert.equal(report.items['P1.1.1'].attempts[0].evidence.audit.status, 'passed');
  assert.doesNotMatch(JSON.stringify(report), /ok\n|stdout\"|stderr\"|\/private\//);
  await assert.rejects(readFile(join(repo.root, '.ddd/active-run.json'), 'utf8'));
});

test('verification and finalization reject a clean branch at the same commit', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId, runBranch } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementation = await repo.implementationCommit('branch.txt', 'branch\n');
  await repo.cli(['record', runId, 'P1.1.1', '--commit', implementation, '--ac', 'AC-P1.1-001']);
  await repo.git(['switch', '-c', 'drift-at-same-commit']);

  const verify = await repo.rawCli(['verify', runId, 'P1.1.1']);
  assert.notEqual(verify.exitCode, 0);
  assert.deepEqual((await currentAttempt(repo, runId, 'P1.1.1')).evidence, {});

  await repo.git(['switch', runBranch]);
  await repo.cli(['verify', runId, 'P1.1.1']);
  await attestAudit(repo, runId, 'P1.1.1');
  await repo.git(['switch', 'drift-at-same-commit']);
  const finish = await repo.rawCli(['finish', runId, 'P1.1.1']);
  assert.notEqual(finish.exitCode, 0);
  const roadmap = JSON.parse(await readFile(join(repo.root, 'docs/roadmap/roadmap.json'), 'utf8'));
  assert.equal(roadmap.nodes.find(node => node.id === 'P1.1.1').status, 'planned');
});

test('status and resume resolve the active pointer and reject a stale pointer', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const status = await repo.cli(['status', '--active']);
  const resumed = await repo.cli(['resume', '--active']);
  assert.equal(status.runId, runId);
  assert.equal(status.action, 'next');
  assert.deepEqual(resumed, status);

  await repo.write('.ddd/active-run.json', `${JSON.stringify({
    schemaVersion: 1,
    runId: 'missing-run',
    journal: '.ddd/runs/missing-run.json'
  })}\n`);
  const stale = await repo.rawCli(['status', '--active']);
  assert.notEqual(stale.exitCode, 0);
});

test('active pointer resolution fails closed when multiple active journals exist', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const journal = JSON.parse(await readFile(join(repo.root, '.ddd/runs', `${runId}.json`), 'utf8'));
  const duplicateId = `${runId.slice(0, -8)}ffffffff`;
  await repo.write(`.ddd/runs/${duplicateId}.json`, `${JSON.stringify({ ...journal, runId: duplicateId }, null, 2)}\n`);

  const status = await repo.rawCli(['status', '--active']);
  assert.notEqual(status.exitCode, 0);
});

test('resume recovers a prepared item settlement exactly once', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementationSha = await verifyCurrent(repo, runId, 'P1.1.1', 'recovery.txt');
  const journalPath = `.ddd/runs/${runId}.json`;
  const journal = JSON.parse(await repo.read(journalPath));
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  journal.revision += 1;
  journal.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440001',
    type: 'settle-item',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: 'P1.1.1',
    targetState: 'done',
    implementationSha,
    allowedPaths: ['docs/roadmap/roadmap.json', 'docs/roadmap/roadmap.md'],
    bookkeepingSha: null
  };
  await repo.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovered = await repo.cli(['resume', runId]);
  assert.equal(recovered.leaves['P1.1.1'], 'done');
  assert.equal(recovered.action, 'next');
  const head = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  const recoveredJournal = JSON.parse(await repo.read(journalPath));
  assert.equal(recoveredJournal.pendingTransaction.state, 'committed');
  assert.equal(recoveredJournal.pendingTransaction.bookkeepingSha, head);
  assert.equal(recoveredJournal.currentItemId, null);
  assert.equal(recoveredJournal.events.at(-1).details.recovered, true);

  const repeated = await repo.cli(['resume', runId]);
  assert.deepEqual(repeated, recovered);
  assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.equal(JSON.parse(await repo.read(journalPath)).revision, recoveredJournal.revision);
});

test('prepared settlement recovery rejects a commit outside its exact lineage', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementationSha = await verifyCurrent(repo, runId, 'P1.1.1', 'lineage.txt');
  const journalPath = `.ddd/runs/${runId}.json`;
  const journal = JSON.parse(await repo.read(journalPath));
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  journal.revision += 1;
  journal.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440003',
    type: 'settle-item',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: 'P1.1.1',
    targetState: 'done',
    implementationSha,
    allowedPaths: ['docs/roadmap/roadmap.json', 'docs/roadmap/roadmap.md'],
    bookkeepingSha: null
  };
  await repo.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await repo.implementationCommit('foreign.txt', 'foreign lineage\n');

  const result = await repo.rawCli(['resume', runId]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'CONFLICT');
  const unchanged = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  assert.equal(unchanged.revision, roadmap.revision);
  assert.equal(unchanged.nodes.find(node => node.id === 'P1.1.1').status, 'planned');
});

test('prepared settlement recovery rejects an exact-looking commit with forged roadmap bytes', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementationSha = await verifyCurrent(repo, runId, 'P1.1.1', 'exact-tree.txt');
  const journalPath = `.ddd/runs/${runId}.json`;
  const journal = JSON.parse(await repo.read(journalPath));
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  journal.revision += 1;
  journal.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440004',
    type: 'settle-item',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: 'P1.1.1',
    targetState: 'done',
    implementationSha,
    allowedPaths: ['docs/roadmap/roadmap.json', 'docs/roadmap/roadmap.md'],
    bookkeepingSha: null
  };
  await repo.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  roadmap.revision += 1;
  const item = roadmap.nodes.find(node => node.id === 'P1.1.1');
  item.status = 'done';
  item.title = 'forged controller output';
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.git(['add', '--', 'docs/roadmap/roadmap.json']);
  await repo.git(['commit', '-m', 'chore(roadmapctl): settle P1.1.1 as done']);

  const result = await repo.rawCli(['resume', runId]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'CONFLICT');
  const retainedJournal = JSON.parse(await repo.read(journalPath));
  assert.equal(retainedJournal.pendingTransaction.state, 'prepared');
});

test('resume recovers a prepared close exactly once', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const journalPath = `.ddd/runs/${runId}.json`;
  const journal = JSON.parse(await repo.read(journalPath));
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  journal.revision += 1;
  journal.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440002',
    type: 'close-run',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: null,
    targetState: null,
    implementationSha: journal.baselineSha,
    allowedPaths: ['docs/roadmap/roadmap.md', `docs/runs/${runId}.json`],
    bookkeepingSha: null
  };
  await repo.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovered = await repo.cli(['resume', runId]);
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.action, 'closed');
  const head = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  const recoveredJournal = JSON.parse(await repo.read(journalPath));
  assert.equal(recoveredJournal.pendingTransaction.state, 'committed');
  assert.equal(recoveredJournal.pendingTransaction.bookkeepingSha, head);
  assert.equal(recoveredJournal.events.at(-1).details.recovered, true);
  assert.equal(JSON.parse(await repo.read(`docs/runs/${runId}.json`)).status, 'blocked');
  await assert.rejects(repo.read('.ddd/active-run.json'));

  const repeated = await repo.cli(['resume', runId]);
  assert.deepEqual(repeated, recovered);
  assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.equal(JSON.parse(await repo.read(journalPath)).revision, recoveredJournal.revision);
});

test('prepared close recovery rejects a conflicting immutable report', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const journalPath = `.ddd/runs/${runId}.json`;
  const journal = JSON.parse(await repo.read(journalPath));
  const roadmap = JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
  journal.revision += 1;
  journal.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440005',
    type: 'close-run',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: null,
    targetState: null,
    implementationSha: journal.baselineSha,
    allowedPaths: ['docs/roadmap/roadmap.md', `docs/runs/${runId}.json`],
    bookkeepingSha: null
  };
  await repo.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await repo.write(`docs/runs/${runId}.json`, '{"forged":true}\n');

  const result = await repo.rawCli(['resume', runId]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'CONFLICT');
  assert.equal(JSON.parse(await repo.read(journalPath)).pendingTransaction.state, 'prepared');
});

test('resume clears a committed close pointer after the final crash window', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  assert.equal((await repo.cli(['close', runId])).status, 'blocked');
  await repo.write('.ddd/active-run.json', `${JSON.stringify({
    schemaVersion: 1,
    runId,
    journal: `.ddd/runs/${runId}.json`
  })}\n`);

  const resumed = await repo.cli(['resume', '--active']);
  assert.equal(resumed.status, 'blocked');
  assert.equal(resumed.action, 'closed');
  await assert.rejects(repo.read('.ddd/active-run.json'));
  const nextStart = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  assert.notEqual(nextStart.runId, runId);
});

test('missing audit blocks finish and close reports blocked rather than success', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const finished = await implementCurrent(repo, runId, 'P1.1.1', 'blocked.txt', { audit: false });
  assert.equal(finished.state, 'blocked');
  const terminal = await repo.cli(['next', runId]);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.outcome, 'blocked');
  assert.equal(terminal.action, 'close');
  assert.deepEqual(terminal.remaining, ['P1.1.1', 'P1.1.2']);
  assert.deepEqual(terminal.blockers['P1.1.2'], [{ itemId: 'P1.1.1', state: 'blocked' }]);
  const closed = await repo.cli(['close', runId]);
  assert.equal(closed.status, 'blocked');
  assert.notEqual((await repo.cli(['status', runId])).aggregates['P1.1'], 'done');
});

test('blocking audit fails finish and close reports failed', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const finished = await implementCurrent(repo, runId, 'P1.1.1', 'failed.txt', {
    counts: { CRIT: 0, HIGH: 1, MEDIUM: 0, LOW: 0 }
  });
  assert.equal(finished.state, 'failed');
  assert.equal((await repo.cli(['close', runId])).status, 'failed');
});

test('abort requires confirmation, preserves cancellation evidence, and never completes the parent', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  assert.notEqual((await repo.rawCli(['abort', runId])).exitCode, 0);
  const aborted = await repo.cli(['abort', runId, '--confirm']);
  assert.equal(aborted.status, 'cancelled');
  const status = await repo.cli(['status', runId]);
  assert.equal(status.leaves['P1.1.1'], 'cancelled');
  assert.notEqual(status.aggregates['P1.1'], 'done');
});

test('retry preserves prior attempts and the bounded budget closes as capped', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);

  for (let number = 1; number <= 3; number += 1) {
    if (number > 1) {
      const retried = await repo.cli(['retry', runId, 'P1.1.1', '--reason', `attempt ${number}`]);
      assert.equal(retried.attempt, number);
    }
    const finished = await implementCurrent(repo, runId, 'P1.1.1', `blocked-${number}.txt`, { audit: false });
    assert.equal(finished.state, 'blocked');
  }

  const exhausted = await repo.rawCli(['retry', runId, 'P1.1.1', '--reason', 'one too many']);
  assert.notEqual(exhausted.exitCode, 0);
  const status = await repo.cli(['status', runId]);
  assert.equal(status.attemptsRemaining['P1.1.1'], 0);
  assert.equal((await currentAttempt(repo, runId, 'P1.1.1')).number, 3);
  assert.equal((await repo.cli(['close', runId])).status, 'capped');
});
