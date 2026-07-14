import { RoadmapError } from './errors.mjs';
import { compareIds } from './ids.mjs';

function itemMap(roadmap) {
  return new Map(roadmap.nodes.filter(node => node.kind === 'item').map(node => [node.id, node]));
}

function unknownItem(id) {
  throw new RoadmapError('GRAPH_INVALID', `unknown executable item ${id}`, { itemId: id });
}

export function validateGraph(roadmap) {
  const items = itemMap(roadmap);
  const state = new Map();
  const stack = [];

  function visit(id) {
    state.set(id, 'visiting');
    stack.push(id);

    const dependencies = [...items.get(id).dependsOn].sort(compareIds);
    for (const dependencyId of dependencies) {
      if (!items.has(dependencyId)) unknownItem(dependencyId);
      if (state.get(dependencyId) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(dependencyId)), dependencyId];
        throw new RoadmapError('GRAPH_CYCLE', `dependency cycle: ${cycle.join(' -> ')}`, { cycle });
      }
      if (state.get(dependencyId) !== 'visited') visit(dependencyId);
    }

    stack.pop();
    state.set(id, 'visited');
  }

  for (const id of [...items.keys()].sort(compareIds)) {
    if (!state.has(id)) visit(id);
  }
  return roadmap;
}

export function topologicalOrder(roadmap, ids) {
  validateGraph(roadmap);
  const items = itemMap(roadmap);
  const selected = new Set(ids);
  for (const id of selected) {
    if (!items.has(id)) unknownItem(id);
  }

  const indegree = new Map([...selected].map(id => [id, 0]));
  const dependents = new Map([...selected].map(id => [id, []]));
  for (const id of selected) {
    for (const dependencyId of items.get(id).dependsOn) {
      if (!selected.has(dependencyId)) continue;
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dependencyId).push(id);
    }
  }

  const ready = [...selected].filter(id => indegree.get(id) === 0).sort(compareIds);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(id);
    for (const dependentId of dependents.get(id).sort(compareIds)) {
      const remaining = indegree.get(dependentId) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
        ready.sort(compareIds);
      }
    }
  }

  if (ordered.length !== selected.size) {
    throw new RoadmapError('GRAPH_CYCLE', 'dependency graph contains a cycle');
  }
  return ordered;
}

export function blockersFor(roadmap, itemId) {
  const items = itemMap(roadmap);
  const item = items.get(itemId);
  if (!item) unknownItem(itemId);
  return [...item.dependsOn]
    .sort(compareIds)
    .filter(dependencyId => items.get(dependencyId).status !== 'done')
    .map(dependencyId => ({ itemId: dependencyId, state: items.get(dependencyId).status }));
}
