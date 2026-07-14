import assert from 'node:assert/strict';
import test from 'node:test';

import { roadmapFixture, runCli, twoLeafRoadmap } from './helpers.mjs';

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
