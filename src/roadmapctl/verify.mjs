import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { canonicalStringify, sha256 } from './canonical-json.mjs';
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
const TIMEOUT_GRACE_MS = 100;
const TIMEOUT_HARD_SETTLE_MS = 100;
const COMMAND_EVIDENCE_KEYS = Object.freeze([
  'gate', 'status', 'processClass', 'exitCode', 'signal', 'startedAt', 'finishedAt', 'durationMs',
  'bindings', 'artifacts', 'acIds', 'stdoutDigest', 'stderrDigest'
]);
const OPTIONAL_COMMAND_EVIDENCE_KEYS = Object.freeze(['internal', 'diagnostic', 'placeholder']);
const AUDIT_EVIDENCE_KEYS = Object.freeze([
  'gate', 'type', 'producer', 'schema', 'status', 'bindings', 'auditRange', 'auditCounts'
]);

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
  if (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs <= 0) {
    throw unsafe('timeoutMs must be a positive safe integer', { field: 'timeoutMs' });
  }

  const resolvedRoot = finalPath(root, 'repository root');
  const resolvedCwd = finalPath(resolve(resolvedRoot, gate.cwd), 'gate cwd');
  if (!isContained(resolvedRoot, resolvedCwd)) {
    throw unsafe('gate cwd resolves outside the repository', { cwd: gate.cwd });
  }

  return Object.freeze({ executable: gate.executable, args: Object.freeze([...gate.args]), cwd: resolvedCwd, timeoutMs: gate.timeoutMs });
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

function directChildKill(child, signal) {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function windowsTreeKill(child, force) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return directChildKill(child, force ? 'SIGKILL' : 'SIGTERM');
  let killer;
  try {
    const args = ['/PID', String(child.pid), '/T'];
    if (force) args.push('/F');
    killer = spawn('taskkill', args, { shell: false, stdio: 'ignore', windowsHide: true });
    killer.once('error', () => directChildKill(child, force ? 'SIGKILL' : 'SIGTERM'));
    killer.unref();
    return true;
  } catch {
    return directChildKill(child, force ? 'SIGKILL' : 'SIGTERM');
  }
}

function terminateProcessTree(child, signal) {
  if (process.platform === 'win32') return windowsTreeKill(child, signal === 'SIGKILL');
  if (Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // A missing/unavailable group falls back only to the process we own.
    }
  }
  return directChildKill(child, signal);
}

function executionSnapshot(context) {
  const manifest = context?.gates ?? context?.gateManifest ?? context?.manifest?.gates;
  if (!plainObject(manifest)) throw new RoadmapError('MANIFEST_MISMATCH', 'gate manifest is required before execution');
  let manifestCopy;
  try {
    manifestCopy = structuredClone(manifest);
  } catch {
    throw new RoadmapError('MANIFEST_MISMATCH', 'gate manifest must be a cloneable document');
  }
  const bindings = normalizedBindings(bindingSource(context));
  bindings.manifestHash = gateManifestHash(manifestCopy);
  return {
    manifest: manifestCopy,
    bindings,
    evidenceArtifacts: safeArray(context?.evidenceArtifacts ?? context?.artifacts),
    acIds: safeArray(context?.acIds)
  };
}

export async function runGate(root, context, gateName, gate) {
  if (gate?.type !== 'command') throw unsafe('runGate executes only command gates', { gate: gateName });
  const snapshot = executionSnapshot(context);
  if (!Object.hasOwn(snapshot.manifest, gateName)
      || canonicalStringify(snapshot.manifest[gateName]) !== canonicalStringify(gate)) {
    throw new RoadmapError('MANIFEST_MISMATCH', `gate ${gateName} does not exactly match the captured manifest`, { gate: gateName });
  }
  const command = validateGateCommand(root, snapshot.manifest[gateName]);
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
    let timeoutTimer;
    let killTimer;
    let hardDeadlineTimer;
    let timedOut = false;
    let forceSent = false;
    let timeoutClose = null;
    let timeoutSignal = null;
    let onStdoutData;
    let onStderrData;
    let onChildError;
    let onChildClose;
    const detachListeners = () => {
      child?.stdout?.removeListener('data', onStdoutData);
      child?.stderr?.removeListener('data', onStderrData);
      child?.removeListener('error', onChildError);
      child?.removeListener('close', onChildClose);
    };
    const finish = (processClass, exitCode, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(hardDeadlineTimer);
      detachListeners();
      if (child && child.exitCode === null && child.signalCode === null) {
        const swallowLateError = () => {};
        child.once('error', swallowLateError);
        child.once('close', () => child.removeListener('error', swallowLateError));
      }
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
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnvironment(process.env)
      });
    } catch {
      finish('spawn-error', null);
      return;
    }

    onStdoutData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutHash.update(bytes);
      appendBounded(stdoutParts, bytes, stdoutState, logLimit);
    };
    onStderrData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrHash.update(bytes);
      appendBounded(stderrParts, bytes, stderrState, logLimit);
    };
    onChildError = () => finish('spawn-error', null);
    onChildClose = (code, signal) => {
      if (timedOut) {
        timeoutClose = { signal };
        if (forceSent) finish('timeout', null, signal ?? timeoutSignal);
      }
      else finish(signal === null ? 'exit' : 'signal', code, signal);
    };
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.once('error', onChildError);
    child.once('close', onChildClose);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      timeoutSignal = 'SIGTERM';
      terminateProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) {
          forceSent = true;
          timeoutSignal = 'SIGKILL';
          terminateProcessTree(child, 'SIGKILL');
          if (timeoutClose) finish('timeout', null, timeoutClose.signal ?? timeoutSignal);
        }
      }, TIMEOUT_GRACE_MS);
      hardDeadlineTimer = setTimeout(() => {
        if (settled) return;
        timeoutSignal = 'SIGKILL';
        terminateProcessTree(child, 'SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish('timeout', null, timeoutSignal);
      }, TIMEOUT_GRACE_MS + TIMEOUT_HARD_SETTLE_MS);
    }, command.timeoutMs);
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

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function validUniqueStrings(value, expression = null) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || (expression && !expression.test(entry)) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function validEvidenceBindings(bindings) {
  return exactKeys(bindings, BINDING_KEYS)
    && GIT_OBJECT_ID.test(bindings.itemBaselineSha)
    && GIT_OBJECT_ID.test(bindings.implementationSha)
    && DIGEST.test(bindings.specHash)
    && DIGEST.test(bindings.manifestHash)
    && validUniqueStrings(bindings.sharedContractHashes, DIGEST);
}

function validCommandEvidence(report, gateName) {
  if (!exactKeys(report, COMMAND_EVIDENCE_KEYS, OPTIONAL_COMMAND_EVIDENCE_KEYS)) return false;
  if (report.gate !== gateName || !['passed', 'failed', 'skipped'].includes(report.status)) return false;
  if (!['exit', 'spawn-error', 'signal', 'timeout'].includes(report.processClass)) return false;
  if (!validEvidenceBindings(report.bindings)
      || !validUniqueStrings(report.acIds)
      || !validUniqueStrings(report.artifacts)
      || !DIGEST.test(report.stdoutDigest)
      || !DIGEST.test(report.stderrDigest)) return false;
  if (typeof report.startedAt !== 'string' || !Number.isFinite(Date.parse(report.startedAt))
      || typeof report.finishedAt !== 'string' || !Number.isFinite(Date.parse(report.finishedAt))
      || !Number.isSafeInteger(report.durationMs) || report.durationMs < 0) return false;
  if (gateName === 'spec' ? report.internal !== true : report.internal !== undefined) return false;
  if (report.diagnostic !== undefined && (typeof report.diagnostic !== 'string' || report.diagnostic.length === 0)) return false;
  if (report.placeholder !== undefined && typeof report.placeholder !== 'boolean') return false;

  if (report.processClass === 'exit') {
    if (!Number.isSafeInteger(report.exitCode) || report.exitCode < 0 || report.signal !== null) return false;
  } else if (report.processClass === 'spawn-error') {
    if (report.exitCode !== null || report.signal !== null) return false;
  } else if (report.exitCode !== null || typeof report.signal !== 'string' || report.signal.length === 0) return false;

  const successfulExit = report.processClass === 'exit' && report.exitCode === 0 && report.signal === null;
  if (report.status === 'passed' && !successfulExit) return false;
  if (report.status === 'failed' && successfulExit) return false;
  return true;
}

function validAuditEvidence(report, gateName) {
  return exactKeys(report, AUDIT_EVIDENCE_KEYS)
    && report.gate === gateName
    && report.type === 'attestation'
    && report.producer === 'ddd-audit'
    && report.schema === 'ddd-audit/v1'
    && ['passed', 'failed'].includes(report.status)
    && validEvidenceBindings(report.bindings)
    && exactKeys(report.auditRange, ['from', 'to'])
    && GIT_OBJECT_ID.test(report.auditRange.from)
    && GIT_OBJECT_ID.test(report.auditRange.to)
    && report.auditRange.from === report.bindings.itemBaselineSha
    && report.auditRange.to === report.bindings.implementationSha
    && exactKeys(report.auditCounts, AUDIT_SEVERITIES)
    && AUDIT_SEVERITIES.every(severity => Number.isSafeInteger(report.auditCounts[severity]) && report.auditCounts[severity] >= 0);
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
  if (!exactKeys(gate, ['type', 'producer', 'schema']) || gate.type !== 'attestation') attestationError('manifest gate must be an exact attestation definition');
  if (!exactKeys(report, AUDIT_EVIDENCE_KEYS)) attestationError('attestation report must contain only the exact report fields');
  if (report.producer !== gate.producer || report.schema !== gate.schema) {
    attestationError('attestation producer or schema does not match the manifest');
  }
  if (report.type !== undefined && report.type !== 'attestation') attestationError('report type must be attestation');
  if (!['passed', 'failed'].includes(report.status)) attestationError('attestation status must be passed or failed');

  const currentBindings = bindingSource(context);
  validateBindingShape(currentBindings, 'current', { exact: true });
  validateBindingShape(report.bindings, 'report', { exact: true });
  const expected = normalizedBindings(currentBindings);
  const actual = normalizedBindings(report.bindings);
  for (const key of BINDING_KEYS.slice(0, 4)) {
    if (actual[key] !== expected[key]) attestationError(`attestation ${key} is stale`, { field: key });
  }
  if (!sameArray(actual.sharedContractHashes, expected.sharedContractHashes)) {
    attestationError('attestation shared-contract bindings are stale', { field: 'sharedContractHashes' });
  }

  if (!exactKeys(report.auditRange, ['from', 'to'])) attestationError('attestation audit range is required and must be exact');
  const actualRange = report.auditRange;
  if (!GIT_OBJECT_ID.test(actualRange.from) || !GIT_OBJECT_ID.test(actualRange.to)
      || actualRange.from !== expected.itemBaselineSha || actualRange.to !== expected.implementationSha) {
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

function invalidEvidence(issues) {
  return {
    accepted: false,
    state: 'failed',
    reasons: [{ code: 'INVALID_EVIDENCE', message: 'completion evidence does not match the executable evidence schema', details: { issues } }]
  };
}

function evidenceSchemaIssues(item, evidence) {
  if (!plainObject(item) || !plainObject(evidence)) return ['completion input must contain item and evidence objects'];
  const requiredGates = Array.isArray(item.requiredGates) ? item.requiredGates : [];
  const allowedGates = new Set(requiredGates);
  const issues = Object.keys(evidence).filter(gateName => !allowedGates.has(gateName)).sort().map(gateName => `unknown evidence gate ${gateName}`);
  for (const gateName of requiredGates) {
    const report = evidence[gateName];
    if (report === undefined) continue;
    const valid = gateName === 'audit'
      ? validAuditEvidence(report, gateName)
      : validCommandEvidence(report, gateName);
    if (!valid) issues.push(`invalid evidence for gate ${gateName}`);
  }
  return issues;
}

function evaluateCompletionUnsafe({ item, evidence, bindings }) {
  const safeItem = plainObject(item) ? item : {};
  const safeEvidence = plainObject(evidence) ? evidence : {};
  const safeBindings = plainObject(bindings) ? bindings : {};
  const requiredGates = Array.isArray(safeItem.requiredGates) ? [...safeItem.requiredGates] : [];
  const findings = [];

  const schemaIssues = evidenceSchemaIssues(item, evidence);
  if (schemaIssues.length > 0) return invalidEvidence(schemaIssues);

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

export function evaluateCompletion(input) {
  try {
    return evaluateCompletionUnsafe(input);
  } catch {
    return invalidEvidence(['completion evidence could not be read safely']);
  }
}
