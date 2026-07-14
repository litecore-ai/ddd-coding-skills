import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { sha256 } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNSAFE_SHELL = /[\0\r\n|&;<>`]|\$\(/;
const AUDIT_SEVERITIES = Object.freeze(['CRIT', 'HIGH', 'MEDIUM', 'LOW']);
const BINDING_KEYS = Object.freeze([
  'itemBaselineSha',
  'implementationSha',
  'specHash',
  'manifestHash',
  'sharedContractHashes'
]);
const DEFAULT_LOG_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;

function unsafe(message, details = {}) {
  return new RoadmapError('UNSAFE_COMMAND', message, details);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function immutableCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (!plainObject(value)) return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, immutableCopy(nested)])));
}

function finalPath(path, label) {
  try {
    return realpathSync(path);
  } catch (error) {
    throw unsafe(`${label} cannot be resolved safely`, { path, causeCode: error.code });
  }
}

function isContained(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function assertToken(token, field) {
  if (typeof token !== 'string' || token.length === 0) {
    throw unsafe(`${field} must be a non-empty string`, { field });
  }
  if (UNSAFE_SHELL.test(token)) {
    throw unsafe(`${field} contains an unsafe shell token`, { field });
  }
}

/**
 * Resolve and validate a command without invoking a shell. The resolved cwd is
 * checked after following symlinks so lexical containment cannot mask an escape.
 */
export function validateGateCommand(root, gate) {
  if (!plainObject(gate) || (gate.type !== undefined && gate.type !== 'command')) {
    throw unsafe('only structured command gates can be executed');
  }
  assertToken(gate.executable, 'executable');
  if (!Array.isArray(gate.args)) throw unsafe('args must be an array of strings', { field: 'args' });
  gate.args.forEach((argument, index) => assertToken(argument, `args[${index}]`));
  if (typeof gate.cwd !== 'string' || gate.cwd.length === 0 || gate.cwd.includes('\0')) {
    throw unsafe('cwd must be a non-empty safe path', { field: 'cwd' });
  }

  const resolvedRoot = finalPath(root, 'repository root');
  const resolvedCwd = finalPath(resolve(resolvedRoot, gate.cwd), 'gate cwd');
  if (!isContained(resolvedRoot, resolvedCwd)) {
    throw unsafe('gate cwd resolves outside the repository', { cwd: gate.cwd });
  }

  return Object.freeze({ executable: gate.executable, args: Object.freeze([...gate.args]), cwd: resolvedCwd });
}

export function gateManifestHash(gates) {
  if (!plainObject(gates)) throw new RoadmapError('SCHEMA_INVALID', 'gate manifest must be an object');
  return sha256(gates);
}

/**
 * This removes ambient credentials and controller-private variables. It is not
 * a network or outside-write sandbox: that boundary must come from the platform
 * sandbox or an exact, user-approved command manifest.
 */
export function sanitizedEnvironment(environment = process.env) {
  const result = {};
  const credentialName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|SESSION)(?:$|_)/i;
  const controllerName = /^(?:ROADMAPCTL|DDD_AUTO|CODEX_INTERNAL|CLAUDE_INTERNAL)_/i;
  for (const [name, value] of Object.entries(environment)) {
    if (credentialName.test(name) || controllerName.test(name) || name === 'SSH_AUTH_SOCK') continue;
    result[name] = value;
  }
  return result;
}

function bindingSource(context) {
  return plainObject(context?.bindings) ? context.bindings : context;
}

function normalizedBindings(value) {
  const source = plainObject(value) ? value : {};
  return {
    itemBaselineSha: source.itemBaselineSha,
    implementationSha: source.implementationSha,
    specHash: source.specHash,
    manifestHash: source.manifestHash,
    sharedContractHashes: Array.isArray(source.sharedContractHashes) ? [...source.sharedContractHashes] : []
  };
}

function boundedLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_LOG_BYTES) : DEFAULT_LOG_BYTES;
}

function appendBounded(parts, chunk, state, limit) {
  if (state.bytes >= limit) {
    state.truncated ||= chunk.length > 0;
    return;
  }
  const remaining = limit - state.bytes;
  const retained = chunk.subarray(0, remaining);
  if (retained.length > 0) parts.push(retained);
  state.bytes += retained.length;
  state.truncated ||= retained.length < chunk.length;
}

function safeArray(value) {
  return Array.isArray(value) ? [...value] : [];
}

function normalizedGateEvidence(context, gateName, result) {
  return immutableCopy({
    gate: gateName,
    status: result.exitCode === 0 && result.processClass === 'exit' ? 'passed' : 'failed',
    processClass: result.processClass,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    bindings: normalizedBindings(bindingSource(context)),
    artifacts: safeArray(context?.evidenceArtifacts ?? context?.artifacts),
    acIds: safeArray(context?.acIds),
    stdoutDigest: result.stdoutDigest,
    stderrDigest: result.stderrDigest
  });
}

function executionSnapshot(context) {
  const bindings = normalizedBindings(bindingSource(context));
  const manifest = context?.gates ?? context?.gateManifest ?? context?.manifest?.gates;
  if (plainObject(manifest)) bindings.manifestHash = gateManifestHash(manifest);
  return {
    bindings,
    evidenceArtifacts: safeArray(context?.evidenceArtifacts ?? context?.artifacts),
    acIds: safeArray(context?.acIds)
  };
}

export async function runGate(root, context, gateName, gate) {
  if (gate?.type !== 'command') throw unsafe('runGate executes only command gates', { gate: gateName });
  const command = validateGateCommand(root, gate);
  const snapshot = executionSnapshot(context);
  const logLimit = boundedLimit(context?.maxLogBytes);
  const started = Date.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  const stdoutParts = [];
  const stderrParts = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };

  const result = await new Promise(resolveResult => {
    let child;
    let settled = false;
    const finish = (processClass, exitCode, signal = null) => {
      if (settled) return;
      settled = true;
      const finished = Date.now();
      resolveResult({
        processClass,
        exitCode,
        signal,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started),
        stdoutDigest: `sha256:${stdoutHash.digest('hex')}`,
        stderrDigest: `sha256:${stderrHash.digest('hex')}`
      });
    };

    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnvironment(process.env)
      });
    } catch {
      finish('spawn-error', null);
      return;
    }

    child.stdout.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutHash.update(bytes);
      appendBounded(stdoutParts, bytes, stdoutState, logLimit);
    });
    child.stderr.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrHash.update(bytes);
      appendBounded(stderrParts, bytes, stderrState, logLimit);
    });
    child.once('error', () => finish('spawn-error', null));
    child.once('close', (code, signal) => finish(signal === null ? 'exit' : 'signal', code, signal));
  });

  if (typeof context?.onJournal === 'function') {
    try {
      context.onJournal(immutableCopy({
        gate: gateName,
        stdout: Buffer.concat(stdoutParts).toString('utf8'),
        stderr: Buffer.concat(stderrParts).toString('utf8'),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated
      }));
    } catch {
      // Journaling is local diagnostics and cannot alter normalized gate truth.
    }
  }

  return normalizedGateEvidence(snapshot, gateName, result);
}

function attestationError(message, details = {}) {
  throw new RoadmapError('ATTESTATION_INVALID', message, details);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateBindingShape(bindings, label, { exact = false } = {}) {
  if (!plainObject(bindings)) attestationError(`${label} bindings must be an object`);
  if (exact) {
    const keys = Object.keys(bindings).sort();
    const expectedKeys = [...BINDING_KEYS].sort();
    if (!sameArray(keys, expectedKeys)) attestationError(`${label} bindings must contain only the exact binding fields`);
  }
  if (!GIT_OBJECT_ID.test(bindings.itemBaselineSha ?? '')) attestationError(`${label} item baseline SHA is invalid`);
  if (!GIT_OBJECT_ID.test(bindings.implementationSha ?? '')) attestationError(`${label} implementation SHA is invalid`);
  if (!DIGEST.test(bindings.specHash ?? '')) attestationError(`${label} spec hash is invalid`);
  if (!DIGEST.test(bindings.manifestHash ?? '')) attestationError(`${label} manifest hash is invalid`);
  if (!Array.isArray(bindings.sharedContractHashes) || bindings.sharedContractHashes.some(hash => !DIGEST.test(hash))) {
    attestationError(`${label} shared-contract hashes are invalid`);
  }
}

export function validateAttestation(context, gate, report) {
  if (!plainObject(gate) || gate.type !== 'attestation') attestationError('manifest gate must be an attestation');
  if (!plainObject(report)) attestationError('attestation report must be an object');
  if (report.producer !== gate.producer || report.schema !== gate.schema) {
    attestationError('attestation producer or schema does not match the manifest');
  }
  if (report.type !== undefined && report.type !== 'attestation') attestationError('report type must be attestation');
  if (!['passed', 'failed'].includes(report.status)) attestationError('attestation status must be passed or failed');

  const currentBindings = bindingSource(context);
  validateBindingShape(currentBindings, 'current');
  validateBindingShape(report.bindings, 'report', { exact: true });
  const expected = normalizedBindings(currentBindings);
  const actual = normalizedBindings(report.bindings);
  for (const key of BINDING_KEYS.slice(0, 4)) {
    if (actual[key] !== expected[key]) attestationError(`attestation ${key} is stale`, { field: key });
  }
  if (!sameArray(actual.sharedContractHashes, expected.sharedContractHashes)) {
    attestationError('attestation shared-contract bindings are stale', { field: 'sharedContractHashes' });
  }

  const expectedRange = context?.auditRange ?? {
    from: expected.itemBaselineSha,
    to: expected.implementationSha
  };
  const actualRange = report.auditRange ?? {
    from: actual.itemBaselineSha,
    to: actual.implementationSha
  };
  if (!plainObject(expectedRange) || !plainObject(actualRange)
      || actualRange.from !== expectedRange.from || actualRange.to !== expectedRange.to) {
    attestationError('attestation audit range is stale');
  }

  if (!plainObject(report.auditCounts)
      || Object.keys(report.auditCounts).length !== AUDIT_SEVERITIES.length
      || AUDIT_SEVERITIES.some(severity => !Number.isSafeInteger(report.auditCounts[severity]) || report.auditCounts[severity] < 0)) {
    attestationError('attestation severity counts must be exact non-negative integers');
  }

  return immutableCopy({
    gate: context?.gateName ?? report.gate ?? 'audit',
    type: 'attestation',
    producer: gate.producer,
    schema: gate.schema,
    status: report.status,
    bindings: actual,
    auditRange: { from: actualRange.from, to: actualRange.to },
    auditCounts: Object.fromEntries(AUDIT_SEVERITIES.map(severity => [severity, report.auditCounts[severity]]))
  });
}

function reason(code, message, details, state) {
  return { state, value: { code, message, details } };
}

function bindingMismatches(evidence, requiredGates, bindings) {
  const records = requiredGates
    .map(gateName => [gateName, evidence[gateName]])
    .filter(([, report]) => plainObject(report) && plainObject(report.bindings));
  const missingBindings = requiredGates.filter(gateName => plainObject(evidence[gateName]) && !plainObject(evidence[gateName].bindings));
  const mismatches = field => records.filter(([, report]) => {
    if (field === 'sharedContractHashes') {
      const actual = Array.isArray(report.bindings[field]) ? report.bindings[field] : [];
      const expected = Array.isArray(bindings[field]) ? bindings[field] : [];
      return !sameArray(actual, expected);
    }
    return report.bindings[field] !== bindings[field];
  }).map(([gateName]) => gateName);
  return { missingBindings, mismatches };
}

function placeholderDiagnostic(report) {
  if (!plainObject(report)) return false;
  if (report.placeholder === true) return true;
  const values = [report.diagnostic, report.diagnostics, report.artifacts].flat().filter(value => typeof value === 'string');
  return values.some(value => /\b(?:todo|tbd|placeholder|not implemented|n\/a)\b/i.test(value));
}

export function evaluateCompletion({ item, evidence, bindings }) {
  const safeItem = plainObject(item) ? item : {};
  const safeEvidence = plainObject(evidence) ? evidence : {};
  const safeBindings = plainObject(bindings) ? bindings : {};
  const requiredGates = Array.isArray(safeItem.requiredGates) ? [...safeItem.requiredGates] : [];
  const findings = [];

  // 1. Binding freshness.
  const freshness = bindingMismatches(safeEvidence, requiredGates, safeBindings);
  if (freshness.missingBindings.length > 0) {
    findings.push(reason('MISSING_BINDINGS', 'required evidence has no completion bindings', { gates: freshness.missingBindings }, 'blocked'));
  }
  const bindingChecks = [
    ['itemBaselineSha', 'STALE_BASELINE', 'item baseline evidence is stale', 'failed'],
    ['implementationSha', 'STALE_IMPLEMENTATION', 'implementation evidence is stale', 'failed'],
    ['specHash', 'STALE_SPEC', 'spec evidence is stale', 'blocked'],
    ['manifestHash', 'STALE_MANIFEST', 'gate manifest evidence is stale', 'blocked'],
    ['sharedContractHashes', 'STALE_SHARED_CONTRACT', 'shared-contract evidence is stale', 'blocked']
  ];
  for (const [field, code, message, state] of bindingChecks) {
    const gates = freshness.mismatches(field);
    if (gates.length > 0) findings.push(reason(code, message, { gates }, state));
  }

  // 2. Required gate presence.
  for (const gateName of requiredGates) {
    if (!plainObject(safeEvidence[gateName])) {
      findings.push(reason('MISSING_REQUIRED_GATE', `required gate ${gateName} has no evidence`, { gate: gateName }, 'blocked'));
    }
  }

  // 3. Process success.
  for (const gateName of requiredGates) {
    const report = safeEvidence[gateName];
    if (!plainObject(report)) continue;
    if (report.gate !== undefined && report.gate !== gateName) {
      findings.push(reason('GATE_ID_MISMATCH', `evidence for ${gateName} declares another gate`, { gate: gateName }, 'failed'));
      continue;
    }
    if (report.status === 'skipped') {
      findings.push(reason('GATE_SKIPPED', `required gate ${gateName} was skipped`, { gate: gateName }, 'blocked'));
    } else if (report.processClass === 'spawn-error' || report.spawnError === true) {
      findings.push(reason('GATE_SPAWN_ERROR', `required gate ${gateName} could not be started`, { gate: gateName }, 'failed'));
    } else if (report.status !== 'passed' || (report.exitCode !== undefined && report.exitCode !== 0)) {
      findings.push(reason('GATE_FAILED', `required gate ${gateName} did not pass`, { gate: gateName, exitCode: report.exitCode ?? null }, 'failed'));
    }
  }

  // 4. Acceptance-criterion coverage (internal spec evidence is not executable coverage).
  const coveredAcIds = new Set();
  for (const gateName of requiredGates) {
    if (gateName === 'spec' || gateName === 'audit') continue;
    const acIds = safeEvidence[gateName]?.acIds;
    if (Array.isArray(acIds)) acIds.forEach(id => coveredAcIds.add(id));
  }
  const expectedAcIds = Array.isArray(safeItem.spec?.acceptanceCriteria) ? safeItem.spec.acceptanceCriteria : [];
  const uncovered = expectedAcIds.filter(id => !coveredAcIds.has(id));
  if (uncovered.length > 0) {
    findings.push(reason('MISSING_AC_COVERAGE', 'acceptance criteria lack executable evidence', { acIds: uncovered }, 'blocked'));
  }

  // 5. Consumer and end-to-end presence.
  if (Array.isArray(safeItem.consumers) && safeItem.consumers.length > 0) {
    if (!plainObject(safeEvidence.consumer)) {
      findings.push(reason('MISSING_CONSUMER_EVIDENCE', 'consumer evidence is required', { consumers: [...safeItem.consumers] }, 'blocked'));
    } else if (placeholderDiagnostic(safeEvidence.consumer)) {
      findings.push(reason('PLACEHOLDER_CONSUMER_EVIDENCE', 'placeholder consumer diagnostics are not evidence', {}, 'blocked'));
    }
    if (!plainObject(safeEvidence.e2e)) {
      findings.push(reason('MISSING_E2E_EVIDENCE', 'end-to-end evidence is required', {}, 'blocked'));
    }
  }

  // 6. Audit severity.
  const counts = safeEvidence.audit?.auditCounts;
  if (plainObject(safeEvidence.audit)) {
    if (!plainObject(counts) || AUDIT_SEVERITIES.some(severity => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0)) {
      findings.push(reason('INVALID_AUDIT_EVIDENCE', 'audit severity counts are missing or invalid', {}, 'blocked'));
    } else if (counts.CRIT > 0 || counts.HIGH > 0) {
      findings.push(reason('AUDIT_BLOCKING', 'audit contains CRIT or HIGH findings', { CRIT: counts.CRIT, HIGH: counts.HIGH }, 'failed'));
    }
  }

  // 7. Relevant changes not represented by the implementation binding.
  const unrecorded = Array.isArray(safeBindings.unrecordedRelevantChanges)
    ? safeBindings.unrecordedRelevantChanges
    : Array.isArray(safeBindings.dirtyRelevantPaths) ? safeBindings.dirtyRelevantPaths : [];
  if (safeBindings.hasUnrecordedRelevantChanges === true || unrecorded.length > 0) {
    findings.push(reason('UNRECORDED_RELEVANT_CHANGES', 'relevant changes are not recorded by the implementation SHA', { paths: [...unrecorded] }, 'failed'));
  }

  if (findings.length === 0) return { accepted: true };
  return {
    accepted: false,
    state: findings.some(finding => finding.state === 'failed') ? 'failed' : 'blocked',
    reasons: findings.map(finding => finding.value)
  };
}
