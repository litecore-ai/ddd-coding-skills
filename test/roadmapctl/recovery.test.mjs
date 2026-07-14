import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

import { canonicalStringify } from '../../src/roadmapctl/canonical-json.mjs';
import { buildRunReport, renderRoadmap } from '../../src/roadmapctl/render.mjs';
import { lifecycleFixture } from './helpers.mjs';

const ITEM_ID = 'P1.1.1';
const SETTLE_SUBJECT = `chore(roadmapctl): settle ${ITEM_ID} as done`;

async function readRun(repo, runId) {
  return JSON.parse(await repo.read(`.ddd/runs/${runId}.json`));
}

async function readRoadmap(repo) {
  return JSON.parse(await repo.read('docs/roadmap/roadmap.json'));
}

async function subjectCount(repo, subject) {
  const log = (await repo.git(['log', '--format=%s'])).stdout.split('\n').filter(Boolean);
  return log.filter(candidate => candidate === subject).length;
}

async function prepareVerifiedAttempt(repo) {
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  await repo.cli(['next', runId]);
  const implementationSha = await repo.implementationCommit('recovery-feature.txt', 'verified implementation\n');
  await repo.cli(['record', runId, ITEM_ID, '--commit', implementationSha, '--ac', 'AC-P1.1-001']);
  await repo.cli(['verify', runId, ITEM_ID]);
  const run = await readRun(repo, runId);
  const bindings = run.attempts[ITEM_ID][0].evidence.tests.bindings;
  const audit = {
    gate: 'audit',
    type: 'attestation',
    producer: 'ddd-audit',
    schema: 'ddd-audit/v1',
    status: 'passed',
    bindings,
    auditRange: { from: bindings.itemBaselineSha, to: bindings.implementationSha },
    auditCounts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  };
  await repo.write('.ddd/recovery-audit.json', `${JSON.stringify(audit, null, 2)}\n`);
  await repo.cli(['attest', runId, ITEM_ID, 'audit', '.ddd/recovery-audit.json']);
  const attested = await readRun(repo, runId);
  return {
    runId,
    implementationSha,
    attemptBefore: structuredClone(attested.attempts[ITEM_ID][0])
  };
}

async function injectPreparedSettlement(repo, runId, implementationSha, point) {
  const run = await readRun(repo, runId);
  const roadmap = await readRoadmap(repo);
  run.revision += 1;
  run.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440010',
    type: 'settle-item',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: ITEM_ID,
    targetState: 'done',
    implementationSha,
    allowedPaths: ['docs/roadmap/roadmap.json', 'docs/roadmap/roadmap.md'],
    bookkeepingSha: null
  };
  await repo.write(`.ddd/runs/${runId}.json`, `${JSON.stringify(run, null, 2)}\n`);

  const settledRoadmap = {
    ...roadmap,
    revision: roadmap.revision + 1,
    nodes: roadmap.nodes.map(node => node.id === ITEM_ID ? { ...node, status: 'done' } : node)
  };
  if (point !== 'prepare') {
    await repo.write('docs/roadmap/roadmap.json', canonicalStringify(settledRoadmap));
  }
  if (['generated-view', 'bookkeeping-commit'].includes(point)) {
    await repo.write('docs/roadmap/roadmap.md', renderRoadmap(settledRoadmap, { ...run, currentItemId: null }));
  }
  if (point === 'bookkeeping-commit') {
    await repo.git(['add', '--', 'docs/roadmap/roadmap.json', 'docs/roadmap/roadmap.md']);
    await repo.git(['commit', '-m', SETTLE_SUBJECT]);
  }
  return { originalRevision: roadmap.revision };
}

for (const point of ['prepare', 'roadmap-write', 'generated-view', 'bookkeeping-commit']) {
  test(`settlement recovery is idempotent after ${point}`, async t => {
    const repo = await lifecycleFixture();
    t.after(repo.cleanup);
    const { runId, implementationSha, attemptBefore } = await prepareVerifiedAttempt(repo);
    const { originalRevision } = await injectPreparedSettlement(repo, runId, implementationSha, point);

    const first = await repo.cli(['resume', runId]);
    const firstHead = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
    const firstRun = await readRun(repo, runId);
    const second = await repo.cli(['resume', runId]);
    const secondRun = await readRun(repo, runId);

    assert.deepEqual(second, first);
    assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), firstHead);
    assert.equal(secondRun.revision, firstRun.revision);
    assert.equal((await readRoadmap(repo)).revision, originalRevision + 1);
    assert.equal((await readRoadmap(repo)).nodes.find(node => node.id === ITEM_ID).status, 'done');
    assert.equal(await subjectCount(repo, SETTLE_SUBJECT), 1);
    const recoveredAttempt = secondRun.attempts[ITEM_ID][0];
    assert.equal(recoveredAttempt.state, 'done');
    assert.deepEqual(recoveredAttempt.evidence, attemptBefore.evidence);
    assert.deepEqual(recoveredAttempt.acIds, attemptBefore.acIds);
    assert.deepEqual(recoveredAttempt.changedFiles, attemptBefore.changedFiles);
    assert.equal(recoveredAttempt.itemBaselineSha, attemptBefore.itemBaselineSha);
    assert.equal(recoveredAttempt.implementationSha, attemptBefore.implementationSha);

    assert.equal((await repo.cli(['close', runId])).status, 'blocked');
    const report = JSON.parse(await repo.read(`docs/runs/${runId}.json`));
    const reportedAttempt = report.items[ITEM_ID].attempts[0];
    assert.deepEqual(reportedAttempt.evidence, attemptBefore.evidence);
    assert.deepEqual(reportedAttempt.acIds, attemptBefore.acIds);
    assert.deepEqual(reportedAttempt.changedFiles, attemptBefore.changedFiles);
    assert.equal(reportedAttempt.itemBaselineSha, attemptBefore.itemBaselineSha);
    assert.equal(reportedAttempt.implementationSha, attemptBefore.implementationSha);
    assert.deepEqual(await readdir(`${repo.root}/docs/runs`), [`${runId}.json`]);
    const closedHead = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
    await repo.cli(['resume', runId]);
    assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), closedHead);
    assert.deepEqual(await readdir(`${repo.root}/docs/runs`), [`${runId}.json`]);
  });
}

async function injectPreparedClose(repo, runId, point) {
  const run = await readRun(repo, runId);
  const roadmap = await readRoadmap(repo);
  const expectedParent = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  run.revision += 1;
  run.pendingTransaction = {
    id: 'tx-550e8400-e29b-41d4-a716-446655440011',
    type: 'close-run',
    state: 'prepared',
    expectedRoadmapRevision: roadmap.revision,
    itemId: null,
    targetState: null,
    implementationSha: expectedParent,
    allowedPaths: ['docs/roadmap/roadmap.md', `docs/runs/${runId}.json`],
    bookkeepingSha: null
  };
  await repo.write(`.ddd/runs/${runId}.json`, `${JSON.stringify(run, null, 2)}\n`);
  const closingRun = { ...run, status: 'blocked' };
  const subject = `chore(roadmapctl): close ${runId} as blocked`;
  if (['report-write', 'final-commit'].includes(point)) {
    await repo.write(`docs/runs/${runId}.json`, canonicalStringify(buildRunReport(roadmap, closingRun)));
  }
  if (point === 'final-commit') {
    await repo.write('docs/roadmap/roadmap.md', renderRoadmap(roadmap, closingRun));
    await repo.git(['add', '--', 'docs/roadmap/roadmap.md', `docs/runs/${runId}.json`]);
    await repo.git(['commit', '-m', subject]);
  }
  return { roadmapRevision: roadmap.revision, subject };
}

for (const point of ['report-write', 'final-commit']) {
  test(`close recovery is idempotent after ${point}`, async t => {
    const repo = await lifecycleFixture();
    t.after(repo.cleanup);
    const { runId } = await prepareVerifiedAttempt(repo);
    assert.equal((await repo.cli(['finish', runId, ITEM_ID])).state, 'done');
    const settledRun = await readRun(repo, runId);
    const settledAttempt = structuredClone(settledRun.attempts[ITEM_ID][0]);
    const { roadmapRevision, subject } = await injectPreparedClose(repo, runId, point);

    const first = await repo.cli(['resume', runId]);
    const firstHead = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
    const firstRun = await readRun(repo, runId);
    const second = await repo.cli(['resume', runId]);
    const secondRun = await readRun(repo, runId);

    assert.deepEqual(second, first);
    assert.equal(first.status, 'blocked');
    assert.equal((await repo.git(['rev-parse', 'HEAD'])).stdout.trim(), firstHead);
    assert.equal(secondRun.revision, firstRun.revision);
    assert.equal((await readRoadmap(repo)).revision, roadmapRevision);
    assert.equal(await subjectCount(repo, subject), 1);
    const report = JSON.parse(await repo.read(`docs/runs/${runId}.json`));
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.items[ITEM_ID].attempts[0].evidence, settledAttempt.evidence);
    assert.deepEqual(report.items[ITEM_ID].attempts[0].acIds, settledAttempt.acIds);
    assert.deepEqual(secondRun.attempts[ITEM_ID][0], settledAttempt);
    assert.deepEqual(await readdir(`${repo.root}/docs/runs`), [`${runId}.json`]);
  });
}
