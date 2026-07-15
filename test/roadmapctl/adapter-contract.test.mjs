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
const source = path => readFile(new URL(path, root), 'utf8');

test('the two user-facing skills are concise, model-native, and controller-backed', async () => {
  for (const name of ['ddd-roadmap', 'ddd-develop']) {
    const text = await source(`skills/${name}/SKILL.md`);
    const frontmatter = text.match(/^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n/);
    assert.ok(frontmatter);
    assert.equal(frontmatter[1], name);
    assert.match(text, /roadmapctl/);
    assert.match(text, /roadmapctl-protocol\.md/);
    assert.doesNotMatch(text, /read .*roadmapctl-protocol\.md.*in full/i);
    assert.doesNotMatch(text, /Bash\(\*\)|PermissionRequest|--skip-spec/);
    assert.ok(text.split('\n').length <= 120);
  }
});

test('develop owns progressive execution, real consumer closure, audit, recovery, and cancellation', async () => {
  const text = await source('skills/ddd-develop/SKILL.md');
  for (const term of ['status --active', 'next <run-id>', 'record', 'verify', 'attest', 'finish', 'abort <run-id> --confirm']) {
    assert.match(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(text, /real consumer/i);
  assert.match(text, /parallel models|duplicate ports|shadow adapters/i);
  assert.match(text, /blocked.*failed.*cancelled.*capped/is);
  assert.match(text, /remaining.*empty.*close --require-success/is);
  assert.match(text, /never retry without user approval/i);
  assert.doesNotMatch(text, /invoke `ddd-(?:auto|audit|cleanup)`/i);
});

test('Stop hook is a compact bounded liveness bridge to ddd-develop', async () => {
  const text = await source('hooks/stop-hook.sh');
  assert.match(text, /resume --active/);
  assert.match(text, /Resume DDD run .* with ddd-develop/);
  assert.doesNotMatch(text, /\bjq\b|transcript|awk|grep|\brm\b/);
  const hooks = JSON.parse(await source('hooks/hooks.json'));
  assert.equal(hooks.hooks.Stop.length, 1);
});

test('Stop hook blocks only for a validated active run and injects no item payload', async t => {
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
    : { runId: 'run-safe_1', status: 'active', action: 'next', remaining: ['P1.1.2'] };
process.stdout.write(JSON.stringify(value));
`);
  const hook = new URL('hooks/stop-hook.sh', root);
  await chmod(hook, 0o755);
  const run = mode => execFileAsync('bash', [hook.pathname], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: projectRoot, FAKE_CONTROLLER_MODE: mode },
    input: '{}',
    encoding: 'utf8'
  });

  const active = await run('active');
  assert.deepEqual(JSON.parse(active.stdout), {
    decision: 'block',
    reason: 'Resume DDD run run-safe_1 with ddd-develop; obtain item data from compact roadmapctl output.'
  });
  assert.equal((await run('terminal')).stdout, '');
  assert.equal((await run('error')).stdout, '');
  assert.equal((await run('invalid')).stdout, '');
});

test('compact status restores the exact active item bindings', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const assigned = await repo.cli(['next', runId]);
  const resumed = await repo.cli(['resume', runId]);
  assert.equal(resumed.action, 'record');
  assert.equal(resumed.item.id, assigned.item.id);
  assert.equal(resumed.attempt.itemBaselineSha, assigned.itemBaselineSha);
  assert.equal(resumed.item.spec.models[0].fields, undefined);
  assert.equal(resumed.leaves, undefined);
});

test('confirmed abort preserves a terminal report', async t => {
  const repo = await lifecycleFixture();
  t.after(repo.cleanup);
  const { runId } = await repo.cli(['start', 'P1.1', '--manifest-approved']);
  const result = await repo.cli(['abort', runId, '--confirm']);
  assert.equal(result.status, 'blocked');
  assert.match(result.reportPath, new RegExp(`^docs/runs/${runId}\\.json$`));
});
