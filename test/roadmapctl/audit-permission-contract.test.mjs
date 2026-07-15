import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { lifecycleFixture } from './helpers.mjs';

const root = new URL('../../', import.meta.url);
const source = path => readFile(new URL(path, root), 'utf8');

test('audit and permission boundaries are internal stages of ddd-develop', async () => {
  const text = await source('skills/ddd-develop/SKILL.md');
  assert.match(text, /baseline-to-implementation range/i);
  assert.match(text, /CRIT\/HIGH blocks/i);
  assert.match(text, /network, credentials, installs, destructive actions, push\/deploy, or external writes/i);
  assert.match(text, /never push/i);
  assert.doesNotMatch(text, /auto-?fix|--fix\b|prettier --write|gh issue create/i);
});

test('roadmap bootstrap does not install tools or create layer stubs', async () => {
  const text = await source('skills/ddd-roadmap/SKILL.md');
  assert.match(text, /missing roadmap is a supported bootstrap state/i);
  assert.match(text, /do not move production code/i);
  assert.match(text, /do not duplicate long templates or generate empty/i);
  assert.doesNotMatch(text, /npm install|pnpm install|yarn install|pip install|brew install|apt(?:-get)? install/i);
});

test('controller designates the only accepted audit path and validates detailed report truth', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const assigned = await repo.cli(['next', runId]);
  const implementationSha = await repo.implementationCommit('profile.mjs', 'export const profile = true;\n');
  await repo.cli(['record', runId, assigned.item.id, '--commit', implementationSha, '--ac', 'AC-P1.1-001']);
  await repo.cli(['verify', runId, assigned.item.id]);
  const snapshot = await repo.cli(['status', runId]);

  const report = {
    schemaVersion: 1,
    schema: 'ddd-review/v1',
    runId,
    itemId: assigned.item.id,
    baselineSha: snapshot.attempt.itemBaselineSha,
    implementationSha: snapshot.attempt.implementationSha,
    specHash: snapshot.attempt.specHash,
    counts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    findings: []
  };

  await repo.write('.ddd/wrong-audit.json', `${JSON.stringify(report)}\n`);
  assert.notEqual((await repo.rawCli(['attest', runId, assigned.item.id, 'audit', '.ddd/wrong-audit.json'])).exitCode, 0);

  await symlink('wrong-audit.json', join(repo.root, snapshot.attempt.auditReportPath));
  assert.notEqual((await repo.rawCli(['attest', runId, assigned.item.id, 'audit', snapshot.attempt.auditReportPath])).exitCode, 0);
  await rm(join(repo.root, snapshot.attempt.auditReportPath));

  await repo.write(snapshot.attempt.auditReportPath, `${JSON.stringify({
    ...report,
    counts: { CRIT: 0, HIGH: 0, MEDIUM: 1, LOW: 0 }
  })}\n`);
  assert.notEqual((await repo.rawCli(['attest', runId, assigned.item.id, 'audit', snapshot.attempt.auditReportPath])).exitCode, 0);

  await repo.write(snapshot.attempt.auditReportPath, `${JSON.stringify(report)}\n`);
  assert.equal((await repo.cli(['attest', runId, assigned.item.id, 'audit', snapshot.attempt.auditReportPath])).status, 'passed');
});
