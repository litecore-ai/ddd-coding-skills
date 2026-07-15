#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const expectedVersion = '3.0.0';
const errors = [];

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function fail(path, message, line = null) {
  errors.push(`${path}${line === null ? '' : `:${line}`}: ${message}`);
}

const tracked = execFileSync('git', ['ls-files'], {
  cwd: root,
  encoding: 'utf8',
  shell: false
}).split('\n').filter(Boolean);
const inspected = tracked.filter(path => path.startsWith('skills/')
  || path.startsWith('hooks/')
  || path.startsWith('.codex/')
  || path.startsWith('.claude-plugin/')
  || path === 'README.md'
  || path === 'README.zh-CN.md');

const forbidden = [
  [/Bash\(\*\)/g, 'wildcard shell permission'],
  [/PermissionRequest[\s\S]{0,500}decision[\s\S]{0,100}allow/gi, 'automatic permission approval'],
  [/\.ddd-auto\.local\.md/g, 'legacy prose state'],
  [/DONE_WITH_WARNING|UNWIRED/g, 'pseudo-completion state'],
  [/flip every `?- \[ \]`?/gi, 'direct checkbox completion'],
  [/mark completed items with `?\[x\]`?/gi, 'direct checkbox completion'],
  [/--skip-spec/g, 'spec-gate bypass']
];

for (const path of inspected) {
  const text = read(path);
  for (const [pattern, message] of forbidden) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) fail(path, message, lineAt(text, match.index));
  }
}

const skillPaths = tracked.filter(path => /^skills\/[^/]+\/SKILL\.md$/.test(path));
for (const path of skillPaths) {
  const text = read(path);
  const name = path.split('/')[1];
  const frontmatter = text.match(/^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n/);
  if (!frontmatter) fail(path, 'frontmatter must contain only name and description', 1);
  else if (frontmatter[1] !== name) fail(path, `frontmatter name must equal ${name}`, 2);
  if (!text.includes('references/roadmapctl-protocol.md')) fail(path, 'skill must link the shared controller protocol');
  if (text.split('\n').length > 180) fail(path, 'skill must remain a thin adapter (maximum 180 lines)');
}

const packageJson = JSON.parse(read('package.json'));
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
for (const [path, version] of [
  ['package.json', packageJson.version],
  ['.claude-plugin/plugin.json', plugin.version],
  ['.claude-plugin/marketplace.json', marketplace.plugins?.[0]?.version]
]) {
  if (version !== expectedVersion) fail(path, `version must be ${expectedVersion}`);
}
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
  if (Object.hasOwn(packageJson, field)) fail('package.json', `${field} must be absent`);
}
if (packageJson.engines?.node !== '>=20') fail('package.json', 'Node.js engine must be >=20');
if (packageJson.scripts?.check !== 'node --test && node scripts/check-skill-contracts.mjs') {
  fail('package.json', 'npm run check must run tests then skill conformance');
}

for (const path of ['README.md', 'README.zh-CN.md']) {
  const text = read(path);
  for (const required of ['Node.js 20', 'roadmap.json', 'Codex', 'Claude Code']) {
    if (!text.includes(required)) fail(path, `must name ${required}`);
  }
  if (!/breaking|破坏性/i.test(text) || !/regenerate|重新生成/i.test(text)) {
    fail(path, 'must explain the breaking regeneration requirement');
  }
  if (!text.includes('validate → start → next → record → verify → audit → attest → finish → close')) {
    fail(path, 'must document the exact controller lifecycle');
  }
}

const codexInstall = read('.codex/INSTALL.md');
for (const required of ['bin/roadmapctl.mjs', 'PATH', 'skills']) {
  if (!codexInstall.includes(required)) fail('.codex/INSTALL.md', `must install ${required}`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('skill contracts: valid\n');
}
