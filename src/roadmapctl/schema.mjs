import { RoadmapError } from './errors.mjs';

const ROADMAP_KEYS = ['schemaVersion', 'project', 'revision', 'nodes', 'gates'];
const NODE_KEYS = Object.freeze({
  phase: ['id', 'kind', 'title'],
  feature: ['id', 'kind', 'parentId', 'title'],
  item: ['id', 'kind', 'parentId', 'title', 'outcome', 'dependsOn', 'spec', 'consumers', 'requiredGates', 'status']
});
const ITEM_STATES = ['planned', 'blocked', 'failed', 'cancelled', 'done'];
const SPEC_KEYS = ['schemaVersion', 'id', 'title', 'status', 'acceptanceCriteria', 'sharedContracts', 'consumers'];
const REPORT_KEYS = ['schemaVersion', 'revision', 'runId', 'status'];
const RUN_KEYS = [...REPORT_KEYS, 'pendingTransaction'];
const TRANSACTION_KEYS = [
  'id',
  'type',
  'state',
  'expectedRoadmapRevision',
  'itemId',
  'targetState',
  'implementationSha',
  'allowedPaths',
  'bookkeepingSha'
];
const BUILT_IN_GATES = new Set(['spec']);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TRANSACTION_ID = /^tx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(path, message, details = {}) {
  throw new RoadmapError('SCHEMA_INVALID', `${path}: ${message}`, { path, ...details });
}

function object(value, path) {
  if (value === undefined) fail(path, 'is required and must be an object');
  if (value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be an object');
  }
  return value;
}

function string(value, path) {
  if (value === undefined) fail(path, 'is required and must be a string');
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function rejectSparse(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${path}[${index}]`, 'sparse array hole is not allowed');
  }
}

function stringArray(value, path, { minLength = 0 } = {}) {
  if (value === undefined) fail(path, 'is required and must be an array of strings');
  if (!Array.isArray(value)) fail(path, 'must be an array of strings');
  rejectSparse(value, path);
  if (value.length < minLength) fail(path, `must contain at least ${minLength === 1 ? 'one' : minLength} string${minLength === 1 ? '' : 's'}`);
  for (let index = 0; index < value.length; index += 1) string(value[index], `${path}[${index}]`);
  return value;
}

function enumValue(value, allowed, path) {
  if (value === undefined) fail(path, `is required and must be one of: ${allowed.join(', ')}`);
  if (!allowed.includes(value)) fail(path, `must be one of: ${allowed.join(', ')}`);
  return value;
}

function rejectUnknown(value, allowed, path) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, `unknown key ${key}`);
  }
}

function nonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
  return value;
}

function array(value, path, { minLength = 0 } = {}) {
  if (value === undefined) fail(path, 'is required and must be an array');
  if (!Array.isArray(value)) fail(path, 'must be an array');
  rejectSparse(value, path);
  if (value.length < minLength) fail(path, `must contain at least ${minLength === 1 ? 'one' : minLength} item${minLength === 1 ? '' : 's'}`);
  return value;
}

function pattern(value, expression, path, message) {
  if (!expression.test(value)) fail(path, message);
}

function cloneDocument(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    fail('$', 'must be a cloneable JSON document', { cause: error.message });
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function uniqueStrings(values, path, label, suffix = '') {
  const seen = new Set();
  values.forEach((value, index) => {
    if (seen.has(value)) fail(`${path}[${index}]${suffix}`, `duplicate ${label} ${value}`);
    seen.add(value);
  });
}

function validateGate(definition, path) {
  object(definition, path);
  enumValue(definition.type, ['command', 'attestation'], `${path}.type`);

  if (definition.type === 'command') {
    rejectUnknown(definition, ['type', 'executable', 'args', 'cwd'], path);
    string(definition.executable, `${path}.executable`);
    stringArray(definition.args, `${path}.args`);
    string(definition.cwd, `${path}.cwd`);
    return;
  }

  rejectUnknown(definition, ['type', 'producer', 'schema'], path);
  enumValue(definition.producer, ['ddd-audit'], `${path}.producer`);
  enumValue(definition.schema, ['ddd-audit/v1'], `${path}.schema`);
}

function validateSpecReference(reference, path) {
  object(reference, path);
  rejectUnknown(reference, ['path', 'hash', 'acceptanceCriteria'], path);
  string(reference.path, `${path}.path`);
  pattern(reference.path, /\.json$/, `${path}.path`, 'must reference a JSON spec document');
  string(reference.hash, `${path}.hash`);
  pattern(reference.hash, /^sha256:[0-9a-f]{64}$/, `${path}.hash`, 'must be a sha256: hash with 64 lowercase hexadecimal digits');
  stringArray(reference.acceptanceCriteria, `${path}.acceptanceCriteria`, { minLength: 1 });
  uniqueStrings(reference.acceptanceCriteria, `${path}.acceptanceCriteria`, 'acceptance-criterion id');
}

function validateNode(node, index) {
  const path = `$.nodes[${index}]`;
  object(node, path);
  enumValue(node.kind, ['phase', 'feature', 'item'], `${path}.kind`);
  rejectUnknown(node, NODE_KEYS[node.kind], path);
  string(node.id, `${path}.id`);
  string(node.title, `${path}.title`);

  if (node.kind === 'phase') {
    pattern(node.id, /^P\d+$/, `${path}.id`, 'phase id must match PNN');
    return;
  }

  string(node.parentId, `${path}.parentId`);
  if (node.kind === 'feature') {
    pattern(node.id, /^P\d+\.\d+$/, `${path}.id`, 'feature id must match PNN.NN');
    return;
  }

  pattern(node.id, /^P\d+\.\d+\.\d+$/, `${path}.id`, 'item id must match PNN.NN.NN');
  string(node.outcome, `${path}.outcome`);
  stringArray(node.dependsOn, `${path}.dependsOn`);
  validateSpecReference(node.spec, `${path}.spec`);
  stringArray(node.consumers, `${path}.consumers`, { minLength: 1 });
  uniqueStrings(node.consumers, `${path}.consumers`, 'consumer');
  stringArray(node.requiredGates, `${path}.requiredGates`, { minLength: 1 });
  uniqueStrings(node.requiredGates, `${path}.requiredGates`, 'gate');
  enumValue(node.status, ITEM_STATES, `${path}.status`);
}

function validateRoadmapCrossRecords(roadmap) {
  const nodesById = new Map();

  roadmap.nodes.forEach((node, index) => {
    if (nodesById.has(node.id)) fail(`$.nodes[${index}].id`, `duplicate id ${node.id}`);
    nodesById.set(node.id, node);
  });

  roadmap.nodes.forEach((node, index) => {
    if (node.kind === 'phase') return;
    const path = `$.nodes[${index}]`;
    const parent = nodesById.get(node.parentId);
    if (!parent) fail(`${path}.parentId`, `parent ${node.parentId} does not exist`);

    const requiredParentKind = node.kind === 'feature' ? 'phase' : 'feature';
    if (parent.kind !== requiredParentKind) {
      fail(`${path}.parentId`, `${node.kind} parent must be a ${requiredParentKind}`);
    }
    if (!node.id.startsWith(`${node.parentId}.`)) {
      fail(`${path}.id`, `id ${node.id} must use parent prefix ${node.parentId}`);
    }

    if (node.kind !== 'item') return;
    node.dependsOn.forEach((dependencyId, dependencyIndex) => {
      const dependency = nodesById.get(dependencyId);
      const dependencyPath = `${path}.dependsOn[${dependencyIndex}]`;
      if (!dependency) fail(dependencyPath, `dependency ${dependencyId} does not exist`);
      if (dependency.kind !== 'item') fail(dependencyPath, `dependency ${dependencyId} must reference an item`);
    });

    node.requiredGates.forEach((gateName, gateIndex) => {
      if (!BUILT_IN_GATES.has(gateName) && !Object.hasOwn(roadmap.gates, gateName)) {
        fail(`${path}.requiredGates[${gateIndex}]`, `gate ${gateName} does not exist`);
      }
    });
    if (!node.requiredGates.includes('spec')) fail(`${path}.requiredGates`, 'must include the built-in spec gate');
    if (node.consumers.length > 0 && !node.requiredGates.includes('consumer')) {
      fail(`${path}.requiredGates`, 'items with consumers require the consumer gate');
    }
    if (node.consumers.length > 0 && !node.requiredGates.includes('e2e')) {
      fail(`${path}.requiredGates`, 'items with consumers require the e2e gate');
    }
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nullableGitObjectId(value, path) {
  if (value === null) return;
  string(value, path);
  pattern(value, GIT_OBJECT_ID, path, 'must be null or a 40- or 64-character lowercase Git object ID');
}

function validateTransaction(transaction, path) {
  object(transaction, path);
  rejectUnknown(transaction, TRANSACTION_KEYS, path);
  string(transaction.id, `${path}.id`);
  pattern(transaction.id, TRANSACTION_ID, `${path}.id`, 'must be tx- followed by a lowercase UUID');
  enumValue(transaction.type, ['settle-item', 'close-run'], `${path}.type`);
  enumValue(transaction.state, ['prepared', 'committed'], `${path}.state`);
  nonNegativeInteger(transaction.expectedRoadmapRevision, `${path}.expectedRoadmapRevision`);
  nullableGitObjectId(transaction.implementationSha, `${path}.implementationSha`);
  stringArray(transaction.allowedPaths, `${path}.allowedPaths`, { minLength: 1 });
  uniqueStrings(transaction.allowedPaths, `${path}.allowedPaths`, 'allowed path');
  nullableGitObjectId(transaction.bookkeepingSha, `${path}.bookkeepingSha`);

  if (transaction.type === 'settle-item') {
    string(transaction.itemId, `${path}.itemId`);
    pattern(transaction.itemId, /^P\d+\.\d+\.\d+$/, `${path}.itemId`, 'item id must match PNN.NN.NN');
    enumValue(transaction.targetState, ['done', 'blocked', 'failed', 'cancelled'], `${path}.targetState`);
  } else {
    if (transaction.itemId !== null) fail(`${path}.itemId`, 'must be null for a close-run transaction');
    if (transaction.targetState !== null) fail(`${path}.targetState`, 'must be null for a close-run transaction');
  }

  if (transaction.state === 'committed' && transaction.bookkeepingSha === null) {
    fail(`${path}.bookkeepingSha`, 'must contain the bookkeeping Git object ID for a committed transaction');
  }
}

function validateCommonEnvelope(value, allowedKeys) {
  object(value, '$');
  rejectUnknown(value, allowedKeys, '$');
  enumValue(value.schemaVersion, [1], '$.schemaVersion');
  nonNegativeInteger(value.revision, '$.revision');
  string(value.runId, '$.runId');
  string(value.status, '$.status');
}

export function parseRoadmap(value) {
  const roadmap = cloneDocument(value);
  object(roadmap, '$');
  rejectUnknown(roadmap, ROADMAP_KEYS, '$');
  enumValue(roadmap.schemaVersion, [1], '$.schemaVersion');
  string(roadmap.project, '$.project');
  nonNegativeInteger(roadmap.revision, '$.revision');
  array(roadmap.nodes, '$.nodes', { minLength: 1 });
  object(roadmap.gates, '$.gates');

  Object.entries(roadmap.gates).forEach(([name, definition]) => {
    string(name, '$.gates');
    validateGate(definition, `$.gates.${name}`);
  });
  roadmap.nodes.forEach(validateNode);
  validateRoadmapCrossRecords(roadmap);
  return deepFreeze(roadmap);
}

export function parseSpec(value) {
  const spec = cloneDocument(value);
  object(spec, '$');
  rejectUnknown(spec, SPEC_KEYS, '$');
  enumValue(spec.schemaVersion, [1], '$.schemaVersion');
  string(spec.id, '$.id');
  pattern(spec.id, /^P\d+\.\d+$/, '$.id', 'spec id must match PNN.NN');
  string(spec.title, '$.title');
  enumValue(spec.status, ['draft', 'approved'], '$.status');
  array(spec.acceptanceCriteria, '$.acceptanceCriteria', { minLength: 1 });
  stringArray(spec.sharedContracts, '$.sharedContracts');
  stringArray(spec.consumers, '$.consumers', { minLength: 1 });
  uniqueStrings(spec.consumers, '$.consumers', 'consumer');

  const acceptanceIds = [];
  const expectedId = new RegExp(`^AC-${escapeRegex(spec.id)}-\\d{3}$`);
  spec.acceptanceCriteria.forEach((criterion, index) => {
    const path = `$.acceptanceCriteria[${index}]`;
    object(criterion, path);
    rejectUnknown(criterion, ['id', 'given', 'when', 'then'], path);
    string(criterion.id, `${path}.id`);
    pattern(criterion.id, expectedId, `${path}.id`, `must match AC-${spec.id}-NNN (for example AC-${spec.id}-001)`);
    string(criterion.given, `${path}.given`);
    string(criterion.when, `${path}.when`);
    string(criterion.then, `${path}.then`);
    acceptanceIds.push(criterion.id);
  });
  uniqueStrings(acceptanceIds, '$.acceptanceCriteria', 'acceptance-criterion id', '.id');
  return deepFreeze(spec);
}

export function parseRun(value) {
  const run = cloneDocument(value);
  validateCommonEnvelope(run, RUN_KEYS);
  if (run.pendingTransaction !== undefined && run.pendingTransaction !== null) {
    validateTransaction(run.pendingTransaction, '$.pendingTransaction');
  }
  return deepFreeze(run);
}

export function parseReport(value) {
  const report = cloneDocument(value);
  validateCommonEnvelope(report, REPORT_KEYS);
  return deepFreeze(report);
}
