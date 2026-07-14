import test from 'node:test';
import assert from 'node:assert/strict';
import { compareIds, expandScope, parseSelector } from '../../src/roadmapctl/scope.mjs';
import { blockersFor, topologicalOrder, validateGraph } from '../../src/roadmapctl/graph.mjs';
import {
  ACTIVE_STATES,
  SETTLED_STATES,
  assertTransition,
  deriveAggregate,
  readyItems
} from '../../src/roadmapctl/state.mjs';
import { validRoadmap } from './helpers.mjs';

function addFeature(roadmap, featureNumber, itemNumber = 1, overrides = {}) {
  const featureId = `P1.${featureNumber}`;
  const itemId = `${featureId}.${itemNumber}`;
  roadmap.nodes.push({ id: featureId, kind: 'feature', parentId: 'P1', title: `Feature ${featureNumber}` });
  roadmap.nodes.push({
    ...roadmap.nodes[2],
    id: itemId,
    parentId: featureId,
    title: `Flow ${itemId}`,
    dependsOn: [],
    spec: {
      ...roadmap.nodes[2].spec,
      path: `docs/specs/${featureId}.json`,
      acceptanceCriteria: [`AC-${featureId}-001`]
    },
    ...overrides
  });
  return itemId;
}

function addDependentItem(roadmap, status = 'planned') {
  roadmap.nodes.push({
    ...roadmap.nodes[2],
    id: 'P1.1.2',
    title: 'Query flow',
    dependsOn: ['P1.1.1'],
    spec: { ...roadmap.nodes[2].spec, acceptanceCriteria: ['AC-P1.1-002'] },
    status
  });
}

test('selector parser produces an explicit single-and-range AST', () => {
  assert.deepEqual(parseSelector('P1.1, P2.1 - P2.3'), [
    { type: 'single', id: 'P1.1' },
    { type: 'range', start: 'P2.1', end: 'P2.3' }
  ]);
});

test('natural ID comparison sorts missing and numeric segments deterministically', () => {
  assert.deepEqual(
    ['P1.10', 'P1.2.1', 'P1.2', 'P1'].sort(compareIds),
    ['P1', 'P1.2', 'P1.2.1', 'P1.10']
  );
});

test('composite scope expands every descendant leaf', () => {
  const roadmap = validRoadmap();
  roadmap.nodes.push(
    { id: 'P1.1.2', kind: 'item', parentId: 'P1.1', title: 'Query flow', outcome: 'A user queries profiles', dependsOn: ['P1.1.1'], spec: { ...roadmap.nodes[2].spec, acceptanceCriteria: ['AC-P1.1-002'] }, consumers: ['ProfileController'], requiredGates: [...roadmap.nodes[2].requiredGates], status: 'planned' }
  );
  assert.deepEqual(expandScope(roadmap, 'P1.1'), ['P1.1.1', 'P1.1.2']);
});

test('phase scope expands every executable descendant', () => {
  const roadmap = validRoadmap();
  addFeature(roadmap, 2);
  assert.deepEqual(expandScope(roadmap, 'P1'), ['P1.1.1', 'P1.2.1']);
});

test('leaf scope returns that executable item', () => {
  assert.deepEqual(expandScope(validRoadmap(), 'P1.1.1'), ['P1.1.1']);
});

test('comma enumeration unions duplicate descendant leaves', () => {
  const roadmap = validRoadmap();
  addFeature(roadmap, 2);
  assert.deepEqual(expandScope(roadmap, 'P1.2, P1.1.1, P1.1'), ['P1.1.1', 'P1.2.1']);
});

test('inclusive ranges accept reversed endpoints and include every same-level node', () => {
  const roadmap = validRoadmap();
  addFeature(roadmap, 2);
  addFeature(roadmap, 3);
  assert.deepEqual(expandScope(roadmap, 'P1.3 - P1.1'), ['P1.1.1', 'P1.2.1', 'P1.3.1']);
});

test('ranges reject endpoints from different hierarchy levels', () => {
  assert.throws(() => expandScope(validRoadmap(), 'P1 - P1.1'), /same level|cross-level/i);
});

test('unknown selectors fail instead of silently producing empty scope', () => {
  assert.throws(() => expandScope(validRoadmap(), 'P9.9'), /unknown selector.*P9\.9/i);
});

test('dependency order wins over lexical order', () => {
  const roadmap = validRoadmap();
  roadmap.nodes.push({ ...roadmap.nodes[2], id: 'P1.1.0', title: 'Later by dependency', dependsOn: ['P1.1.1'] });
  assert.deepEqual(topologicalOrder(roadmap, ['P1.1.0', 'P1.1.1']), ['P1.1.1', 'P1.1.0']);
});

test('topological ready queue uses natural numeric ID order', () => {
  const roadmap = validRoadmap();
  const ten = addFeature(roadmap, 10);
  const two = addFeature(roadmap, 2);
  assert.deepEqual(topologicalOrder(roadmap, [ten, two]), [two, ten]);
});

test('graph validation reports the exact dependency cycle path', () => {
  const roadmap = validRoadmap();
  addDependentItem(roadmap);
  roadmap.nodes[2].dependsOn = ['P1.1.2'];

  assert.throws(() => validateGraph(roadmap), error => {
    assert.equal(error.code, 'GRAPH_CYCLE');
    assert.deepEqual(error.details.cycle, ['P1.1.1', 'P1.1.2', 'P1.1.1']);
    assert.match(error.message, /P1\.1\.1 -> P1\.1\.2 -> P1\.1\.1/);
    return true;
  });
});

for (const status of ['blocked', 'failed', 'cancelled']) {
  test(`${status} dependencies produce an exact downstream blocker`, () => {
    const roadmap = validRoadmap();
    roadmap.nodes[2].status = status;
    addDependentItem(roadmap);
    assert.deepEqual(blockersFor(roadmap, 'P1.1.2'), [{ itemId: 'P1.1.1', state: status }]);
    assert.deepEqual(readyItems(roadmap, ['P1.1.2'], { currentItemId: null, attempts: {} }), []);
  });
}

test('a planned leaf is ready only after every dependency is done', () => {
  const roadmap = validRoadmap();
  addDependentItem(roadmap);
  assert.deepEqual(readyItems(roadmap, ['P1.1.1', 'P1.1.2'], { currentItemId: null, attempts: {} }), ['P1.1.1']);
  roadmap.nodes[2].status = 'done';
  assert.deepEqual(readyItems(roadmap, ['P1.1.1', 'P1.1.2'], { currentItemId: null, attempts: {} }), ['P1.1.2']);
});

const LEGAL_TRANSITIONS = [
  ['planned', 'ready'], ['planned', 'blocked'], ['planned', 'cancelled'],
  ['ready', 'in_progress'], ['ready', 'blocked'], ['ready', 'cancelled'],
  ['in_progress', 'verifying'], ['in_progress', 'blocked'], ['in_progress', 'failed'], ['in_progress', 'cancelled'],
  ['verifying', 'done'], ['verifying', 'blocked'], ['verifying', 'failed'], ['verifying', 'cancelled'],
  ['blocked', 'ready'], ['blocked', 'cancelled'],
  ['failed', 'ready'], ['failed', 'cancelled']
];

for (const [from, to] of LEGAL_TRANSITIONS) {
  test(`transition ${from} -> ${to} is legal`, () => {
    assert.equal(assertTransition(from, to), to);
  });
}

test('state constants expose only persisted and active states and are frozen', () => {
  assert.deepEqual(SETTLED_STATES, ['planned', 'blocked', 'failed', 'cancelled', 'done']);
  assert.deepEqual(ACTIVE_STATES, ['in_progress', 'verifying']);
  assert.ok(Object.isFrozen(SETTLED_STATES));
  assert.ok(Object.isFrozen(ACTIVE_STATES));
});

test('illegal completion jump is rejected', () => {
  assert.throws(() => assertTransition('planned', 'done'), /planned.*done/);
});

test('terminal states cannot transition', () => {
  assert.throws(() => assertTransition('done', 'ready'), /done.*ready/);
  assert.throws(() => assertTransition('cancelled', 'ready'), /cancelled.*ready/);
});

test('one done leaf never completes its parent', () => {
  const roadmap = validRoadmap();
  roadmap.nodes.push({ ...roadmap.nodes[2], id: 'P1.1.2', title: 'Second flow' });
  roadmap.nodes[2].status = 'done';
  assert.equal(deriveAggregate(roadmap, 'P1.1', { currentItemId: null, attempts: {} }), 'in_progress');
});

test('aggregate state follows done, failed, blocked, active, cancelled, then planned semantics', () => {
  const roadmap = validRoadmap();
  addDependentItem(roadmap);
  const run = { currentItemId: null, attempts: {} };

  roadmap.nodes[2].status = 'done';
  roadmap.nodes[3].status = 'done';
  assert.equal(deriveAggregate(roadmap, 'P1.1', run), 'done');

  roadmap.nodes[3].status = 'failed';
  assert.equal(deriveAggregate(roadmap, 'P1.1', run), 'failed');

  roadmap.nodes[3].status = 'blocked';
  assert.equal(deriveAggregate(roadmap, 'P1.1', run), 'blocked');

  roadmap.nodes[2].status = 'planned';
  roadmap.nodes[3].status = 'planned';
  assert.equal(deriveAggregate(roadmap, 'P1.1', {
    currentItemId: 'P1.1.1',
    attempts: { 'P1.1.1': [{ number: 1, state: 'verifying' }] }
  }), 'in_progress');

  roadmap.nodes[2].status = 'cancelled';
  roadmap.nodes[3].status = 'cancelled';
  assert.equal(deriveAggregate(roadmap, 'P1.1', run), 'cancelled');

  roadmap.nodes[2].status = 'planned';
  roadmap.nodes[3].status = 'planned';
  assert.equal(deriveAggregate(roadmap, 'P1.1', run), 'planned');
});
