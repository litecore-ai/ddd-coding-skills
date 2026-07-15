import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStringify, sha256 } from '../../src/roadmapctl/canonical-json.mjs';
import { parseReport, parseRoadmap, parseRun, parseSpec } from '../../src/roadmapctl/schema.mjs';
import { validRoadmap, validRun, validSpec, validTransaction } from './helpers.mjs';

function expectSchemaError(operation, path, message) {
  assert.throws(operation, error => {
    assert.equal(error.name, 'RoadmapError');
    assert.equal(error.code, 'SCHEMA_INVALID');
    assert.equal(error.details.path, path);
    assert.match(error.message, message);
    return true;
  });
}

test('canonical hash ignores object key insertion order', () => {
  assert.equal(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }));
});

test('canonical JSON recursively sorts object keys, preserves array order, and ends with a newline', () => {
  assert.equal(
    canonicalStringify({ z: [{ b: 2, a: 1 }, 3], a: true }),
    '{\n  "a": true,\n  "z": [\n    {\n      "a": 1,\n      "b": 2\n    },\n    3\n  ]\n}\n'
  );
});

test('roadmap parser returns a deeply frozen validated copy', () => {
  const value = validRoadmap();
  const parsed = parseRoadmap(value);

  assert.notEqual(parsed, value);
  assert.notEqual(parsed.nodes, value.nodes);
  assert.notEqual(parsed.nodes[2].spec, value.nodes[2].spec);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.nodes));
  assert.ok(Object.isFrozen(parsed.nodes[2]));
  assert.ok(Object.isFrozen(parsed.nodes[2].spec.acceptanceCriteria));
  assert.ok(Object.isFrozen(parsed.gates.tests.args));
  assert.throws(() => { parsed.nodes[2].title = 'changed'; }, TypeError);
});

test('roadmap rejects a sparse nodes array at the missing index', () => {
  const value = validRoadmap({ nodes: new Array(1) });
  expectSchemaError(() => parseRoadmap(value), '$.nodes[0]', /sparse array hole/);
});

test('roadmap rejects unknown root keys with their full JSON path', () => {
  expectSchemaError(() => parseRoadmap(validRoadmap({ legacy: true })), '$.legacy', /unknown key legacy/);
});

test('roadmap rejects unknown nested keys with their full JSON path', () => {
  const value = validRoadmap();
  value.gates.tests.shell = true;
  expectSchemaError(() => parseRoadmap(value), '$.gates.tests.shell', /unknown key shell/);
});

test('roadmap rejects duplicate stable IDs', () => {
  const value = validRoadmap();
  value.nodes.push({ ...value.nodes[2] });
  assert.throws(() => parseRoadmap(value), error => error.code === 'SCHEMA_INVALID' && /duplicate id P1\.1\.1/.test(error.message));
});

test('roadmap rejects a feature whose parent is not a phase', () => {
  const value = validRoadmap();
  value.nodes[1].parentId = 'P1.1.1';
  expectSchemaError(() => parseRoadmap(value), '$.nodes[1].parentId', /parent.*phase/i);
});

test('roadmap rejects a missing parent', () => {
  const value = validRoadmap();
  value.nodes[2].parentId = 'P9.9';
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].parentId', /parent P9\.9 does not exist/);
});

test('roadmap rejects node IDs outside their parent hierarchy', () => {
  const value = validRoadmap();
  value.nodes[1].id = 'P2.1';
  value.nodes[2].parentId = 'P2.1';
  expectSchemaError(() => parseRoadmap(value), '$.nodes[1].id', /prefix.*P1/i);
});

test('roadmap rejects executable aggregate nodes', () => {
  const value = validRoadmap();
  value.nodes[0].requiredGates = ['tests'];
  expectSchemaError(() => parseRoadmap(value), '$.nodes[0].requiredGates', /unknown key requiredGates/);
});

test('roadmap dependencies may target items only', () => {
  const value = validRoadmap();
  value.nodes[2].dependsOn = ['P1.1'];
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].dependsOn[0]', /item/);
});

test('roadmap dependencies must exist', () => {
  const value = validRoadmap();
  value.nodes[2].dependsOn = ['P9.9.9'];
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].dependsOn[0]', /does not exist/);
});

test('roadmap rejects sparse item dependencies at the missing index', () => {
  const value = validRoadmap();
  value.nodes[2].dependsOn = new Array(1);
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].dependsOn[0]', /sparse array hole/);
});

test('roadmap rejects sparse spec acceptance-criterion references at the missing index', () => {
  const value = validRoadmap();
  value.nodes[2].spec.acceptanceCriteria = new Array(1);
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].spec.acceptanceCriteria[0]', /sparse array hole/);
});

test('roadmap items require an outcome', () => {
  const value = validRoadmap();
  delete value.nodes[2].outcome;
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].outcome', /required/);
});

test('roadmap items require consumers', () => {
  const value = validRoadmap();
  delete value.nodes[2].consumers;
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].consumers', /required/);
});

test('roadmap rejects sparse item consumers at the missing index', () => {
  const value = validRoadmap();
  value.nodes[2].consumers = new Array(1);
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].consumers[0]', /sparse array hole/);
});

test('user-visible item requires consumer and integration gates', () => {
  const value = validRoadmap();
  value.nodes[2].consumers = [];
  value.nodes[2].requiredGates = ['spec', 'tests'];
  assert.throws(() => parseRoadmap(value), /consumer/i);
});

test('items with consumers require the consumer gate', () => {
  const value = validRoadmap();
  value.nodes[2].requiredGates = ['spec', 'tests', 'e2e', 'audit'];
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].requiredGates', /consumer gate/);
});

test('items with consumers require the e2e gate', () => {
  const value = validRoadmap();
  value.nodes[2].requiredGates = ['spec', 'tests', 'consumer', 'audit'];
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].requiredGates', /e2e gate/);
});

test('roadmap items require a gate list', () => {
  const value = validRoadmap();
  delete value.nodes[2].requiredGates;
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].requiredGates', /required/);
});

test('roadmap rejects sparse required gates at the missing index', () => {
  const value = validRoadmap();
  value.nodes[2].requiredGates = new Array(1);
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].requiredGates[0]', /sparse array hole/);
});

test('required gates must be built in or defined by the roadmap', () => {
  const value = validRoadmap();
  value.nodes[2].requiredGates.push('security');
  expectSchemaError(() => parseRoadmap(value), '$.nodes[2].requiredGates[5]', /gate security does not exist/);
});

test('command gates require an exact structured definition', () => {
  const value = validRoadmap();
  delete value.gates.tests.cwd;
  expectSchemaError(() => parseRoadmap(value), '$.gates.tests.cwd', /required/);
});

test('command gates require a positive safe timeout', () => {
  for (const timeoutMs of [undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    const value = validRoadmap();
    if (timeoutMs === undefined) delete value.gates.tests.timeoutMs;
    else value.gates.tests.timeoutMs = timeoutMs;
    expectSchemaError(() => parseRoadmap(value), '$.gates.tests.timeoutMs', /positive safe integer/);
  }
});

test('command gates reject sparse argument arrays at the missing index', () => {
  const value = validRoadmap();
  value.gates.tests.args = new Array(1);
  expectSchemaError(() => parseRoadmap(value), '$.gates.tests.args[0]', /sparse array hole/);
});

test('attestation gates require exact producer and schema IDs', () => {
  const value = validRoadmap();
  value.gates.audit.schema = 'ddd-audit/v2';
  expectSchemaError(() => parseRoadmap(value), '$.gates.audit.schema', /ddd-audit\/v1/);
});

for (const status of ['planned', 'blocked', 'failed', 'cancelled', 'done']) {
  test(`roadmap accepts persisted item status ${status}`, () => {
    const value = validRoadmap();
    value.nodes[2].status = status;
    assert.equal(parseRoadmap(value).nodes[2].status, status);
  });
}

for (const status of ['ready', 'in_progress', 'verifying']) {
  test(`roadmap rejects transient item status ${status}`, () => {
    const value = validRoadmap();
    value.nodes[2].status = status;
    expectSchemaError(() => parseRoadmap(value), '$.nodes[2].status', /planned.*blocked.*failed.*cancelled.*done/);
  });
}

test('roadmap rejects legacy Markdown input', () => {
  expectSchemaError(() => parseRoadmap('# Roadmap\n\n- [ ] P1.1.1'), '$', /object/);
});

test('spec parser returns a deeply frozen validated copy', () => {
  const value = validSpec();
  const parsed = parseSpec(value);

  assert.notEqual(parsed, value);
  assert.notEqual(parsed.acceptanceCriteria, value.acceptanceCriteria);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.acceptanceCriteria));
  assert.ok(Object.isFrozen(parsed.acceptanceCriteria[0]));
  assert.ok(Object.isFrozen(parsed.consumers));
});

test('spec rejects unknown keys', () => {
  const value = validSpec();
  value.acceptanceCriteria[0].and = 'an extra clause';
  expectSchemaError(() => parseSpec(value), '$.acceptanceCriteria[0].and', /unknown key and/);
});

test('spec rejects positional acceptance-criterion IDs', () => {
  const value = validSpec({ acceptanceCriteria: [{ id: 'AC-1', covers: ['P1.1.1'], given: 'x', when: 'y', then: 'z' }] });
  assert.throws(() => parseSpec(value), /AC-P1\.1-001/);
});

test('spec rejects duplicate acceptance-criterion IDs', () => {
  const value = validSpec();
  value.acceptanceCriteria.push({ ...value.acceptanceCriteria[0] });
  expectSchemaError(() => parseSpec(value), '$.acceptanceCriteria[1].id', /duplicate.*AC-P1\.1-001/);
});

test('spec accepts only draft or approved status', () => {
  expectSchemaError(() => parseSpec(validSpec({ status: 'done' })), '$.status', /draft.*approved/);
});

test('spec requires exact Given/When/Then string fields', () => {
  const value = validSpec();
  value.acceptanceCriteria[0].when = 42;
  expectSchemaError(() => parseSpec(value), '$.acceptanceCriteria[0].when', /string/);
});

test('spec requires stable acceptance-criterion coverage', () => {
  expectSchemaError(() => parseSpec(validSpec({ acceptanceCriteria: [] })), '$.acceptanceCriteria', /at least one/);
});

test('spec requires explicit item coverage, models, and contracts', () => {
  const missingCoverage = validSpec();
  delete missingCoverage.acceptanceCriteria[0].covers;
  expectSchemaError(() => parseSpec(missingCoverage), '$.acceptanceCriteria[0].covers', /required/);
  expectSchemaError(() => parseSpec(validSpec({ models: [] })), '$.models', /at least one/);
  expectSchemaError(() => parseSpec(validSpec({ contracts: [] })), '$.contracts', /at least one/);
});

test('spec shared contracts require canonical paths and content hashes', () => {
  expectSchemaError(
    () => parseSpec(validSpec({ sharedContracts: [{ path: '../escape.json', hash: `sha256:${'0'.repeat(64)}` }] })),
    '$.sharedContracts[0].path',
    /canonical repository-relative/
  );
  expectSchemaError(
    () => parseSpec(validSpec({ sharedContracts: [{ path: 'contracts/profile.json', hash: 'latest' }] })),
    '$.sharedContracts[0].hash',
    /sha256/
  );
});

test('spec rejects sparse acceptance criteria at the missing index', () => {
  expectSchemaError(
    () => parseSpec(validSpec({ acceptanceCriteria: new Array(1) })),
    '$.acceptanceCriteria[0]',
    /sparse array hole/
  );
});

test('spec rejects sparse shared contracts at the missing index', () => {
  expectSchemaError(
    () => parseSpec(validSpec({ sharedContracts: new Array(1) })),
    '$.sharedContracts[0]',
    /sparse array hole/
  );
});

test('spec rejects sparse consumers at the missing index', () => {
  expectSchemaError(
    () => parseSpec(validSpec({ consumers: new Array(1) })),
    '$.consumers[0]',
    /sparse array hole/
  );
});

test('spec rejects legacy Markdown input', () => {
  expectSchemaError(() => parseSpec('## Acceptance Criteria\n\n- Given x when y then z'), '$', /object/);
});

for (const [name, parse, create] of [
  ['run', parseRun, overrides => validRun(overrides)],
  ['report', parseReport, overrides => ({
    schemaVersion: 1,
    revision: 3,
    runId: 'run-001',
    status: 'successful',
    selector: 'P1.1.1',
    scope: ['P1.1.1'],
    items: { 'P1.1.1': { attempts: [], id: 'P1.1.1', status: 'done' } },
    ...overrides
  })]
]) {
  test(`${name} parser validates and deeply freezes the common envelope`, () => {
    const value = create({ revision: 3 });
    const parsed = parse(value);

    assert.deepEqual(parsed, value);
    assert.notEqual(parsed, value);
    assert.ok(Object.isFrozen(parsed));
  });

  test(`${name} parser rejects unknown envelope keys`, () => {
    const value = create({ legacy: true });
    expectSchemaError(() => parse(value), '$.legacy', /unknown key legacy/);
  });

  test(`${name} parser rejects invalid envelope fields with a full path`, () => {
    const value = create({ revision: '3' });
    expectSchemaError(() => parse(value), '$.revision', /non-negative integer/);
  });
}

test('revision counters accept MAX_SAFE_INTEGER and reject unsafe integers', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const unsafe = maximum + 1;
  const report = {
    schemaVersion: 1,
    revision: maximum,
    runId: 'run-001',
    status: 'successful',
    selector: 'P1.1.1',
    scope: ['P1.1.1'],
    items: { 'P1.1.1': { attempts: [], id: 'P1.1.1', status: 'done' } }
  };

  assert.equal(parseRoadmap(validRoadmap({ revision: maximum })).revision, maximum);
  assert.equal(parseRun(validRun({ revision: maximum })).revision, maximum);
  assert.equal(parseReport(report).revision, maximum);
  assert.equal(parseRun(validRun({ pendingTransaction: validTransaction({ expectedRoadmapRevision: maximum }) }))
    .pendingTransaction.expectedRoadmapRevision, maximum);

  expectSchemaError(() => parseRoadmap(validRoadmap({ revision: unsafe })), '$.revision', /safe range/);
  expectSchemaError(() => parseRun(validRun({ revision: unsafe })), '$.revision', /safe range/);
  expectSchemaError(() => parseReport({ ...report, revision: unsafe }), '$.revision', /safe range/);
  expectSchemaError(
    () => parseRun(validRun({ pendingTransaction: validTransaction({ expectedRoadmapRevision: unsafe }) })),
    '$.pendingTransaction.expectedRoadmapRevision',
    /safe range/
  );
});
