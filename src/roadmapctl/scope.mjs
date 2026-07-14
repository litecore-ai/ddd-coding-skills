import { RoadmapError } from './errors.mjs';
import { topologicalOrder } from './graph.mjs';
import { ROADMAP_ID_PATTERN, compareIds, idSegments } from './ids.mjs';

export { compareIds } from './ids.mjs';

function fail(message, details = {}) {
  throw new RoadmapError('SELECTOR_INVALID', message, details);
}

export function parseSelector(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    fail('selector must be a non-empty string', { selector: text });
  }

  return text.split(',').map(part => {
    const token = part.trim();
    const match = /^(P\d+(?:\.\d+){0,2})(?:\s*-\s*(P\d+(?:\.\d+){0,2}))?$/.exec(token);
    if (!match || !ROADMAP_ID_PATTERN.test(match[1]) || (match[2] && !ROADMAP_ID_PATTERN.test(match[2]))) {
      fail(`invalid selector expression ${JSON.stringify(token)}`, { selector: text, expression: token });
    }
    return match[2]
      ? { type: 'range', start: match[1], end: match[2] }
      : { type: 'single', id: match[1] };
  });
}

export function expandScope(roadmap, text) {
  const nodesById = new Map(roadmap.nodes.map(node => [node.id, node]));
  const selectedNodes = new Set();

  function knownNode(id) {
    const node = nodesById.get(id);
    if (!node) fail(`unknown selector ${id}`, { selector: text, id });
    return node;
  }

  for (const selection of parseSelector(text)) {
    if (selection.type === 'single') {
      selectedNodes.add(knownNode(selection.id).id);
      continue;
    }

    knownNode(selection.start);
    knownNode(selection.end);
    const startSegments = idSegments(selection.start);
    const endSegments = idSegments(selection.end);
    if (startSegments.length !== endSegments.length) {
      fail(`range endpoints must be at the same level: ${selection.start} - ${selection.end}`, {
        selector: text,
        start: selection.start,
        end: selection.end
      });
    }

    const [start, end] = compareIds(selection.start, selection.end) <= 0
      ? [selection.start, selection.end]
      : [selection.end, selection.start];
    roadmap.nodes
      .filter(node => idSegments(node.id).length === startSegments.length)
      .filter(node => compareIds(node.id, start) >= 0 && compareIds(node.id, end) <= 0)
      .forEach(node => selectedNodes.add(node.id));
  }

  const childrenByParent = new Map();
  for (const node of roadmap.nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  const executableIds = new Set();
  function addLeaves(node) {
    if (node.kind === 'item') {
      executableIds.add(node.id);
      return;
    }
    for (const child of childrenByParent.get(node.id) ?? []) addLeaves(child);
  }
  for (const id of selectedNodes) addLeaves(nodesById.get(id));

  return topologicalOrder(roadmap, [...executableIds]);
}
