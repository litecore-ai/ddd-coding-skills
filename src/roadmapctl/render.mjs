import { randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { canonicalStringify, sha256 } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';
import { compareIds } from './ids.mjs';
import { deriveAggregate } from './state.mjs';

function markdown(value) {
  return String(value).replace(/([\\`*{}\[\]()#+.!_|>-])/g, '\\$1');
}

function attemptState(run, item) {
  if (run?.currentItemId !== item.id) return item.status;
  const attempts = run?.attempts?.[item.id];
  const attempt = Array.isArray(attempts) ? attempts.at(-1) : attempts;
  return attempt?.state ?? item.status;
}

function list(values) {
  return values.length === 0 ? 'none' : values.map(markdown).join(', ');
}

export function renderRoadmap(roadmap, run = null) {
  const nodes = [...roadmap.nodes].sort((left, right) => compareIds(left.id, right.id));
  const lines = [
    '<!-- GENERATED FILE. DO NOT EDIT; edit docs/roadmap/roadmap.json instead. -->',
    '',
    `# ${markdown(roadmap.project)} roadmap`,
    '',
    `Revision: ${roadmap.revision}`,
    '',
    `Evidence report: ${run?.runId ? `docs/roadmap/runs/${markdown(run.runId)}/report.json` : 'not available'}`,
    ''
  ];

  for (const node of nodes) {
    const state = node.kind === 'item' ? attemptState(run, node) : deriveAggregate(roadmap, node.id, run);
    const level = node.kind === 'phase' ? '##' : node.kind === 'feature' ? '###' : '####';
    lines.push(`${level} ${node.id} ${markdown(node.title)} — ${state}`, '');
    if (node.kind !== 'item') continue;
    lines.push(
      `- Status: ${state}`,
      `- Dependencies: ${list(node.dependsOn)}`,
      `- Outcome: ${markdown(node.outcome)}`,
      `- Consumers: ${list(node.consumers)}`,
      `- Required gates: ${list(node.requiredGates)}`,
      `- Evidence report: ${run?.runId ? `docs/roadmap/runs/${markdown(run.runId)}/report.json#${node.id}` : 'not available'}`,
      ''
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderSpec(spec) {
  const lines = [
    '<!-- GENERATED FILE. DO NOT EDIT; edit the canonical JSON spec instead. -->',
    '',
    `# ${spec.id} ${markdown(spec.title)}`,
    '',
    `Canonical hash: ${sha256(spec)}`,
    `Status: ${spec.status}`,
    `Consumers: ${list(spec.consumers)}`,
    `Shared contracts: ${list(spec.sharedContracts)}`,
    '',
    '## Acceptance criteria',
    ''
  ];
  for (const criterion of spec.acceptanceCriteria) {
    lines.push(
      `### ${criterion.id}`,
      '',
      `- Given: ${markdown(criterion.given)}`,
      `- When: ${markdown(criterion.when)}`,
      `- Then: ${markdown(criterion.then)}`,
      ''
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildRunReport(roadmap, run) {
  return {
    revision: roadmap.revision,
    runId: run.runId,
    schemaVersion: 1,
    status: run.status
  };
}

export async function writeImmutableReport(path, report, { fs = fileSystem, randomUUID: createId = randomUUID } = {}) {
  const desired = canonicalStringify(report);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${createId()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, desired, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await fs.link(temporaryPath, path);
      return { created: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(path, 'utf8');
      if (existing !== desired) {
        throw new RoadmapError('REPORT_CONFLICT', `immutable report differs: ${path}`, { path });
      }
      return { created: false };
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
