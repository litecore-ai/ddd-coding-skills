import { RoadmapError } from './errors.mjs';
import { topologicalOrder } from './graph.mjs';

const ID_PATTERN = /^P\d+(?:\.\d+){0,2}$/;

function fail(message, details = {}) {
  throw new RoadmapError('SELECTOR_INVALID', message, details);
}

function segments(id) {
  return id.slice(1).split('.').map(Number);
}

export function compareIds(a, b) {
  const left = segments(a);
  const right = segments(b);
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export function parseSelector(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    fail('selector must be a non-empty string', { selector: text });
  }

  return text.split(',').map(part => {
    const token = part.trim();
    const match = /^(P\d+(?:\.\d+){0,2})(?:\s*-\s*(P\d+(?:\.\d+){0,2}))?$/.exec(token);
    if (!match || !ID_PATTERN.test(match[1]) || (match[2] && !ID_PATTERN.test(match[2]))) {
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
    const startSegments = segments(selection.start);
    const endSegments = segments(selection.end);
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
      .filter(node => segments(node.id).length === startSegments.length)
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
