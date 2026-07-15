import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
    signal: null,
    startedAt: '2026-07-14T00:00:00.000Z',
    finishedAt: '2026-07-14T00:00:00.001Z',
    durationMs: 1,
    bindings,
    acIds,
    artifacts: [],
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
      gate: 'audit', type: 'attestation', producer: 'ddd-develop', schema: 'ddd-review/v1',
      status: 'passed', bindings,
      auditRange: { from: bindings.itemBaselineSha, to: bindings.implementationSha },
      auditCounts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
    }
  };
}

function auditInput(bindings = currentBindings(), overrides = {}) {
  return {
    schemaVersion: 1,
    schema: 'ddd-review/v1',
    runId: 'run-1',
    itemId: 'P1.1.1',
    baselineSha: bindings.itemBaselineSha,
    implementationSha: bindings.implementationSha,
    specHash: bindings.specHash,
    counts: { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    findings: [],
    ...overrides
  };
}

function commandContext(gate, overrides = {}) {
  const gates = { tests: gate };
  return {
    gates,
    bindings: currentBindings({ manifestHash: gateManifestHash(gates) }),
    ...overrides
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
    () => validateGateCommand(process.cwd(), { executable: 'node', args: ['--test'], cwd: '../outside', timeoutMs: 1000 }),
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
    () => validateGateCommand(root, { type: 'command', executable: 'node', args: ['--test'], cwd: 'escape', timeoutMs: 1000 }),
    error => error.code === 'UNSAFE_COMMAND'
  );
});

for (const token of ['|', '>', '<', '$(', '`', '\0', ';', '&&', '\n']) {
  test(`rejects shell token ${JSON.stringify(token)}`, () => {
    assert.throws(
      () => validateGateCommand(process.cwd(), { executable: 'node', args: [token], cwd: '.', timeoutMs: 1000 }),
      error => error.code === 'UNSAFE_COMMAND' && /unsafe/i.test(error.message)
    );
  });
}

test('rejects shell tokens in the executable too', () => {
  assert.throws(
    () => validateGateCommand(process.cwd(), { executable: 'node;echo', args: [], cwd: '.', timeoutMs: 1000 }),
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
  const gate = {
    type: 'command',
    executable: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(100)),process.stderr.write('safe-stderr')"],
    cwd: '.',
    timeoutMs: 1000
  };
  const context = commandContext(gate, {
    acIds: ['AC-P1.1-001'],
    evidenceArtifacts: ['test/report.json'],
    maxLogBytes: 12,
    onJournal: journal => journals.push(journal)
  });
  const evidence = await runGate(process.cwd(), context, 'tests', gate);

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
  const failureGate = { type: 'command', executable: process.execPath, args: ['-e', 'process.exit(7)'], cwd: '.', timeoutMs: 5000 };
  const missingGate = { type: 'command', executable: 'roadmapctl-command-that-does-not-exist', args: [], cwd: '.', timeoutMs: 5000 };
  const failed = await runGate(process.cwd(), commandContext(failureGate), 'tests', failureGate);
  const missing = await runGate(process.cwd(), commandContext(missingGate), 'tests', missingGate);
  assert.deepEqual([failed.status, failed.processClass, failed.exitCode], ['failed', 'exit', 7]);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.processClass, 'spawn-error');
  assert.equal(missing.exitCode, null);
  assert.ok(!Object.hasOwn(missing, 'error'));
});

test('runGate executes only command gates', async () => {
  await assert.rejects(
    runGate(process.cwd(), { bindings: currentBindings() }, 'audit', { type: 'attestation', producer: 'ddd-develop', schema: 'ddd-review/v1' }),
    error => error.code === 'UNSAFE_COMMAND'
  );
});

test('runGate rejects a manifest mismatch before spawning the supplied command', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roadmapctl-manifest-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'spawned');
  const manifestGate = { type: 'command', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 };
  const actualGate = { ...manifestGate, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`] };

  await assert.rejects(runGate(root, commandContext(manifestGate), 'tests', actualGate), error => error.code === 'MANIFEST_MISMATCH');
  await assert.rejects(access(marker));
});

test('runGate snapshots manifest and bindings before execution', async () => {
  const gate = { type: 'command', executable: process.execPath, args: ['-e', "setTimeout(function(){},30)"], cwd: '.', timeoutMs: 5000 };
  const context = commandContext(gate);
  const expected = structuredClone(context.bindings);
  const running = runGate(process.cwd(), context, 'tests', gate);
  context.bindings.implementationSha = '9'.repeat(40);
  context.gates.tests.timeoutMs = 2;
  const evidence = await running;
  assert.deepEqual(evidence.bindings, expected);
  assert.equal(evidence.status, 'passed');
});

test('runGate terminates a timed-out child without leaving it running', async () => {
  const gate = { type: 'command', executable: process.execPath, args: ['-e', 'setInterval(function(){},1000)'], cwd: '.', timeoutMs: 25 };
  const started = Date.now();
  const evidence = await runGate(process.cwd(), commandContext(gate), 'tests', gate);
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.processClass, 'timeout');
  assert.ok(['SIGTERM', 'SIGKILL'].includes(evidence.signal));
  assert.ok(Date.now() - started < 2000);
});

test('runGate terminates timed-out process trees even when a descendant inherits stdio', async () => {
  const attempt = async timeoutMs => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roadmapctl-tree-')));
    const pidPath = join(root, 'descendant.pid');
    const markerPath = join(root, 'descendant-survived');
    const parentPath = join(root, 'gate-parent.sh');
    const descendantDelayMs = timeoutMs + 700;
    let descendantPid;
    try {
      let gate;
      if (process.platform === 'win32') {
        const descendantScript = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid)),setTimeout(function(){require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'survived')},${descendantDelayMs})`;
        const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'inherit'}),setInterval(function(){},1000)`;
        gate = { type: 'command', executable: process.execPath, args: ['-e', parentScript], cwd: '.', timeoutMs };
      } else {
        await writeFile(parentPath, `#!/bin/sh\n( sleep ${descendantDelayMs / 1000}; printf survived > "${markerPath}" ) &\nprintf '%s' "$!" > "${pidPath}"\nwhile :; do sleep 1; done\n`);
        await chmod(parentPath, 0o755);
        gate = { type: 'command', executable: '/bin/sh', args: [parentPath], cwd: '.', timeoutMs };
      }

      const started = Date.now();
      const journals = [];
      const evidence = await runGate(root, commandContext(gate, { onJournal: entry => journals.push(entry) }), 'tests', gate);
      const elapsed = Date.now() - started;
      assert.equal(evidence.processClass, 'timeout', JSON.stringify(journals));
      assert.ok(elapsed < timeoutMs + 350, `timeout ${timeoutMs}ms returned after ${elapsed}ms`);

      let pidText;
      try {
        pidText = await readFile(pidPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return { started: false, timeoutMs };
        throw error;
      }
      descendantPid = Number(pidText);
      if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) return { started: false, timeoutMs };

      await new Promise(resolve => setTimeout(resolve, 850));
      assert.throws(() => process.kill(descendantPid, 0), error => error.code === 'ESRCH');
      await assert.rejects(access(markerPath));
      return { started: true, timeoutMs };
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  };

  const attempts = [];
  for (const timeoutMs of [100, 250, 500, 1000]) {
    const result = await attempt(timeoutMs);
    attempts.push(result);
    if (result.started) return;
  }
  assert.fail(`descendant did not start in any bounded attempt: ${JSON.stringify(attempts)}`);
});

test('attestation must match exact run, item, commit, spec, findings, and counts', () => {
  const bindings = currentBindings();
  const gate = { type: 'attestation', producer: 'ddd-develop', schema: 'ddd-review/v1' };
  const context = { bindings, runId: 'run-1', itemId: 'P1.1.1' };
  const report = auditInput(bindings);
  const normalized = validateAttestation(context, gate, report);
  assert.deepEqual(normalized.auditCounts, { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
  assert.ok(Object.isFrozen(normalized));
  assert.throws(() => validateAttestation(context, gate, { ...report, schema: 'ddd-review/v2' }), error => error.code === 'ATTESTATION_INVALID');
  assert.throws(() => validateAttestation(context, gate, { ...report, implementationSha: '9'.repeat(40) }), error => error.code === 'ATTESTATION_INVALID');
  assert.throws(() => validateAttestation(context, gate, { ...report, counts: { ...report.counts, HIGH: -1 } }), error => error.code === 'ATTESTATION_INVALID');
  assert.throws(() => validateAttestation(context, gate, { ...report, unknown: true }), error => error.code === 'ATTESTATION_INVALID');
  const noBaseline = { ...report };
  delete noBaseline.baselineSha;
  assert.throws(() => validateAttestation(context, gate, noBaseline), error => error.code === 'ATTESTATION_INVALID');
  const finding = { id: 'ARCH-HIGH-001', severity: 'HIGH', file: 'src/example.mjs', line: 12, message: 'wrong dependency direction' };
  assert.throws(() => validateAttestation(context, gate, { ...report, findings: [finding] }), error => error.code === 'ATTESTATION_INVALID');
  assert.throws(() => validateAttestation(context, gate, {
    ...report,
    counts: { ...report.counts, LOW: 1 },
    findings: [{ id: 'ARCH-LOW-001', severity: 'LOW', file: 'src/example.mjs', line: 12, message: 'x'.repeat(2001) }]
  }), error => error.code === 'ATTESTATION_INVALID');
});

test('forged or malformed executable evidence deterministically fails completion', () => {
  const mutations = [
    evidence => { delete evidence.tests.stdoutDigest; },
    evidence => { evidence.tests.unknown = 'trusted'; },
    evidence => { evidence.tests.bindings.extra = true; },
    evidence => { evidence.tests.acIds.push(evidence.tests.acIds[0]); },
    evidence => { evidence.tests.processClass = 'spawn-error'; },
    evidence => { evidence.tests.status = 'warning'; },
    evidence => { evidence.audit.auditRange.to = '9'.repeat(40); },
    evidence => { evidence.audit.unknown = true; }
  ];
  for (const mutate of mutations) {
    const evidence = passingEvidence();
    mutate(evidence);
    const result = completion({ evidence });
    assert.equal(result.accepted, false);
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.reasons.map(entry => entry.code), ['INVALID_EVIDENCE']);
  }
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
  ['missing AC coverage', evidence => { for (const [gate, value] of Object.entries(evidence)) if (gate !== 'audit') value.acIds = []; }, 'MISSING_AC_COVERAGE', 'blocked'],
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
  evidence.tests.status = 'failed';
  evidence.audit.auditCounts.HIGH = 1;
  const result = completion({ bindings, evidence });
  assert.equal(result.accepted, false);
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.reasons.map(reason => reason.code), ['STALE_IMPLEMENTATION', 'GATE_FAILED', 'AUDIT_BLOCKING']);
});

test('unrecorded relevant changes reject completion after all evidence checks', () => {
  const bindings = currentBindings({ unrecordedRelevantChanges: ['src/profile.mjs'] });
  const result = completion({ bindings, evidence: passingEvidence(currentBindings()) });
  assert.equal(result.state, 'failed');
  assert.equal(result.reasons.at(-1).code, 'UNRECORDED_RELEVANT_CHANGES');
});

test('complete, current evidence is accepted with no warning-success payload', () => {
  assert.deepEqual(completion(), { accepted: true });
});
