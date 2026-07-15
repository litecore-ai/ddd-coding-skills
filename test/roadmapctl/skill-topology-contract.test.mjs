import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const skillNames = ['ddd-roadmap', 'ddd-develop'];
const source = path => readFile(new URL(path, root), 'utf8');

test('the public topology contains exactly two coherent skills', async () => {
  const entries = await readdir(new URL('skills/', root), { withFileTypes: true });
  const actual = [];
  for (const entry of entries.filter(value => value.isDirectory())) {
    try {
      await source(`skills/${entry.name}/SKILL.md`);
      actual.push(entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.deepEqual(actual.sort(), [...skillNames].sort());
});

test('roadmap owns bootstrap through reviewed spec binding and hands one selector to develop', async () => {
  const text = await source('skills/ddd-roadmap/SKILL.md');
  assert.match(text, /owns bootstrap, architecture guidance, roadmap structure, spec review, and binding/i);
  assert.match(text, /bind-spec <feature-id> <spec-path>/);
  assert.match(text, /Hand implementation to `ddd-develop` with the exact selector/i);
  assert.doesNotMatch(text, /hand off.*ddd-(?:init|spec|audit|auto)/i);
});

test('develop owns ad-hoc and formal execution without skill chaining', async () => {
  const text = await source('skills/ddd-develop/SKILL.md');
  assert.match(text, /single implementation entry point/i);
  assert.match(text, /Roadmap:/);
  assert.match(text, /Ad-hoc:/);
  assert.match(text, /Cancel:/);
  assert.match(text, /exact-range audit/i);
  assert.doesNotMatch(text, /invoke `ddd-/i);
});

test('all skill-referenced controller commands are documented', async () => {
  const [protocol, ...skills] = await Promise.all([
    source('references/roadmapctl-protocol.md'),
    ...skillNames.map(name => source(`skills/${name}/SKILL.md`))
  ]);
  const commandTable = protocol.slice(protocol.indexOf('## Command contract'), protocol.indexOf('## Action loop'));
  const documented = new Set(
    [...commandTable.matchAll(/`([a-z][a-z-]*)(?:\s|`)/g)].map(match => match[1])
  );
  const referenced = new Set(
    skills.flatMap(text => [...text.matchAll(/`(?:roadmapctl\s+)?([a-z][a-z-]*)(?:\s+<|\s+--)/g)].map(match => match[1]))
  );
  const controllerCommands = new Set(['validate', 'scope', 'render', 'hash-file', 'bind-spec', 'start', 'next', 'record', 'verify', 'attest', 'finish', 'status', 'resume', 'retry', 'abort', 'close']);
  const missing = [...referenced].filter(command => controllerCommands.has(command) && !documented.has(command)).sort();
  assert.deepEqual(missing, []);
});

test('every retained skill reference is reachable from its parent', async () => {
  for (const name of skillNames) {
    const skill = await source(`skills/${name}/SKILL.md`);
    let entries = [];
    try {
      entries = await readdir(new URL(`skills/${name}/references/`, root), { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const entry of entries.filter(value => value.isFile() && value.name.endsWith('.md'))) {
      assert.match(skill, new RegExp(`references/${entry.name.replaceAll('.', '\\.')}`));
    }
  }
});

test('README presents the same two-skill flow and compact controller contract', async () => {
  const text = await source('README.md');
  assert.match(text, /Two skills/);
  assert.match(text, /Setup, specification, automation, audit, and cleanup are workflow stages/i);
  assert.match(text, /controller reads are compact by default/i);
  assert.match(text, /`ddd-roadmap`.*`ddd-develop`/is);
});
