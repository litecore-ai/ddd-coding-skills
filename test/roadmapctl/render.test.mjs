import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRunReport, renderRoadmap, renderSpec, writeImmutableReport } from '../../src/roadmapctl/render.mjs';
import { RoadmapError } from '../../src/roadmapctl/errors.mjs';
import { twoLeafRoadmap, validRun, validSpec } from './helpers.mjs';

test('rendered parent remains in progress while any leaf is incomplete', () => {
  const roadmap = twoLeafRoadmap({ first: 'done', second: 'planned' });
  const markdown = renderRoadmap(roadmap, { currentItemId: null, attempts: {} });
  assert.match(markdown, /P1\.1 .*in_progress/);
  assert.match(markdown, /P1\.1\.2 .*planned/);
  assert.doesNotMatch(markdown, /\[x\].*P1\.1 .*Profile/);
  assert.doesNotMatch(markdown, /\[[ xX]\]/);
});

test('rendering is byte-identical and escapes Markdown content', () => {
  const roadmap = twoLeafRoadmap({ first: 'done', second: 'done' });
  roadmap.nodes[1].title = 'Profile [public] *API*';
  const first = renderRoadmap(roadmap, validRun());
  assert.equal(renderRoadmap(roadmap, validRun()), first);
  assert.ok(first.includes('Profile \\[public\\] \\*API\\*'));
  assert.match(first, /P1\.1 .*done/);
  assert.match(first, /generated/i);
});

test('spec rendering includes stable AC ids and canonical hash', () => {
  const markdown = renderSpec(validSpec());
  assert.match(markdown, /AC-P1\.1-001/);
  assert.match(markdown, /sha256:[a-f0-9]{64}/);
  assert.equal(renderSpec(validSpec()), markdown);
});

test('run report is canonical, ordered, and redacted', () => {
  const report = buildRunReport(twoLeafRoadmap(), validRun({
    root: '/private/project', lockToken: 'secret', environment: { TOKEN: 'secret' }, rawOutput: 'secret'
  }));
  const text = JSON.stringify(report);
  assert.deepEqual(Object.keys(report), [...Object.keys(report)].sort());
  assert.doesNotMatch(text, /\/private\/project|lockToken|TOKEN|rawOutput|secret/);
});

test('immutable report is exclusive and conflicts when bytes differ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-report-'));
  const path = join(root, 'report.json');
  try {
    const results = await Promise.allSettled([
      writeImmutableReport(path, { result: 'one' }),
      writeImmutableReport(path, { result: 'two' })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected.reason instanceof RoadmapError);
    assert.equal(rejected.reason.code, 'REPORT_CONFLICT');
    assert.ok(['one', 'two'].includes(JSON.parse(await readFile(path, 'utf8')).result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
