import { RoadmapError } from './errors.mjs';
import { blockersFor, topologicalOrder } from './graph.mjs';

export const SETTLED_STATES = Object.freeze(['planned', 'blocked', 'failed', 'cancelled', 'done']);
export const ACTIVE_STATES = Object.freeze(['in_progress', 'verifying']);

const LEGAL = new Map([
  ['planned', new Set(['ready', 'blocked', 'cancelled'])],
  ['ready', new Set(['in_progress', 'blocked', 'cancelled'])],
  ['in_progress', new Set(['verifying', 'blocked', 'failed', 'cancelled'])],
  ['verifying', new Set(['done', 'blocked', 'failed', 'cancelled'])],
  ['blocked', new Set(['ready', 'cancelled'])],
  ['failed', new Set(['ready', 'cancelled'])],
  ['cancelled', new Set()],
  ['done', new Set()]
]);

export function assertTransition(from, to) {
  if (!LEGAL.get(from)?.has(to)) {
    throw new RoadmapError('STATE_TRANSITION_INVALID', `illegal state transition ${from} -> ${to}`, { from, to });
  }
  return to;
}

function currentAttempt(run, itemId) {
  if (!run || run.currentItemId !== itemId) return null;
  const attempts = run.attempts?.[itemId];
  if (Array.isArray(attempts)) return attempts.at(-1) ?? null;
  return attempts ?? null;
}

function leafState(item, run) {
  const attempt = currentAttempt(run, item.id);
  return attempt && ACTIVE_STATES.includes(attempt.state) ? attempt.state : item.status;
}

export function readyItems(roadmap, scope, run) {
  if (run?.currentItemId) return [];
  const items = new Map(roadmap.nodes.filter(node => node.kind === 'item').map(node => [node.id, node]));
  return topologicalOrder(roadmap, scope).filter(id => {
    const item = items.get(id);
    return item.status === 'planned' && blockersFor(roadmap, id).length === 0;
  });
}

export function deriveAggregate(roadmap, nodeId, run) {
  const nodes = new Map(roadmap.nodes.map(node => [node.id, node]));
  const node = nodes.get(nodeId);
  if (!node) throw new RoadmapError('STATE_NODE_UNKNOWN', `unknown roadmap node ${nodeId}`, { nodeId });

  if (node.kind === 'item') {
    const state = leafState(node, run);
    if (state === 'planned' && blockersFor(roadmap, node.id).length === 0) return 'ready';
    return state;
  }

  const leaves = roadmap.nodes.filter(candidate =>
    candidate.kind === 'item' && (candidate.parentId === node.id || candidate.id.startsWith(`${node.id}.`))
  );
  if (leaves.length === 0) return 'planned';

  const states = leaves.map(leaf => leafState(leaf, run));
  if (states.every(state => state === 'done')) return 'done';
  if (states.includes('failed')) return 'failed';

  const hasTerminalDependencyBlocker = leaves.some((leaf, index) =>
    states[index] === 'planned'
      && blockersFor(roadmap, leaf.id).some(blocker => ['blocked', 'failed', 'cancelled'].includes(blocker.state))
  );
  if (states.includes('blocked') || hasTerminalDependencyBlocker) return 'blocked';
  if (states.some(state => ACTIVE_STATES.includes(state))) return 'in_progress';

  const incompleteStates = states.filter(state => state !== 'done');
  if (incompleteStates.length > 0 && incompleteStates.every(state => state === 'cancelled')) return 'cancelled';
  if (states.includes('done')) return 'in_progress';
  return 'planned';
}
