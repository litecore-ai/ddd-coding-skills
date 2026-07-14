import { createHash, randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalStringify, sha256 } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';
import { assertImplementationCommit, changedFiles, commitGenerated, prepareRunBranch, repositoryState } from './git.mjs';
import { blockersFor, validateGraph } from './graph.mjs';
import { acquireRunLock } from './lock.mjs';
import { buildRunReport, renderRoadmap, writeImmutableReport } from './render.mjs';
import { parseRoadmap, parseRun, parseSpec } from './schema.mjs';
import { expandScope } from './scope.mjs';
import { deriveAggregate, readyItems } from './state.mjs';
import { beginTransaction, commitTransaction, mutateRevision, readJson, writeJsonAtomic } from './store.mjs';
import { evaluateCompletion, gateManifestHash, runGate, validateAttestation, validateGateCommand } from './verify.mjs';

const EMPTY_DIGEST = `sha256:${createHash('sha256').update('').digest('hex')}`;

async function writeTextAtomic(path, contents, fs = fileSystem) {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await fs.mkdir(dirname(path), { recursive: true });
  let created = false;
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    created = true;
    await fs.rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await fs.rm(temporaryPath, { force: true });
  }
}

function isContained(root, path) {
  const local = relative(root, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function unsafePath() {
  return new RoadmapError('UNSAFE_PATH', 'controller path escapes the project root');
}

async function realParentPath(root, path, fs) {
  const parent = await fs.realpath(dirname(path));
  if (!isContained(root, parent)) throw unsafePath();
  return join(parent, basename(path));
}

function lifecycleError(code, message, details = {}) {
  return new RoadmapError(code, message, details);
}

function runIdAt(value, createId) {
  const timestamp = new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${createId().replace(/-/g, '').slice(0, 8)}`;
}

function addEvent(run, at, type, itemId = null, details = {}) {
  return [
    ...run.events,
    { sequence: run.events.length + 1, at, type, itemId, details }
  ];
}

function activeAttempt(run, itemId, expectedState = null) {
  if (run.currentItemId !== itemId) {
    throw lifecycleError('ACTIVE_ITEM_MISMATCH', 'the requested item is not active', { itemId });
  }
  const attempts = run.attempts[itemId] ?? [];
  const attempt = attempts.at(-1);
  if (!attempt || (expectedState && attempt.state !== expectedState)) {
    throw lifecycleError('ATTEMPT_STATE_INVALID', 'the active attempt is not in the required state', {
      itemId,
      expectedState,
      actualState: attempt?.state ?? null
    });
  }
  return { attempt, attempts };
}

function replaceLastAttempt(run, itemId, nextAttempt) {
  const attempts = run.attempts[itemId] ?? [];
  return { ...run.attempts, [itemId]: [...attempts.slice(0, -1), nextAttempt] };
}

async function writeExclusiveJson(path, value, fs) {
  await fs.mkdir(dirname(path), { recursive: true });
  const handle = await fs.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(canonicalStringify(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureContainedDirectory(root, directory, fs) {
  const local = relative(root, directory);
  if (!isContained(root, directory) || local === '') return root;
  let current = root;
  for (const segment of local.split(sep)) {
    const candidate = join(current, segment);
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    current = await fs.realpath(candidate);
    if (!isContained(root, current)) throw unsafePath();
  }
  return current;
}

function transactionId(createId) {
  return `tx-${createId()}`;
}

function exactObjectKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export class RoadmapController {
  static async open(root, options = {}) {
    const fs = options.fs ?? fileSystem;
    let absoluteRoot;
    try {
      absoluteRoot = await fs.realpath(resolve(root ?? process.cwd()));
    } catch (error) {
      throw new RoadmapError('UNSAFE_PATH', 'project root is unavailable', { causeCode: error.code });
    }
    const requestedRoadmapPath = resolve(options.roadmapPath ?? join(absoluteRoot, 'docs/roadmap/roadmap.json'));
    let roadmapPath;
    let roadmap;
    try {
      roadmapPath = await realParentPath(absoluteRoot, requestedRoadmapPath, fs);
      const realRoadmapPath = await fs.realpath(roadmapPath);
      if (!isContained(absoluteRoot, realRoadmapPath)) throw unsafePath();
      roadmapPath = realRoadmapPath;
      roadmap = await readJson(roadmapPath, parseRoadmap, { fs });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new RoadmapError('LEGACY_ROADMAP', `canonical roadmap JSON is missing: ${roadmapPath}`, { path: roadmapPath });
      }
      throw error;
    }
    const requestedMarkdownPath = resolve(options.markdownPath ?? join(absoluteRoot, 'docs/roadmap/roadmap.md'));
    const markdownPath = await realParentPath(absoluteRoot, requestedMarkdownPath, fs);
    return new RoadmapController(absoluteRoot, roadmap, { ...options, fs, roadmapPath, markdownPath });
  }

  constructor(root, roadmap, options = {}) {
    this.root = root;
    this.roadmap = roadmap;
    this.run = options.run ?? null;
    this.fs = options.fs ?? fileSystem;
    this.roadmapPath = options.roadmapPath ?? join(root, 'docs/roadmap/roadmap.json');
    this.markdownPath = options.markdownPath ?? join(root, 'docs/roadmap/roadmap.md');
    this.now = options.now ?? (() => Date.now());
    this.createId = options.randomUUID ?? randomUUID;
    this.maxAttemptsPerItem = options.maxAttemptsPerItem ?? 3;
  }

  runPath(runId) {
    return join(this.root, '.ddd/runs', `${runId}.json`);
  }

  lockPath(runId) {
    return join(this.root, '.ddd/locks', `${runId}.lock`);
  }

  activeRunPath() {
    return join(this.root, '.ddd/active-run.json');
  }

  timestamp() {
    return new Date(typeof this.now === 'function' ? this.now() : this.now).toISOString();
  }

  async readSpec(item) {
    const requested = resolve(this.root, item.spec.path);
    const real = await this.fs.realpath(requested);
    if (!isContained(this.root, real)) throw unsafePath();
    const spec = await readJson(real, parseSpec, { fs: this.fs });
    if (spec.id !== item.parentId || spec.status !== 'approved' || sha256(spec) !== item.spec.hash) {
      throw lifecycleError('SPEC_BINDING_STALE', 'approved spec binding is not current', { itemId: item.id });
    }
    const declared = new Set(spec.acceptanceCriteria.map(criterion => criterion.id));
    if (item.spec.acceptanceCriteria.some(id => !declared.has(id))) {
      throw lifecycleError('SPEC_BINDING_STALE', 'item acceptance criteria are not present in the approved spec', { itemId: item.id });
    }
    return spec;
  }

  async validateLifecycleScope(selector) {
    const scope = expandScope(this.roadmap, selector);
    const items = new Map(this.roadmap.nodes.filter(node => node.kind === 'item').map(node => [node.id, node]));
    const specs = new Map();
    for (const itemId of scope) specs.set(itemId, await this.readSpec(items.get(itemId)));
    for (const gate of Object.values(this.roadmap.gates)) {
      if (gate.type === 'command') validateGateCommand(this.root, gate);
    }
    return { scope, items, specs };
  }

  async withRunLock(runId, action) {
    const journalPath = this.runPath(runId);
    const lock = await acquireRunLock(this.lockPath(runId), {
      fs: this.fs,
      runId,
      journalPath,
      journalParser: parseRun,
      randomUUID: this.createId
    });
    try {
      return await action(journalPath);
    } finally {
      await lock.release();
    }
  }

  validate() {
    validateGraph(this.roadmap);
    return { revision: this.roadmap.revision, valid: true };
  }

  scope(selector) {
    return { items: expandScope(this.roadmap, selector) };
  }

  async render() {
    const contents = renderRoadmap(this.roadmap, this.run);
    const markdownPath = await realParentPath(this.root, this.markdownPath, this.fs);
    await writeTextAtomic(markdownPath, contents, this.fs);
    return {
      path: relative(this.root, markdownPath).split('\\').join('/'),
      revision: this.roadmap.revision
    };
  }

  async start(selector, { manifestApproved = false } = {}) {
    try {
      await this.fs.lstat(this.activeRunPath());
      throw lifecycleError('ACTIVE_RUN_CONFLICT', 'an active roadmap run already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const { scope } = await this.validateLifecycleScope(selector);
    const before = await repositoryState(this.root);
    if (!before.clean) throw lifecycleError('DIRTY_WORKTREE', 'a roadmap run requires a clean worktree');
    if (before.branch === null) throw lifecycleError('DETACHED_HEAD', 'a roadmap run requires a branch');

    const runId = runIdAt(typeof this.now === 'function' ? this.now() : this.now, this.createId);
    const prepared = await prepareRunBranch(this.root, runId);
    const runBranch = prepared.branch;
    const at = this.timestamp();
    const run = parseRun({
      schemaVersion: 1,
      revision: 0,
      runId,
      selector,
      scope,
      status: 'active',
      originalBranch: before.branch,
      runBranch,
      baselineSha: before.head,
      manifestAuthorization: {
        mode: manifestApproved ? 'approved' : 'sandboxed',
        hash: gateManifestHash(this.roadmap.gates)
      },
      maxAttemptsPerItem: this.maxAttemptsPerItem,
      currentItemId: null,
      attempts: {},
      events: [{ sequence: 1, at, type: 'run-started', itemId: null, details: {} }],
      pendingTransaction: null
    });

    await this.withRunLock(runId, async journalPath => {
      await writeJsonAtomic(journalPath, run, { fs: this.fs, randomUUID: this.createId });
      try {
        await writeExclusiveJson(this.activeRunPath(), { schemaVersion: 1, runId, journal: `.ddd/runs/${runId}.json` }, this.fs);
      } catch (error) {
        if (error.code === 'EEXIST') throw lifecycleError('ACTIVE_RUN_CONFLICT', 'an active roadmap run already exists');
        throw error;
      }
    });
    return { runId, scope: [...scope], status: 'active', runBranch };
  }

  async next(runId) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      if (run.status !== 'active') throw lifecycleError('RUN_CLOSED', 'the roadmap run is closed');
      if (run.currentItemId !== null) {
        throw lifecycleError('ACTIVE_ITEM_CONFLICT', 'the roadmap run already has an active item', { itemId: run.currentItemId });
      }
      const candidates = readyItems(this.roadmap, run.scope, run);
      if (candidates.length === 0) return { runId, item: null, terminal: true };

      const item = this.roadmap.nodes.find(node => node.id === candidates[0]);
      const spec = await this.readSpec(item);
      const state = await repositoryState(this.root);
      if (!state.clean || state.branch !== run.runBranch) {
        throw lifecycleError('RUN_BRANCH_CONFLICT', 'the run branch is not clean and current');
      }
      const attemptNumber = (run.attempts[item.id]?.length ?? 0) + 1;
      if (attemptNumber > run.maxAttemptsPerItem) {
        throw lifecycleError('ATTEMPT_CAP_REACHED', 'the item attempt budget is exhausted', { itemId: item.id });
      }
      const at = this.timestamp();
      const attempt = {
        number: attemptNumber,
        state: 'in_progress',
        itemBaselineSha: state.head,
        implementationSha: null,
        changedFiles: [],
        acIds: [],
        evidence: {},
        reason: null,
        startedAt: at,
        finishedAt: null
      };
      const updated = await mutateRevision(journalPath, parseRun, run.revision, current => ({
        ...current,
        currentItemId: item.id,
        attempts: { ...current.attempts, [item.id]: [...(current.attempts[item.id] ?? []), attempt] },
        events: addEvent(current, at, 'item-started', item.id, { attempt: attemptNumber })
      }), { fs: this.fs, randomUUID: this.createId });
      return {
        runId,
        attempt: attemptNumber,
        item: { ...item, spec },
        revision: updated.revision
      };
    });
  }

  async record(runId, itemId, { commit, acIds }) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      const { attempt } = activeAttempt(run, itemId, 'in_progress');
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      if (!item || !run.scope.includes(itemId)) throw lifecycleError('ITEM_OUT_OF_SCOPE', 'item is outside the run scope');
      const declared = item.spec.acceptanceCriteria;
      if (!Array.isArray(acIds) || acIds.length === 0 || new Set(acIds).size !== acIds.length
          || acIds.length !== declared.length || acIds.some(id => !declared.includes(id))) {
        throw lifecycleError('AC_COVERAGE_INVALID', 'recorded acceptance criteria must exactly match the item contract');
      }
      await this.readSpec(item);
      if (gateManifestHash(this.roadmap.gates) !== run.manifestAuthorization.hash) {
        throw lifecycleError('MANIFEST_MISMATCH', 'the gate manifest changed after run authorization');
      }
      const implementationSha = await assertImplementationCommit(this.root, {
        baseline: attempt.itemBaselineSha,
        commit,
        runBranch: run.runBranch
      });
      const paths = await changedFiles(this.root, attempt.itemBaselineSha, implementationSha);
      const at = this.timestamp();
      const nextAttempt = {
        ...attempt,
        state: 'verifying',
        implementationSha,
        changedFiles: paths,
        acIds: [...acIds]
      };
      const updated = await mutateRevision(journalPath, parseRun, run.revision, current => ({
        ...current,
        attempts: replaceLastAttempt(current, itemId, nextAttempt),
        events: addEvent(current, at, 'implementation-recorded', itemId, { changedFiles: paths })
      }), { fs: this.fs, randomUUID: this.createId });
      return { runId, itemId, state: 'verifying', implementationSha, changedFiles: paths, revision: updated.revision };
    });
  }

  async evidenceContext(run, item, attempt) {
    const spec = await this.readSpec(item);
    const manifestHash = gateManifestHash(this.roadmap.gates);
    if (manifestHash !== run.manifestAuthorization.hash) {
      throw lifecycleError('MANIFEST_MISMATCH', 'the gate manifest changed after run authorization');
    }
    return {
      bindings: {
        itemBaselineSha: attempt.itemBaselineSha,
        implementationSha: attempt.implementationSha,
        specHash: item.spec.hash,
        manifestHash,
        sharedContractHashes: [...spec.sharedContracts]
      },
      spec
    };
  }

  async verify(runId, itemId) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      const { attempt } = activeAttempt(run, itemId, 'verifying');
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      if (!item || attempt.implementationSha === null) {
        throw lifecycleError('ATTEMPT_STATE_INVALID', 'verification requires a recorded implementation');
      }
      const { bindings } = await this.evidenceContext(run, item, attempt);
      const at = this.timestamp();
      const evidence = {
        ...attempt.evidence,
        spec: {
          gate: 'spec',
          status: 'passed',
          processClass: 'exit',
          exitCode: 0,
          signal: null,
          startedAt: at,
          finishedAt: at,
          durationMs: 0,
          bindings,
          artifacts: [item.spec.path],
          acIds: [...item.spec.acceptanceCriteria],
          stdoutDigest: EMPTY_DIGEST,
          stderrDigest: EMPTY_DIGEST,
          internal: true
        }
      };
      const executed = ['spec'];
      for (const gateName of item.requiredGates) {
        if (gateName === 'spec') continue;
        const gate = this.roadmap.gates[gateName];
        if (gate?.type !== 'command') continue;
        evidence[gateName] = await runGate(this.root, {
          gates: this.roadmap.gates,
          bindings,
          acIds: attempt.acIds,
          evidenceArtifacts: attempt.changedFiles
        }, gateName, gate);
        executed.push(gateName);
      }
      const nextAttempt = { ...attempt, evidence };
      const updated = await mutateRevision(journalPath, parseRun, run.revision, current => ({
        ...current,
        attempts: replaceLastAttempt(current, itemId, nextAttempt),
        events: addEvent(current, this.timestamp(), 'gates-verified', itemId, { gates: executed })
      }), { fs: this.fs, randomUUID: this.createId });
      return { runId, itemId, gates: executed, revision: updated.revision };
    });
  }

  async attest(runId, itemId, gateName, reportPath) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      const { attempt } = activeAttempt(run, itemId, 'verifying');
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      const gate = this.roadmap.gates[gateName];
      if (!item?.requiredGates.includes(gateName) || gate?.type !== 'attestation') {
        throw lifecycleError('ATTESTATION_INVALID', 'the item does not declare this attestation gate');
      }
      const requested = resolve(this.root, reportPath);
      const real = await this.fs.realpath(requested);
      if (!isContained(this.root, real)) throw unsafePath();
      let report;
      try {
        report = JSON.parse(await this.fs.readFile(real, 'utf8'));
      } catch (error) {
        throw lifecycleError('ATTESTATION_INVALID', 'attestation report is not valid JSON', { causeCode: error.code });
      }
      const { bindings } = await this.evidenceContext(run, item, attempt);
      const normalized = validateAttestation({ bindings, gateName }, gate, report);
      const nextAttempt = { ...attempt, evidence: { ...attempt.evidence, [gateName]: normalized } };
      const updated = await mutateRevision(journalPath, parseRun, run.revision, current => ({
        ...current,
        attempts: replaceLastAttempt(current, itemId, nextAttempt),
        events: addEvent(current, this.timestamp(), 'attestation-recorded', itemId, { gate: gateName })
      }), { fs: this.fs, randomUUID: this.createId });
      return { runId, itemId, gate: gateName, status: normalized.status, revision: updated.revision };
    });
  }

  async settleItem(journalPath, run, item, attempt, targetState, reason) {
    const roadmap = await readJson(this.roadmapPath, parseRoadmap, { fs: this.fs });
    const id = transactionId(this.createId);
    const allowedPaths = [
      relative(this.root, this.roadmapPath).split('\\').join('/'),
      relative(this.root, this.markdownPath).split('\\').join('/')
    ];
    const transaction = {
      id,
      type: 'settle-item',
      state: 'prepared',
      expectedRoadmapRevision: roadmap.revision,
      itemId: item.id,
      targetState,
      implementationSha: attempt.implementationSha,
      allowedPaths,
      bookkeepingSha: null
    };
    const prepared = await mutateRevision(journalPath, parseRun, run.revision, current => beginTransaction(current, transaction), {
      fs: this.fs,
      randomUUID: this.createId
    });
    const updatedRoadmap = await mutateRevision(this.roadmapPath, parseRoadmap, roadmap.revision, current => ({
      ...current,
      nodes: current.nodes.map(node => node.id === item.id ? { ...node, status: targetState } : node)
    }), { fs: this.fs, randomUUID: this.createId });
    await writeTextAtomic(this.markdownPath, renderRoadmap(updatedRoadmap, { ...prepared, currentItemId: null }), this.fs);
    const bookkeepingSha = await commitGenerated(this.root, {
      paths: allowedPaths,
      message: `chore(roadmapctl): settle ${item.id} as ${targetState}`
    });

    const finishedAt = this.timestamp();
    const settledAttempt = { ...attempt, state: targetState, reason, finishedAt };
    const withSha = parseRun({
      ...prepared,
      pendingTransaction: { ...prepared.pendingTransaction, bookkeepingSha }
    });
    const committed = commitTransaction(withSha, id);
    const finalized = await mutateRevision(journalPath, parseRun, prepared.revision, () => ({
      ...committed,
      currentItemId: null,
      attempts: replaceLastAttempt(committed, item.id, settledAttempt),
      events: addEvent(committed, finishedAt, 'item-settled', item.id, { state: targetState })
    }), { fs: this.fs, randomUUID: this.createId });
    this.roadmap = updatedRoadmap;
    return { finalized, roadmap: updatedRoadmap, bookkeepingSha };
  }

  async finish(runId, itemId) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      const { attempt } = activeAttempt(run, itemId, 'verifying');
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      if (!item) throw lifecycleError('ITEM_OUT_OF_SCOPE', 'item is outside the run scope');
      const { bindings } = await this.evidenceContext(run, item, attempt);
      const repository = await repositoryState(this.root);
      const decision = evaluateCompletion({
        item,
        evidence: attempt.evidence,
        bindings: {
          ...bindings,
          hasUnrecordedRelevantChanges: !repository.clean || repository.head !== attempt.implementationSha
        }
      });
      const state = decision.accepted ? 'done' : decision.state;
      const reason = decision.accepted ? null : decision.reasons[0];
      const { finalized, bookkeepingSha } = await this.settleItem(journalPath, run, item, attempt, state, reason);
      return {
        runId,
        itemId,
        state,
        reasons: decision.accepted ? [] : decision.reasons,
        bookkeepingSha,
        revision: finalized.revision
      };
    });
  }

  async resolveRunId(runId) {
    if (runId !== null) return runId;
    let pointer;
    try {
      pointer = JSON.parse(await this.fs.readFile(this.activeRunPath(), 'utf8'));
    } catch (error) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer is missing or corrupt', { causeCode: error.code });
    }
    if (!exactObjectKeys(pointer, ['schemaVersion', 'runId', 'journal'])
        || pointer.schemaVersion !== 1 || typeof pointer.runId !== 'string'
        || pointer.journal !== `.ddd/runs/${pointer.runId}.json`) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer is invalid');
    }
    try {
      const run = await readJson(this.runPath(pointer.runId), parseRun, { fs: this.fs });
      if (run.status !== 'active') throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer references a closed run');
    } catch (error) {
      if (error instanceof RoadmapError && error.code === 'ACTIVE_POINTER_STALE') throw error;
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer references no valid journal', { causeCode: error.code });
    }
    return pointer.runId;
  }

  statusSnapshot(run) {
    const leaves = {};
    const blockers = {};
    const attemptsRemaining = {};
    for (const itemId of run.scope) {
      leaves[itemId] = deriveAggregate(this.roadmap, itemId, run);
      const itemBlockers = blockersFor(this.roadmap, itemId);
      if (itemBlockers.length > 0) blockers[itemId] = itemBlockers;
      attemptsRemaining[itemId] = Math.max(0, run.maxAttemptsPerItem - (run.attempts[itemId]?.length ?? 0));
    }
    const aggregateIds = new Set();
    for (const itemId of run.scope) {
      let node = this.roadmap.nodes.find(candidate => candidate.id === itemId);
      while (node?.parentId) {
        aggregateIds.add(node.parentId);
        node = this.roadmap.nodes.find(candidate => candidate.id === node.parentId);
      }
    }
    const aggregates = Object.fromEntries([...aggregateIds].sort().map(id => [id, deriveAggregate(this.roadmap, id, run)]));
    const remaining = run.scope.filter(id => leaves[id] !== 'done');
    let action = 'closed';
    if (run.status === 'active') {
      if (run.currentItemId !== null) {
        const attempt = run.attempts[run.currentItemId].at(-1);
        action = attempt.state === 'in_progress' ? 'record' : 'finish';
      } else {
        action = readyItems(this.roadmap, run.scope, run).length > 0 ? 'next' : 'close';
      }
    }
    return {
      runId: run.runId,
      status: run.status,
      activeItemId: run.currentItemId,
      leaves,
      aggregates,
      remaining,
      blockers,
      attemptsRemaining,
      action
    };
  }

  async status(runId) {
    const resolved = await this.resolveRunId(runId);
    const run = await readJson(this.runPath(resolved), parseRun, { fs: this.fs });
    return this.statusSnapshot(run);
  }

  async resume(runId) {
    const resolved = await this.resolveRunId(runId);
    return this.withRunLock(resolved, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      return this.statusSnapshot(run);
    });
  }

  async retry(runId, itemId, reasonText) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      if (run.status !== 'active' || run.currentItemId !== null) {
        throw lifecycleError('RETRY_INVALID', 'retry requires an active run with no active item');
      }
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      if (!item || !run.scope.includes(itemId) || !['blocked', 'failed'].includes(item.status)) {
        throw lifecycleError('RETRY_INVALID', 'only a blocked or failed scoped item can be retried');
      }
      const previous = run.attempts[itemId] ?? [];
      if (previous.length >= run.maxAttemptsPerItem) {
        throw lifecycleError('ATTEMPT_CAP_REACHED', 'the item attempt budget is exhausted');
      }
      if (typeof reasonText !== 'string' || reasonText.trim().length === 0) {
        throw lifecycleError('RETRY_INVALID', 'retry requires a non-empty reason');
      }
      const repository = await repositoryState(this.root);
      if (!repository.clean || repository.branch !== run.runBranch) {
        throw lifecycleError('RUN_BRANCH_CONFLICT', 'the run branch is not clean and current');
      }
      const at = this.timestamp();
      const attempt = {
        number: previous.length + 1,
        state: 'in_progress',
        itemBaselineSha: repository.head,
        implementationSha: null,
        changedFiles: [],
        acIds: [],
        evidence: {},
        reason: null,
        startedAt: at,
        finishedAt: null
      };
      const updated = await mutateRevision(journalPath, parseRun, run.revision, current => ({
        ...current,
        currentItemId: itemId,
        attempts: { ...current.attempts, [itemId]: [...previous, attempt] },
        events: addEvent(current, at, 'item-retried', itemId, { reason: reasonText.trim(), attempt: attempt.number })
      }), { fs: this.fs, randomUUID: this.createId });
      return { runId, itemId, attempt: attempt.number, state: 'in_progress', revision: updated.revision };
    });
  }

  runOutcome(run) {
    const items = run.scope.map(id => this.roadmap.nodes.find(node => node.id === id));
    if (items.every(item => item.status === 'done')) return 'successful';
    if (items.some(item => item.status !== 'done' && (run.attempts[item.id]?.length ?? 0) >= run.maxAttemptsPerItem)) return 'capped';
    if (items.some(item => item.status === 'failed')) return 'failed';
    if (items.some(item => item.status === 'blocked')) return 'blocked';
    if (items.some(item => item.status === 'cancelled')) return 'cancelled';
    return 'blocked';
  }

  async clearActivePointer(runId) {
    const diagnostic = `${this.activeRunPath()}.closed-${this.createId()}`;
    try {
      await this.fs.rename(this.activeRunPath(), diagnostic);
    } catch (error) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer could not be cleared', { causeCode: error.code });
    }
    let pointer;
    try {
      pointer = JSON.parse(await this.fs.readFile(diagnostic, 'utf8'));
    } catch (error) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the moved active-run pointer is corrupt', { causeCode: error.code });
    }
    if (pointer.runId !== runId) throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer changed during close');
  }

  async close(runId, { requireSuccess = false } = {}) {
    return this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      if (run.status !== 'active') throw lifecycleError('RUN_CLOSED', 'the roadmap run is already closed');
      if (run.currentItemId !== null) throw lifecycleError('ACTIVE_ITEM_CONFLICT', 'an active item must settle before close');
      const outcome = this.runOutcome(run);
      if (requireSuccess && outcome !== 'successful') {
        throw lifecycleError('RUN_NOT_SUCCESSFUL', 'the run still contains incomplete items', {
          remaining: run.scope.filter(id => this.roadmap.nodes.find(node => node.id === id).status !== 'done')
        });
      }
      const reportPath = join(this.root, 'docs/roadmap/runs', runId, 'report.json');
      await ensureContainedDirectory(this.root, dirname(reportPath), this.fs);
      const relativeReport = relative(this.root, reportPath).split('\\').join('/');
      const relativeMarkdown = relative(this.root, this.markdownPath).split('\\').join('/');
      const id = transactionId(this.createId);
      const transaction = {
        id,
        type: 'close-run',
        state: 'prepared',
        expectedRoadmapRevision: this.roadmap.revision,
        itemId: null,
        targetState: null,
        implementationSha: null,
        allowedPaths: [relativeMarkdown, relativeReport],
        bookkeepingSha: null
      };
      const prepared = await mutateRevision(journalPath, parseRun, run.revision, current => beginTransaction(current, transaction), {
        fs: this.fs,
        randomUUID: this.createId
      });
      const closingRun = { ...prepared, status: outcome };
      const report = buildRunReport(this.roadmap, closingRun);
      await writeImmutableReport(reportPath, report, { fs: this.fs, randomUUID: this.createId });
      await writeTextAtomic(this.markdownPath, renderRoadmap(this.roadmap, closingRun), this.fs);
      const bookkeepingSha = await commitGenerated(this.root, {
        paths: [relativeMarkdown, relativeReport],
        message: `chore(roadmapctl): close ${runId} as ${outcome}`
      });
      const withSha = parseRun({
        ...prepared,
        pendingTransaction: { ...prepared.pendingTransaction, bookkeepingSha }
      });
      const committed = commitTransaction(withSha, id);
      const at = this.timestamp();
      const finalized = await mutateRevision(journalPath, parseRun, prepared.revision, () => ({
        ...committed,
        status: outcome,
        events: addEvent(committed, at, 'run-closed', null, { status: outcome })
      }), { fs: this.fs, randomUUID: this.createId });
      await this.clearActivePointer(runId);
      return { runId, status: outcome, report: relativeReport, bookkeepingSha, revision: finalized.revision };
    });
  }

  async abort(runId, { confirmed = false } = {}) {
    if (!confirmed) throw lifecycleError('ABORT_CONFIRMATION_REQUIRED', 'abort requires explicit confirmation');
    await this.withRunLock(runId, async journalPath => {
      const run = await readJson(journalPath, parseRun, { fs: this.fs });
      if (run.status !== 'active' || run.currentItemId === null) {
        throw lifecycleError('ABORT_INVALID', 'abort requires one active item');
      }
      const itemId = run.currentItemId;
      const { attempt } = activeAttempt(run, itemId);
      const item = this.roadmap.nodes.find(node => node.id === itemId);
      const reason = { code: 'USER_ABORTED', message: 'the user cancelled the active attempt', details: {} };
      await this.settleItem(journalPath, run, item, attempt, 'cancelled', reason);
    });
    return this.close(runId);
  }
}
