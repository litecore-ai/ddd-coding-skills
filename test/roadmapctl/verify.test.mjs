import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validRoadmap } from './helpers.mjs';
import {
  evaluateCompletion,
  gateManifestHash,
  runGate,
  sanitizedEnvironment,
  validateAttestation,
  validateGateCommand
} from '../../src/roadmapctl/verify.mjs';

function currentBindings(overrides = {}) {
  return {
    itemBaselineSha: '0'.repeat(40),
    implementationSha: '1'.repeat(40),
    specHash: 'sha256:' + '0'.repeat(64),
    manifestHash: 'sha256:' + '2'.repeat(64),
    sharedContractHashes: [],
    ...overrides
  };
}

function passed(gate, bindings, acIds = ['AC-P1.1-001']) {
  return {
    gate,
    status: 'passed',
    processClass: 'exit',
    exitCode: 0,
    bindings,
    acIds,
    stdoutDigest: 'sha256:' + '3'.repeat(64),
    stderrDigest: 'sha256:' + '4'.repeat(64)
  };
}

function passingEvidence(bindings = currentBindings()) {
  return {
    spec: { ...passed('spec', bindings), internal: true },
    tests: passed('tests', bindings),
    consumer: passed('consumer', bindings),
    e2e: passed('e2e', bindings),
    audit: {
      gate: 'audit', type: 'attestation', producer: 'ddd-audit', schema: 'ddd-audit/v1',
      status: 'passed', bindings, auditCounts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
    }
  };
}

function completion(overrides = {}) {
  const bindings = overrides.bindings ?? currentBindings();
  return evaluateCompletion({
    item: overrides.item ?? validRoadmap().nodes[2],
    evidence: overrides.evidence ?? passingEvidence(bindings),
    bindings
  });
}

test('gate command cannot escape the repository', () => {
  assert.throws(
    () => validateGateCommand(process.cwd(), { executable: 'node', args: ['--test'], cwd: '../outside' }),
    error => error.code === 'UNSAFE_COMMAND'
  );
});

test('gate command rejects a symlink whose final target escapes the repository', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'roadmapctl-command-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'root');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'));

  assert.throws(
    () => validateGateCommand(root, { type: 'command', executable: 'node', args: ['--test'], cwd: 'escape' }),
    error => error.code === 'UNSAFE_COMMAND'
  );
});

for (const token of ['|', '>', '<', '$(', '`', '\0', ';', '&&', '\n']) {
  test(`rejects shell token ${JSON.stringify(token)}`, () => {
    assert.throws(
      () => validateGateCommand(process.cwd(), { executable: 'node', args: [token], cwd: '.' }),
      error => error.code === 'UNSAFE_COMMAND' && /unsafe/i.test(error.message)
    );
  });
}

test('rejects shell tokens in the executable too', () => {
  assert.throws(
    () => validateGateCommand(process.cwd(), { executable: 'node;echo', args: [], cwd: '.' }),
    error => error.code === 'UNSAFE_COMMAND'
  );
});

test('gate manifest hash is deterministic, complete, and does not mutate input', () => {
  const gates = validRoadmap().gates;
  const before = structuredClone(gates);
  assert.equal(gateManifestHash(gates), gateManifestHash({ audit: gates.audit, e2e: gates.e2e, consumer: gates.consumer, tests: gates.tests }));
  assert.notEqual(gateManifestHash(gates), gateManifestHash({ ...gates, tests: { ...gates.tests, args: ['--version'] } }));
  assert.deepEqual(gates, before);
});

test('sanitized environment removes credentials and controller tokens without mutating input', () => {
  const input = { PATH: '/bin', HOME: '/tmp/home', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret', ROADMAPCTL_RUN_TOKEN: 'secret' };
  const result = sanitizedEnvironment(input);
  assert.deepEqual(result, { PATH: '/bin', HOME: '/tmp/home' });
  assert.equal(input.GITHUB_TOKEN, 'secret');
});

test('runGate uses argv execution, hashes complete output, bounds local logs, and returns no raw output', async () => {
  const journals = [];
  const context = {
    bindings: currentBindings(),
    acIds: ['AC-P1.1-001'],
    evidenceArtifacts: ['test/report.json'],
    maxLogBytes: 12,
    onJournal: journal => journals.push(journal)
  };
  const evidence = await runGate(process.cwd(), context, 'tests', {
    type: 'command',
    executable: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(100)),process.stderr.write('safe-stderr')"],
    cwd: '.'
  });

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.exitCode, 0);
  assert.match(evidence.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(evidence.stderrDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(evidence.artifacts, ['test/report.json']);
  assert.ok(!Object.hasOwn(evidence, 'stdout'));
  assert.ok(!Object.hasOwn(evidence, 'stderr'));
  assert.ok(!JSON.stringify(evidence).includes('safe-stderr'));
  assert.equal(Buffer.byteLength(journals[0].stdout), 12);
  assert.equal(Buffer.byteLength(journals[0].stderr), 11);
  assert.equal(journals[0].stdoutTruncated, true);
});

test('runGate reports a non-zero exit and a spawn error as normalized failures', async () => {
  const failed = await runGate(process.cwd(), { bindings: currentBindings() }, 'tests', {
    type: 'command', executable: process.execPath, args: ['-e', 'process.exit(7)'], cwd: '.'
  });
  const missing = await runGate(process.cwd(), { bindings: currentBindings() }, 'tests', {
    type: 'command', executable: 'roadmapctl-command-that-does-not-exist', args: [], cwd: '.'
  });
  assert.deepEqual([failed.status, failed.processClass, failed.exitCode], ['failed', 'exit', 7]);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.processClass, 'spawn-error');
  assert.equal(missing.exitCode, null);
  assert.ok(!Object.hasOwn(missing, 'error'));
});

test('runGate executes only command gates', async () => {
  await assert.rejects(
    runGate(process.cwd(), { bindings: currentBindings() }, 'audit', { type: 'attestation', producer: 'ddd-audit', schema: 'ddd-audit/v1' }),
    error => error.code === 'UNSAFE_COMMAND'
  );
});

test('attestation must match the manifest producer, schema, bindings, and audit range', () => {
  const bindings = currentBindings();
  const gate = { type: 'attestation', producer: 'ddd-audit', schema: 'ddd-audit/v1' };
  const report = passingEvidence(bindings).audit;
  const normalized = validateAttestation({ bindings }, gate, report);
  assert.deepEqual(normalized.auditCounts, { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
  assert.ok(Object.isFrozen(normalized));
  assert.throws(() => validateAttestation({ bindings }, gate, { ...report, producer: 'other' }), error => error.code === 'ATTESTATION_INVALID');
  assert.throws(() => validateAttestation({ bindings }, gate, { ...report, bindings: currentBindings({ implementationSha: '9'.repeat(40) }) }), error => error.code === 'ATTESTATION_INVALID');
  assert.throws(() => validateAttestation({ bindings }, gate, { ...report, auditCounts: { ...report.auditCounts, HIGH: -1 } }), error => error.code === 'ATTESTATION_INVALID');
});

test('stale spec evidence cannot complete an item', () => {
  const bindings = currentBindings();
  const staleBindings = currentBindings({ specHash: 'sha256:' + '1'.repeat(64) });
  const result = completion({ bindings, evidence: passingEvidence(staleBindings) });
  assert.deepEqual(result.reasons.map(reason => reason.code), ['STALE_SPEC']);
});

test('CRIT or HIGH audit result fails completion', () => {
  for (const severity of ['CRIT', 'HIGH']) {
    const evidence = passingEvidence();
    evidence.audit.auditCounts[severity] = 1;
    const result = completion({ evidence });
    assert.equal(result.state, 'failed');
    assert.equal(result.reasons[0].code, 'AUDIT_BLOCKING');
  }
});

const completionCases = [
  ['missing required gate', evidence => { delete evidence.tests; }, 'MISSING_REQUIRED_GATE', 'blocked'],
  ['skipped gate', evidence => { evidence.tests.status = 'skipped'; }, 'GATE_SKIPPED', 'blocked'],
  ['non-zero exit', evidence => { evidence.tests.exitCode = 2; evidence.tests.status = 'failed'; }, 'GATE_FAILED', 'failed'],
  ['spawn error', evidence => { evidence.tests.processClass = 'spawn-error'; evidence.tests.exitCode = null; evidence.tests.status = 'failed'; }, 'GATE_SPAWN_ERROR', 'failed'],
  ['stale implementation SHA', evidence => { evidence.tests.bindings = currentBindings({ implementationSha: '8'.repeat(40) }); }, 'STALE_IMPLEMENTATION', 'failed'],
  ['stale manifest', evidence => { evidence.tests.bindings = currentBindings({ manifestHash: 'sha256:' + '8'.repeat(64) }); }, 'STALE_MANIFEST', 'blocked'],
  ['missing AC coverage', evidence => { for (const value of Object.values(evidence)) value.acIds = []; }, 'MISSING_AC_COVERAGE', 'blocked'],
  ['missing consumer evidence', evidence => { delete evidence.consumer; }, 'MISSING_CONSUMER_EVIDENCE', 'blocked'],
  ['missing E2E evidence', evidence => { delete evidence.e2e; }, 'MISSING_E2E_EVIDENCE', 'blocked'],
  ['placeholder consumer diagnostic', evidence => { evidence.consumer.diagnostic = 'TODO placeholder consumer check'; }, 'PLACEHOLDER_CONSUMER_EVIDENCE', 'blocked']
];

for (const [name, mutate, code, state] of completionCases) {
  test(`completion rejects ${name} without mutating inputs`, () => {
    const bindings = currentBindings();
    const item = validRoadmap().nodes[2];
    const evidence = passingEvidence(bindings);
    mutate(evidence);
    const before = structuredClone({ item, evidence, bindings });
    const result = evaluateCompletion({ item, evidence, bindings });
    assert.equal(result.accepted, false);
    assert.equal(result.state, state);
    assert.ok(result.reasons.some(reason => reason.code === code), JSON.stringify(result));
    assert.deepEqual({ item, evidence, bindings }, before);
  });
}

test('completion reasons follow the fixed decision order and never warning-succeed', () => {
  const bindings = currentBindings();
  const evidence = passingEvidence(bindings);
  evidence.tests.bindings = currentBindings({ implementationSha: '8'.repeat(40) });
  evidence.tests.exitCode = 2;
  evidence.tests.status = 'warning';
  evidence.audit.auditCounts.HIGH = 1;
  const result = completion({ bindings, evidence });
  assert.equal(result.accepted, false);
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.reasons.map(reason => reason.code), ['STALE_IMPLEMENTATION', 'GATE_FAILED', 'AUDIT_BLOCKING']);
});

test('unrecorded relevant changes reject completion after all evidence checks', () => {
  const bindings = currentBindings({ unrecordedRelevantChanges: ['src/profile.mjs'] });
  const result = completion({ bindings, evidence: passingEvidence(bindings) });
  assert.equal(result.state, 'failed');
  assert.equal(result.reasons.at(-1).code, 'UNRECORDED_RELEVANT_CHANGES');
});

test('complete, current evidence is accepted with no warning-success payload', () => {
  assert.deepEqual(completion(), { accepted: true });
});
