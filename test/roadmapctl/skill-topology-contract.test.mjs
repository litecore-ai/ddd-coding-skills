import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const skillNames = [
  'ddd-init',
  'ddd-roadmap',
  'ddd-spec',
  'ddd-develop',
  'ddd-audit',
  'ddd-auto',
  'ddd-auto-cleanup'
];

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

function description(text) {
  const match = text.match(/^---\nname: [^\n]+\ndescription: ([^\n]+)\n---\n/);
  assert.ok(match, 'skill frontmatter must expose one description');
  return match[1];
}

test('planning ownership flows from draft roadmap specs to spec approval and binding', async () => {
  const [readme, roadmap, spec] = await Promise.all([
    source('README.md'),
    source('skills/ddd-roadmap/SKILL.md'),
    source('skills/ddd-spec/SKILL.md')
  ]);

  assert.match(readme, /`ddd-roadmap`[^\n]*draft JSON specs/);
  assert.match(readme, /`ddd-spec`[^\n]*bind approved spec hashes/);
  assert.match(roadmap, /Bootstrap specs remain `draft` until reviewed/);
  assert.match(roadmap, /hand off contract review, approval, and binding to `ddd-spec`/);
  assert.match(roadmap, /never marks a spec `approved` or calls `bind-spec`/);
  assert.match(roadmap, /`ddd-spec` is the only adapter that may promote and bind/);
  assert.match(roadmap, /exact inactive bootstrap result/);
  assert.match(spec, /Set the reviewed spec to `approved`, call `bind-spec/);
});

test('initialization hands planning off without absorbing roadmap responsibilities', async () => {
  const init = await source('skills/ddd-init/SKILL.md');

  assert.doesNotMatch(description(init), /migration planning|phase planning|scoped planning/i);
  assert.match(init, /hand off product intent, delivery sequencing, and draft specs to `ddd-roadmap`/);
  assert.match(init, /exact inactive bootstrap result/);
  assert.match(init, /do not invoke planning from this adapter/);
  assert.doesNotMatch(init, /use `ddd-roadmap` to create/i);
});

test('run recovery belongs to auto while cleanup remains explicit cancellation', async () => {
  const [auto, cleanup] = await Promise.all([
    source('skills/ddd-auto/SKILL.md'),
    source('skills/ddd-auto-cleanup/SKILL.md')
  ]);

  assert.doesNotMatch(description(cleanup), /recover|resume/i);
  assert.match(cleanup, /not run recovery/i);
  assert.match(cleanup, /resume or recover interrupted execution, use `ddd-auto`/i);
  assert.match(cleanup, /roadmapctl abort <run-id> --confirm/);
  assert.match(auto, /roadmapctl resume <run-id>/);
});

test('auto closes successful and non-success terminal runs through distinct controller paths', async () => {
  const [auto, protocol] = await Promise.all([
    source('skills/ddd-auto/SKILL.md'),
    source('references/roadmapctl-protocol.md')
  ]);

  for (const text of [auto, protocol]) {
    assert.match(text, /remaining`? is empty[^\n]*close[^\n]*--require-success/i);
    assert.match(text, /remaining`? is non-empty[^\n]*close[^\n]*without (?:that flag|`--require-success`)/i);
    assert.match(text, /blocked[^\n]*failed[^\n]*cancelled[^\n]*capped/i);
  }
  assert.match(auto, /terminal: true[^\n]*no item[^\n]*do not invoke development/i);
});

test('every roadmapctl command named by a skill is documented by the shared protocol', async () => {
  const [protocol, ...skills] = await Promise.all([
    source('references/roadmapctl-protocol.md'),
    ...skillNames.map(name => source(`skills/${name}/SKILL.md`))
  ]);
  const commandTable = protocol.slice(
    protocol.indexOf('## Command contract'),
    protocol.indexOf('The only valid status/resume actions')
  );
  const documented = new Set(
    [...commandTable.matchAll(/`([a-z][a-z-]*)(?:\s|`)/g)].map(match => match[1])
  );
  const referenced = new Set(
    skills.flatMap(text => [...text.matchAll(/`roadmapctl\s+([a-z][a-z-]*)/g)].map(match => match[1]))
  );
  const missing = [...referenced].filter(command => !documented.has(command)).sort();

  assert.deepEqual(missing, []);
  assert.match(commandTable, /`retry <run-id> <item-id> --reason <text>`/);
  assert.match(commandTable, /`abort <run-id> --confirm`/);
  assert.match(commandTable, /`attest[^\n]*`reportPath`/);
  assert.match(commandTable, /`status[^\n]*`leaves`[^\n]*`aggregates`/);
});

test('every skill reference document is reachable from its parent skill', async () => {
  for (const name of skillNames) {
    const skill = await source(`skills/${name}/SKILL.md`);
    let entries = [];
    try {
      entries = await readdir(new URL(`skills/${name}/references/`, root), { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const entry of entries.filter(candidate => candidate.isFile() && candidate.name.endsWith('.md'))) {
      assert.match(skill, new RegExp(`references/${entry.name.replaceAll('.', '\\.')}`));
    }
  }
});

test('audit scoring remains response-only, non-gating, and severity-compatible', async () => {
  const [audit, scoring] = await Promise.all([
    source('skills/ddd-audit/SKILL.md'),
    source('skills/ddd-audit/references/audit-scoring.md')
  ]);

  assert.match(description(audit), /exact Git snapshot/);
  assert.match(audit, /non-gating presentation scoring/);
  assert.match(audit, /render that score in the response and never add another report file/);
  assert.match(scoring, /never create or update `audit-report\.md`/);
  assert.match(scoring, /MEDIUM/);
  assert.match(scoring, /otherwise use weight `1\.0` for every dimension/);
  assert.doesNotMatch(scoring, /total_checklist_items|\bMED\b|Deployable|Production-ready/);
  assert.match(scoring, /Any CRIT or HIGH finding remains blocking regardless of score/);
});

test('execution delegation follows the declared skill topology', async () => {
  const [init, roadmap, auto, develop] = await Promise.all([
    source('skills/ddd-init/SKILL.md'),
    source('skills/ddd-roadmap/SKILL.md'),
    source('skills/ddd-auto/SKILL.md'),
    source('skills/ddd-develop/SKILL.md')
  ]);

  assert.match(init, /hand off[^\n]*`ddd-roadmap`/);
  assert.match(roadmap, /hand off[^\n]*`ddd-spec`/);
  assert.match(auto, /invoke `ddd-develop`/);
  assert.match(develop, /Invoke the read-only `ddd-audit` adapter/);
  assert.match(develop, /read `references\/subagent-prompts\.md`/);
});
