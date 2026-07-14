import { createHash, randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalStringify, sha256 } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';
import { assertImplementationCommit, changedFiles, prepareRunBranch, repositoryState } from './git.mjs';
import { validateGraph } from './graph.mjs';
import { acquireRunLock } from './lock.mjs';
import { renderRoadmap } from './render.mjs';
import { parseRoadmap, parseRun, parseSpec } from './schema.mjs';
import { expandScope } from './scope.mjs';
import { readyItems } from './state.mjs';
import { mutateRevision, readJson, writeJsonAtomic } from './store.mjs';
import { gateManifestHash, runGate, validateAttestation, validateGateCommand } from './verify.mjs';

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
}
