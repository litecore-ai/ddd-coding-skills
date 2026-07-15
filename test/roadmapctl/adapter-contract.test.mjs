import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { lifecycleFixture } from './helpers.mjs';

const execFileAsync = promisify(execFile);
const root = new URL('../../', import.meta.url);
const adapterFiles = [
  'skills/ddd-develop/SKILL.md',
  'skills/ddd-auto/SKILL.md',
  'skills/ddd-auto-cleanup/SKILL.md'
];

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Sol-native adapters are thin controller clients with no legacy authority paths', async () => {
  for (const file of adapterFiles) {
    const text = await source(file);
    const expectedName = file.split('/').at(-2);
    const frontmatter = text.match(/^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n/);
    assert.ok(frontmatter, `${file} must have only name and description frontmatter`);
    assert.equal(frontmatter[1], expectedName);
    assert.ok(frontmatter[2].length <= 1024);
    assert.doesNotMatch(text, /Bash\(\*\)|PermissionRequest|\.ddd-auto\.local\.md/);
    assert.doesNotMatch(text, /flip every|mark.*\[x\]|UNWIRED|DONE_WITH_WARNING|--skip-spec/i);
    assert.doesNotMatch(text, /parse.*markdown|unchecked.*checkbox|checkbox.*state/i);
    assert.match(text, /roadmapctl/);
    assert.match(text, /roadmapctl-protocol\.md/);
    assert.ok(text.split('\n').length <= 180, `${file} is not a thin Sol-native adapter`);
  }
});

test('auto treats one completed leaf with remaining work as continuation, never batch success', async () => {
  const text = await source('skills/ddd-auto/SKILL.md');
  assert.match(text, /finish.*is not.*batch.*terminal/is);
  assert.match(text, /remaining.*non-empty.*next/is);
  assert.match(text, /unknown.*action.*hard error/is);
  assert.match(text, /blocked|failed|cancelled|capped/);
  assert.doesNotMatch(text, /skipp?ed.*success/i);
});

test('develop binds one controller item to commit, AC, gates, audit, and finish', async () => {
  const text = await source('skills/ddd-develop/SKILL.md');
  for (const command of ['status', 'record', 'verify', 'attest', 'finish']) {
    assert.match(text, new RegExp(`roadmapctl[^\\n]*${command}|${command}[^\\n]*roadmapctl`, 'i'));
  }
  assert.match(text, /exact.*itemBaselineSha.*implementationSha/is);
  assert.match(text, /never push/i);
  assert.match(text, /ad-hoc.*cannot.*roadmap/is);
});

test('cleanup preserves evidence and requires confirmation before abort', async () => {
  const text = await source('skills/ddd-auto-cleanup/SKILL.md');
  assert.match(text, /status --active/);
  assert.match(text, /explicit.*confirmation/is);
  assert.match(text, /abort.*--confirm/);
  assert.doesNotMatch(text, /\brm\b|delete.*\.ddd|remove.*state/i);
});

test('Stop hook is a bounded roadmapctl liveness bridge', async () => {
  const text = await source('hooks/stop-hook.sh');
  assert.match(text, /resume --active/);
  assert.match(text, /Resume ddd-auto run .* by invoking the ddd-auto adapter; obtain all item data from roadmapctl\./);
  assert.doesNotMatch(text, /\bjq\b|transcript|\.ddd-auto|awk|grep|\brm\b/);
  const hooks = JSON.parse(await source('hooks/hooks.json'));
  assert.equal(hooks.hooks.Stop.length, 1);
});

test('Stop hook blocks only for a validated active run and injects no controller data', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'roadmapctl-hook-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const pluginRoot = join(fixture, 'plugin');
  const projectRoot = join(fixture, 'project');
  const controller = join(pluginRoot, 'bin/roadmapctl.mjs');
  await Promise.all([mkdir(dirname(controller), { recursive: true }), mkdir(projectRoot)]);
  await writeFile(controller, `
const mode = process.env.FAKE_CONTROLLER_MODE;
if (mode === 'error') process.exit(3);
const value = mode === 'terminal'
  ? { runId: 'run-closed', status: 'successful', action: 'closed', remaining: [] }
  : mode === 'invalid'
    ? { runId: 'run;injected', status: 'active', action: 'next', remaining: ['P1.1.2'] }
    : { runId: 'run-safe_1', status: 'active', action: 'next', remaining: ['P1.1.2','P1.1.3','P1.1.4','P1.1.5','P1.1.6','P1.1.7'] };
process.stdout.write(JSON.stringify(value));
`);
  const hook = new URL('hooks/stop-hook.sh', root);
  await chmod(hook, 0o755);
  const run = mode => execFileAsync('bash', [hook.pathname], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: projectRoot,
      FAKE_CONTROLLER_MODE: mode
    },
    input: '{"transcript_path":"untrusted","session_id":"untrusted"}',
    encoding: 'utf8'
  });

  const active = await run('active');
  assert.deepEqual(JSON.parse(active.stdout), {
    decision: 'block',
    reason: 'Resume ddd-auto run run-safe_1 by invoking the ddd-auto adapter; obtain all item data from roadmapctl.'
  });
  assert.equal(active.stderr, '');
  assert.equal((await run('terminal')).stdout, '');
  assert.equal((await run('error')).stdout, '');
  assert.equal((await run('invalid')).stdout, '');
});

test('status and resume restore the exact controller-issued item and attempt context', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);

  const assigned = await repo.cli(['next', runId]);
  assert.equal(assigned.itemBaselineSha.length, 40);
  const status = await repo.cli(['status', runId]);
  const resumed = await repo.cli(['resume', runId]);

  for (const snapshot of [status, resumed]) {
    assert.equal(snapshot.action, 'record');
    assert.equal(snapshot.item.id, assigned.item.id);
    assert.equal(snapshot.item.spec.id, assigned.item.spec.id);
    assert.equal(snapshot.attempt.number, 1);
    assert.equal(snapshot.attempt.state, 'in_progress');
    assert.equal(snapshot.attempt.itemBaselineSha, assigned.itemBaselineSha);
    assert.equal(snapshot.attempt.implementationSha, null);
  }
});

test('confirmed abort closes an active run even before a leaf is assigned', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);

  const result = await repo.cli(['abort', runId, '--confirm']);
  assert.equal(result.runId, runId);
  assert.equal(result.status, 'blocked');
  assert.match(result.reportPath, new RegExp(`^docs/runs/${runId}\\.json$`));

  const status = await repo.cli(['resume', runId]);
  assert.equal(status.status, 'blocked');
  assert.equal(status.action, 'closed');
});
