import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { canonicalStringify, sha256 } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';
import { compareIds } from './ids.mjs';
import { deriveAggregate } from './state.mjs';

function markdown(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*{}\[\]()#+.!_|~\-])/g, '\\$1');
}

function unsafeReport(path, causeCode = null) {
  return new RoadmapError('UNSAFE_REPORT_PATH', 'immutable report path is not a regular file', {
    causeCode,
    path
  });
}

async function readImmutableRegular(path, fs) {
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error.code)) throw unsafeReport(path, error.code);
    throw error;
  }
  try {
    const handleStat = await handle.stat({ bigint: true });
    if (!handleStat.isFile()) throw unsafeReport(path);
    const pathStat = await fs.lstat(path, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()
        || pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
      throw unsafeReport(path);
    }
    const contents = await handle.readFile({ encoding: 'utf8' });
    const after = await fs.lstat(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink()
        || after.dev !== handleStat.dev || after.ino !== handleStat.ino) {
      throw unsafeReport(path);
    }
    return contents;
  } finally {
    await handle.close();
  }
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

function reportEvidence(evidence) {
  const normalized = {};
  for (const gateName of Object.keys(evidence ?? {}).sort()) {
    const record = evidence[gateName];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const safe = {
      gate: record.gate,
      status: record.status,
      bindings: record.bindings
    };
    if (record.type === 'attestation') {
      Object.assign(safe, {
        type: record.type,
        producer: record.producer,
        schema: record.schema,
        auditRange: record.auditRange,
        auditCounts: record.auditCounts
      });
    } else {
      Object.assign(safe, {
        processClass: record.processClass,
        exitCode: record.exitCode,
        signal: record.signal,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        artifacts: record.artifacts,
        acIds: record.acIds,
        stdoutDigest: record.stdoutDigest,
        stderrDigest: record.stderrDigest
      });
      if (record.internal === true) safe.internal = true;
      if (typeof record.diagnostic === 'string') safe.diagnostic = record.diagnostic;
      if (typeof record.placeholder === 'boolean') safe.placeholder = record.placeholder;
    }
    normalized[gateName] = safe;
  }
  return normalized;
}

function reportAttempt(attempt) {
  return {
    acIds: [...attempt.acIds],
    changedFiles: [...attempt.changedFiles],
    evidence: reportEvidence(attempt.evidence),
    finishedAt: attempt.finishedAt,
    implementationSha: attempt.implementationSha,
    itemBaselineSha: attempt.itemBaselineSha,
    number: attempt.number,
    reason: attempt.reason,
    startedAt: attempt.startedAt,
    state: attempt.state
  };
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
    `Evidence report: ${run?.runId ? `docs/runs/${markdown(run.runId)}.json` : 'not available'}`,
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
      `- Evidence report: ${run?.runId ? `docs/runs/${markdown(run.runId)}.json#${node.id}` : 'not available'}`,
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
  const itemMap = new Map(roadmap.nodes.filter(node => node.kind === 'item').map(node => [node.id, node]));
  const scope = Array.isArray(run.scope) ? [...run.scope] : [];
  const items = Object.fromEntries(scope.map(itemId => [itemId, {
    attempts: (run.attempts?.[itemId] ?? []).map(reportAttempt),
    id: itemId,
    status: itemMap.get(itemId)?.status ?? 'planned'
  }]));
  return {
    items,
    revision: roadmap.revision,
    runId: run.runId,
    schemaVersion: 1,
    scope,
    selector: run.selector,
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
      const existing = await readImmutableRegular(path, fs);
      if (existing !== desired) {
        throw new RoadmapError('REPORT_CONFLICT', `immutable report differs: ${path}`, { path });
      }
      return { created: false };
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
