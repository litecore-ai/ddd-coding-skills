import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { roadmapFixture, runCli, twoLeafRoadmap } from './helpers.mjs';

function runLinkedCli(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

test('scope command emits structured leaves only', async t => {
  const repo = await roadmapFixture(twoLeafRoadmap({ first: 'planned', second: 'planned' }));
  t.after(repo.cleanup);
  const result = await runCli(repo.root, ['scope', 'P1.1']);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).items, ['P1.1.1', 'P1.1.2']);
  assert.equal(result.stderr, '');
});

test('unknown command is a usage error without a stack', async t => {
  const repo = await roadmapFixture();
  t.after(repo.cleanup);
  const result = await runCli(repo.root, ['unknown']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /USAGE/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('CLI executes when argv entry is an installed-style symlink', async t => {
  const repo = await roadmapFixture();
  t.after(repo.cleanup);
  const bin = fileURLToPath(new URL('../../bin/roadmapctl.mjs', import.meta.url));
  const linked = join(repo.root, 'roadmapctl-link.mjs');
  await symlink(bin, linked);
  const result = await runLinkedCli(linked, ['--root', repo.root, 'unknown']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'USAGE');
});

test('CLI diagnostics never echo root or selector secrets', async t => {
  const secretRoot = await mkdtemp(join(tmpdir(), 'SECRET_TOKEN-roadmapctl-'));
  t.after(() => rm(secretRoot, { recursive: true, force: true }));
  const missing = await runCli(secretRoot, ['validate']);
  assert.notEqual(missing.exitCode, 0);
  assert.doesNotMatch(missing.stderr, /SECRET_TOKEN|canonical roadmap JSON|\/private\/|\/var\/folders/);

  const repo = await roadmapFixture();
  t.after(repo.cleanup);
  const invalidScope = await runCli(repo.root, ['scope', 'P1.1,SECRET_TOKEN']);
  assert.notEqual(invalidScope.exitCode, 0);
  assert.doesNotMatch(invalidScope.stderr, /SECRET_TOKEN|P1\.1/);
});

test('validation errors are JSON with INVALID exit status', async t => {
  const roadmap = twoLeafRoadmap();
  roadmap.nodes[2].status = 'bogus';
  const repo = await roadmapFixture(roadmap);
  t.after(repo.cleanup);
  const result = await runCli(repo.root, ['validate']);
  assert.equal(result.exitCode, 3);
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.code, 'INVALID');
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('legacy Markdown-only roadmap is rejected as INVALID', async t => {
  const repo = await roadmapFixture();
  t.after(repo.cleanup);
  await repo.write('docs/roadmap/roadmap.json', '');
  await repo.write('docs/roadmap/roadmap.md', '# legacy\n');
  const result = await runCli(repo.root, ['validate']);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /INVALID/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('render rejects a roadmap directory symlink that escapes the repository', async t => {
  const repo = await roadmapFixture();
  t.after(repo.cleanup);
  const outside = await mkdtemp(join(tmpdir(), 'roadmap-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'roadmap.json'), `${JSON.stringify(twoLeafRoadmap(), null, 2)}\n`);
  await rm(join(repo.root, 'docs/roadmap'), { recursive: true, force: true });
  await symlink(outside, join(repo.root, 'docs/roadmap'));

  const result = await runCli(repo.root, ['render']);
  assert.notEqual(result.exitCode, 0);
  await assert.rejects(access(join(outside, 'roadmap.md')));
});
