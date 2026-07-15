import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { lifecycleFixture } from './helpers.mjs';

const root = new URL('../../', import.meta.url);
const source = path => readFile(new URL(path, root), 'utf8');

test('audit is a thin read-only exact-range evidence producer', async () => {
  const text = await source('skills/ddd-audit/SKILL.md');
  assert.match(text, /^---\nname: ddd-audit\ndescription: [^\n]+\n---\n/);
  assert.match(text, /roadmapctl-protocol\.md/);
  assert.match(text, /itemBaselineSha\.\.implementationSha/);
  assert.match(text, /controller-(?:provided|designated).*report path/is);
  for (const dimension of ['Design', 'Architecture', 'Quality', 'Security', 'Testing', 'Integration', 'Performance', 'Observability']) {
    assert.match(text, new RegExp(`\\b${dimension}\\b`));
  }
  assert.match(text, /CRIT.*HIGH.*block/is);
  assert.doesNotMatch(text, /Bash\(\*\)|PermissionRequest|\.ddd-auto\.local\.md/);
  assert.doesNotMatch(text, /auto-?fix|--fix\b|prettier --write|git add|git commit|git push|gh issue/i);
  assert.ok(text.split('\n').length <= 180);
});

test('audit references cannot mutate the audited repository or external systems', async () => {
  const text = await Promise.all([
    source('skills/ddd-audit/references/audit-config.md'),
    source('skills/ddd-audit/references/ci-cd-integration.md')
  ]).then(parts => parts.join('\n'));
  assert.match(text, /read-only/i);
  assert.doesNotMatch(text, /auto-?fix|--fix\b|prettier --write|git add|git commit|git push|gh issue create|post.*comment|create.*issue/i);
});

test('local permission template has only bounded project tools and controller prefixes', async () => {
  const text = await source('skills/ddd-init/references/permissions-template.md');
  assert.match(text, /"Read"/);
  assert.match(text, /"Write"/);
  assert.match(text, /Bash\(roadmapctl:\*\)/);
  assert.match(text, /gate manifest/i);
  assert.match(text, /sandbox|per-run approval/i);
  assert.doesNotMatch(text, /Bash\(\*\)|PermissionRequest|\.ddd-auto|"hooks"/);
  assert.doesNotMatch(text, /Bash\((?:bash|source|rm|curl|gh|git|npm|npx|pnpm|yarn|bun|pip|python|go|cargo|mvn|gradle|make|\.venv|node_modules)/i);
});

test('init checks runtime and creates controller state paths without installing tools', async () => {
  const text = await source('skills/ddd-init/SKILL.md');
  assert.match(text, /^---\nname: ddd-init\ndescription: [^\n]+\n---\n/);
  assert.match(text, /Node\.js 20|Node 20/);
  assert.match(text, /docs\/roadmap/);
  assert.match(text, /docs\/specs/);
  assert.match(text, /docs\/runs/);
  assert.match(text, /\.ddd\/runs\//);
  assert.match(text, /\.ddd\/active-run\.json/);
  assert.match(text, /roadmapctl validate/);
  assert.match(text, /roadmapctl-protocol\.md/);
  assert.doesNotMatch(text, /Bash\(\*\)|PermissionRequest|\.ddd-auto\.local\.md/);
  assert.doesNotMatch(text, /npm install|pnpm install|yarn install|pip install|brew install|apt(?:-get)? install/i);
  assert.ok(text.split('\n').length <= 180);
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

  assert.match(snapshot.attempt.auditReportPath, new RegExp(`^\\.ddd/audit-${runId}-${assigned.item.id}-attempt-1\\.json$`));
  const report = {
    schemaVersion: 1,
    schema: 'ddd-audit/v1',
    runId,
    itemId: assigned.item.id,
    baselineSha: snapshot.attempt.itemBaselineSha,
    implementationSha: snapshot.attempt.implementationSha,
    specHash: snapshot.attempt.specHash,
    counts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    findings: []
  };

  await repo.write('.ddd/wrong-audit.json', `${JSON.stringify(report)}\n`);
  const wrongPath = await repo.rawCli(['attest', runId, assigned.item.id, 'audit', '.ddd/wrong-audit.json']);
  assert.notEqual(wrongPath.exitCode, 0);

  await symlink('wrong-audit.json', join(repo.root, snapshot.attempt.auditReportPath));
  const linked = await repo.rawCli(['attest', runId, assigned.item.id, 'audit', snapshot.attempt.auditReportPath]);
  assert.notEqual(linked.exitCode, 0);
  await rm(join(repo.root, snapshot.attempt.auditReportPath));

  await repo.write(snapshot.attempt.auditReportPath, `${JSON.stringify({
    ...report,
    counts: { CRIT: 0, HIGH: 0, MEDIUM: 1, LOW: 0 }
  })}\n`);
  const inconsistent = await repo.rawCli(['attest', runId, assigned.item.id, 'audit', snapshot.attempt.auditReportPath]);
  assert.notEqual(inconsistent.exitCode, 0);

  await repo.write(snapshot.attempt.auditReportPath, `${JSON.stringify(report)}\n`);
  const attested = await repo.cli(['attest', runId, assigned.item.id, 'audit', snapshot.attempt.auditReportPath]);
  assert.equal(attested.status, 'passed');
});
