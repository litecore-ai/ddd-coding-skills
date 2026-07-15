import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalStringify, sha256Bytes, specHash } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';
import {
  assertGeneratedWorktree,
  assertImplementationCommit,
  changedFiles,
  commitGenerated,
  git,
  prepareRunBranch,
  repositoryState
} from './git.mjs';
import { blockersFor, validateGraph } from './graph.mjs';
import { acquireRunLock } from './lock.mjs';
import { buildRunReport, renderRoadmap, renderSpec, writeImmutableReport } from './render.mjs';
import { parseReport, parseRoadmap, parseRun, parseSpec } from './schema.mjs';
import { expandScope } from './scope.mjs';
import { deriveAggregate, readyItems } from './state.mjs';
import {
  beginTransaction,
  commitTransaction,
  mutateRevision,
  mutateRevisionRegular,
  readJson,
  readJsonRegular,
  writeJsonAtomic
} from './store.mjs';
import { evaluateCompletion, gateManifestHash, runGate, validateAttestation, validateGateCommand } from './verify.mjs';

const EMPTY_DIGEST = `sha256:${createHash('sha256').update('').digest('hex')}`;
const LIFECYCLE_RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

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

async function readContainedRegular(root, path, fs) {
  if (!isContained(root, path)) throw unsafePath();
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error.code)) throw unsafePath();
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw unsafePath();
    const before = await fs.lstat(path, { bigint: true });
    const real = await fs.realpath(path);
    if (!isContained(root, real) || !before.isFile() || before.isSymbolicLink()
        || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw unsafePath();
    }
    const contents = await handle.readFile();
    const after = await fs.lstat(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw unsafePath();
    }
    return { contents, real };
  } finally {
    await handle.close();
  }
}

function canonicalProjectPath(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\\') || isAbsolute(candidate)) {
    throw unsafePath();
  }
  const absolute = resolve(root, candidate);
  if (!isContained(root, absolute)) throw unsafePath();
  const local = relative(root, absolute).split(sep).join('/');
  if (local !== candidate || local === '' || local.split('/').some(segment => segment === '.' || segment === '..')) {
    throw unsafePath();
  }
  return { absolute, local };
}

async function containedWritePath(root, path, fs) {
  const safe = await realParentPath(root, path, fs);
  if (resolve(safe) !== resolve(path)) throw unsafePath();
  return safe;
}

async function snapshotControllerFiles(root, paths, fs) {
  const snapshots = [];
  for (const path of paths) {
    try {
      const { contents } = await readContainedRegular(root, path, fs);
      snapshots.push({ path, exists: true, contents });
    } catch (error) {
      if (error.code === 'ENOENT') snapshots.push({ path, exists: false, contents: null });
      else throw error;
    }
  }
  return snapshots;
}

async function restoreControllerFiles(root, snapshots, fs) {
  for (const snapshot of snapshots) {
    const safe = await containedWritePath(root, snapshot.path, fs);
    if (snapshot.exists) await writeTextAtomic(safe, snapshot.contents, fs);
    else await fs.rm(safe, { force: true });
  }
}

function lifecycleError(code, message, details = {}) {
  return new RoadmapError(code, message, details);
}

function coverageForItems(items, spec) {
  const coverage = new Map(items.map(item => [item.id, []]));
  for (const criterion of spec.acceptanceCriteria) {
    for (const itemId of criterion.covers) {
      const acceptanceCriteria = coverage.get(itemId);
      if (!acceptanceCriteria) {
        throw lifecycleError('SPEC_COVERAGE_INVALID', 'criterion covers an item outside the feature', {
          criterionId: criterion.id,
          itemId
        });
      }
      acceptanceCriteria.push(criterion.id);
    }
  }
  for (const item of items) {
    if (coverage.get(item.id).length === 0) {
      throw lifecycleError('SPEC_COVERAGE_INVALID', 'every feature item requires explicit criterion coverage', {
        itemId: item.id
      });
    }
    if (item.consumers.some(consumer => !spec.consumers.includes(consumer))) {
      throw lifecycleError('SPEC_COVERAGE_INVALID', 'roadmap consumers must be declared by the spec', {
        itemId: item.id
      });
    }
  }
  return coverage;
}

function assertLifecycleRunId(runId) {
  if (typeof runId !== 'string' || !LIFECYCLE_RUN_ID.test(runId)) {
    throw lifecycleError('RUN_ID_INVALID', 'run id does not match the controller-issued format');
  }
  return runId;
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

function parseActivePointer(pointer) {
  if (!exactObjectKeys(pointer, ['schemaVersion', 'runId', 'journal'])
      || pointer.schemaVersion !== 1 || typeof pointer.runId !== 'string'
      || !LIFECYCLE_RUN_ID.test(pointer.runId)
      || pointer.journal !== `.ddd/runs/${pointer.runId}.json`) {
    throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer is invalid');
  }
  return Object.freeze({ ...pointer });
}

function expectedRunHead(run) {
  return run.pendingTransaction?.state === 'committed' && run.pendingTransaction.bookkeepingSha
    ? run.pendingTransaction.bookkeepingSha
    : run.baselineSha;
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
    this.stateRoot = null;
  }

  runPath(runId) {
    if (!this.stateRoot) throw lifecycleError('STATE_ROOT_INVALID', 'controller state root is not initialized');
    return join(this.stateRoot, 'runs', `${assertLifecycleRunId(runId)}.json`);
  }

  lockPath(runId) {
    if (!this.stateRoot) throw lifecycleError('STATE_ROOT_INVALID', 'controller state root is not initialized');
    return join(this.stateRoot, 'locks', `${assertLifecycleRunId(runId)}.lock`);
  }

  activeRunPath() {
    if (!this.stateRoot) throw lifecycleError('STATE_ROOT_INVALID', 'controller state root is not initialized');
    return join(this.stateRoot, 'active-run.json');
  }

  async ensureStateRoot() {
    if (!this.stateRoot) {
      this.stateRoot = await ensureContainedDirectory(this.root, join(this.root, '.ddd'), this.fs);
    }
    await ensureContainedDirectory(this.root, join(this.stateRoot, 'runs'), this.fs);
    await ensureContainedDirectory(this.root, join(this.stateRoot, 'locks'), this.fs);
    return this.stateRoot;
  }

  async activeJournals() {
    await this.ensureStateRoot();
    const directory = join(this.stateRoot, 'runs');
    const active = [];
    for (const name of await this.fs.readdir(directory)) {
      const match = /^(\d{8}T\d{6}Z-[0-9a-f]{8})\.json$/.exec(name);
      if (!match) continue;
      const path = join(directory, name);
      const metadata = await this.fs.lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw lifecycleError('STATE_PATH_UNSAFE', 'run journal is not a regular file');
      const run = await readJsonRegular(path, parseRun, { fs: this.fs });
      if (run.runId !== match[1]) throw lifecycleError('STATE_CORRUPT', 'run journal file name and run id differ');
      if (run.status === 'active') active.push(run.runId);
    }
    return active.sort();
  }

  async readActivePointer(path = this.activeRunPath()) {
    return readJsonRegular(path, parseActivePointer, { fs: this.fs });
  }

  timestamp() {
    return new Date(typeof this.now === 'function' ? this.now() : this.now).toISOString();
  }

  async readSpec(item) {
    const { absolute } = canonicalProjectPath(this.root, item.spec.path);
    let contents;
    try {
      ({ contents } = await readContainedRegular(this.root, absolute, this.fs));
    } catch (error) {
      if (error instanceof RoadmapError) throw error;
      throw lifecycleError('SPEC_BINDING_STALE', 'bound spec is unavailable', {
        itemId: item.id,
        causeCode: error.code
      });
    }
    let spec;
    try {
      spec = parseSpec(JSON.parse(contents.toString('utf8')));
    } catch (error) {
      if (error instanceof RoadmapError) throw error;
      throw lifecycleError('SPEC_INVALID', 'spec is not valid JSON', { itemId: item.id });
    }
    if (spec.id !== item.parentId || spec.status !== 'approved' || specHash(spec) !== item.spec.hash) {
      throw lifecycleError('SPEC_BINDING_STALE', 'approved spec binding is not current', { itemId: item.id });
    }
    const featureItems = this.roadmap.nodes.filter(node => node.kind === 'item' && node.parentId === spec.id);
    const featureItemIds = new Set(featureItems.map(node => node.id));
    const coverage = new Map(featureItems.map(node => [node.id, []]));
    for (const criterion of spec.acceptanceCriteria) {
      for (const coveredId of criterion.covers) {
        if (!featureItemIds.has(coveredId)) {
          throw lifecycleError('SPEC_BINDING_STALE', 'spec criterion covers an item outside its feature', {
            criterionId: criterion.id,
            itemId: coveredId
          });
        }
        coverage.get(coveredId).push(criterion.id);
      }
    }
    for (const featureItem of featureItems) {
      const expected = coverage.get(featureItem.id).sort();
      const actual = [...featureItem.spec.acceptanceCriteria].sort();
      if (expected.length === 0 || featureItem.spec.path !== item.spec.path
          || featureItem.spec.hash !== item.spec.hash
          || expected.length !== actual.length
          || expected.some((criterionId, index) => criterionId !== actual[index])
          || featureItem.consumers.some(consumer => !spec.consumers.includes(consumer))) {
        throw lifecycleError('SPEC_BINDING_STALE', 'feature item bindings do not exactly match spec coverage', {
          itemId: featureItem.id
        });
      }
    }
    await this.validateSharedContracts(spec);
    return spec;
  }

  async validateSharedContracts(spec) {
    for (const reference of spec.sharedContracts) {
      const { absolute } = canonicalProjectPath(this.root, reference.path);
      let file;
      try {
        file = await readContainedRegular(this.root, absolute, this.fs);
      } catch (error) {
        if (error instanceof RoadmapError) throw error;
        throw lifecycleError('SHARED_CONTRACT_STALE', 'a referenced shared contract is unavailable', {
          path: reference.path,
          causeCode: error.code
        });
      }
      if (sha256Bytes(file.contents) !== reference.hash) {
        throw lifecycleError('SHARED_CONTRACT_STALE', 'a referenced shared contract hash changed', {
          path: reference.path
        });
      }
    }
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
    await this.ensureStateRoot();
    assertLifecycleRunId(runId);
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

  async withActivePointerLock(action) {
    await this.ensureStateRoot();
    const lock = await acquireRunLock(join(this.stateRoot, 'locks', 'active-run.lock'), {
      fs: this.fs,
      runId: 'active-run',
      validateJournal: () => true,
      randomUUID: this.createId
    });
    try {
      return await action();
    } finally {
      await lock.release();
    }
  }

  async assertRunRepository(run, expectedHead = expectedRunHead(run)) {
    const state = await repositoryState(this.root);
    if (!state.clean || state.branch !== run.runBranch || state.head !== expectedHead) {
      throw lifecycleError('RUN_BRANCH_CONFLICT', 'the run branch, HEAD, and worktree must match recorded state');
    }
    return state;
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

  async hashFile(path) {
    const requested = canonicalProjectPath(this.root, path);
    let file;
    try {
      file = await readContainedRegular(this.root, requested.absolute, this.fs);
    } catch (error) {
      if (error instanceof RoadmapError) throw error;
      throw lifecycleError('SHARED_CONTRACT_INVALID', 'shared contract is unavailable', {
        path: requested.local,
        causeCode: error.code
      });
    }
    return { path: requested.local, hash: sha256Bytes(file.contents) };
  }

  async bindSpec(featureId, specPath) {
    const feature = this.roadmap.nodes.find(node => node.id === featureId);
    if (!feature || feature.kind !== 'feature') {
      throw lifecycleError('SPEC_BINDING_INVALID', 'bind-spec requires a feature id');
    }
    const items = this.roadmap.nodes.filter(node => node.kind === 'item' && node.parentId === featureId);
    if (items.length === 0) throw lifecycleError('SPEC_BINDING_INVALID', 'feature has no executable items');
    const requested = canonicalProjectPath(this.root, specPath);
    const expectedSpecPath = new RegExp(`^docs/specs/${featureId.replaceAll('.', '\\.')}-[a-z0-9]+(?:-[a-z0-9]+)*\\.json$`);
    if (!expectedSpecPath.test(requested.local)) {
      throw lifecycleError('SPEC_BINDING_INVALID', 'spec path must be docs/specs/<feature-id>-<slug>.json');
    }

    return this.withActivePointerLock(async () => {
      if ((await this.activeJournals()).length > 0) {
        throw lifecycleError('ACTIVE_RUN_CONFLICT', 'spec binding is forbidden while a roadmap run is active');
      }
      let spec;
      try {
        const { contents } = await readContainedRegular(this.root, requested.absolute, this.fs);
        spec = parseSpec(JSON.parse(contents.toString('utf8')));
      } catch (error) {
        if (error instanceof RoadmapError) throw error;
        throw lifecycleError('SPEC_INVALID', 'spec is not valid JSON', { causeCode: error.code });
      }
      if (spec.id !== featureId || spec.status !== 'approved') {
        throw lifecycleError('SPEC_BINDING_INVALID', 'spec id and approved status must match the feature');
      }
      await this.validateSharedContracts(spec);
      const coverage = coverageForItems(items, spec);
      const specMarkdownPath = requested.absolute.replace(/\.json$/, '.md');
      const specMarkdown = requested.local.replace(/\.json$/, '.md');
      const roadmapLocal = relative(this.root, this.roadmapPath).split(sep).join('/');
      const markdownLocal = relative(this.root, this.markdownPath).split(sep).join('/');
      const allowedPaths = [
        requested.local,
        specMarkdown,
        roadmapLocal,
        markdownLocal
      ];
      let preflight;
      try {
        preflight = await assertGeneratedWorktree(this.root, allowedPaths);
      } catch (error) {
        throw lifecycleError('SPEC_BINDING_CONFLICT', 'spec binding requires no unrelated worktree changes', {
          causeCode: error.code
        });
      }
      const currentRoadmapSource = await this.fs.readFile(this.roadmapPath, 'utf8');
      let headRoadmapSource;
      try {
        headRoadmapSource = (await git(this.root, ['show', `HEAD:${roadmapLocal}`])).stdout;
      } catch (error) {
        throw lifecycleError('SPEC_BINDING_CONFLICT', 'canonical roadmap must already exist at HEAD', {
          causeCode: error.code
        });
      }
      if (currentRoadmapSource !== headRoadmapSource) {
        throw lifecycleError('SPEC_BINDING_CONFLICT', 'canonical roadmap must match HEAD before spec binding');
      }
      const hash = specHash(spec);
      const roadmap = await readJson(this.roadmapPath, parseRoadmap, { fs: this.fs });
      if (roadmap.revision !== this.roadmap.revision) {
        throw lifecycleError('REVISION_CONFLICT', 'roadmap changed before spec binding');
      }
      const absolutePaths = [requested.absolute, specMarkdownPath, this.roadmapPath, this.markdownPath];
      const snapshots = await snapshotControllerFiles(this.root, absolutePaths, this.fs);
      let updatedRoadmap;
      let bookkeepingSha;
      try {
        const safeRoadmapPath = await containedWritePath(this.root, this.roadmapPath, this.fs);
        updatedRoadmap = await mutateRevision(safeRoadmapPath, parseRoadmap, roadmap.revision, current => ({
          ...current,
          nodes: current.nodes.map(node => coverage.has(node.id) ? {
            ...node,
            spec: {
              path: requested.local,
              hash,
              acceptanceCriteria: [...coverage.get(node.id)].sort()
            },
            status: 'planned'
          } : node)
        }), { fs: this.fs, randomUUID: this.createId });

        await writeTextAtomic(await containedWritePath(this.root, requested.absolute, this.fs), canonicalStringify(spec), this.fs);
        await writeTextAtomic(await containedWritePath(this.root, specMarkdownPath, this.fs), renderSpec(spec), this.fs);
        await writeTextAtomic(
          await containedWritePath(this.root, this.markdownPath, this.fs),
          renderRoadmap(updatedRoadmap, null),
          this.fs
        );
        bookkeepingSha = await commitGenerated(this.root, {
          paths: allowedPaths,
          message: `chore(roadmapctl): bind spec ${featureId}`
        });
      } catch (error) {
        let currentHead = null;
        try {
          currentHead = (await repositoryState(this.root)).head;
          if (currentHead !== preflight.state.head) {
            throw lifecycleError('SPEC_BINDING_RECOVERY_REQUIRED', 'binding commit advanced HEAD before failure', {
              causeCode: error.code,
              head: currentHead
            });
          }
          const staged = (await git(this.root, [
            '--literal-pathspecs', 'diff', '--cached', '--name-only', '-z', '--'
          ])).stdout.split('\0').filter(Boolean);
          if (staged.length > 0) {
            await git(this.root, ['--literal-pathspecs', 'restore', '--staged', '--', ...staged]);
          }
          await restoreControllerFiles(this.root, snapshots, this.fs);
          this.roadmap = roadmap;
        } catch (recoveryError) {
          if (recoveryError instanceof RoadmapError && recoveryError.code === 'SPEC_BINDING_RECOVERY_REQUIRED') {
            throw recoveryError;
          }
          throw lifecycleError('SPEC_BINDING_RECOVERY_REQUIRED', 'spec binding rollback failed', {
            causeCode: recoveryError.code,
            originalCauseCode: error.code
          });
        }
        throw lifecycleError('SPEC_BINDING_TRANSACTION_FAILED', 'spec binding failed and was rolled back', {
          causeCode: error.code
        });
      }
      this.roadmap = updatedRoadmap;
      return {
        featureId,
        specHash: hash,
        items: Object.fromEntries(items.map(item => [item.id, {
          acceptanceCriteria: [...coverage.get(item.id)].sort()
        }])),
        bookkeepingSha,
        revision: updatedRoadmap.revision
      };
    });
  }

  async start(selector, { manifestApproved = false, sandboxed = false } = {}) {
    if (manifestApproved === sandboxed) {
      throw lifecycleError('MANIFEST_AUTHORIZATION_REQUIRED', 'start requires exactly one authorization mode');
    }
    await this.ensureStateRoot();
    const startLock = await acquireRunLock(join(this.stateRoot, 'locks', 'active-run.lock'), {
      fs: this.fs,
      runId: 'active-run',
      validateJournal: () => true,
      randomUUID: this.createId
    });
    try {
      let existingPointer = null;
      try {
        existingPointer = await this.readActivePointer();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existingPointer) {
        const pointedRun = await readJsonRegular(this.runPath(existingPointer.runId), parseRun, { fs: this.fs });
        if (pointedRun.status === 'active') {
          throw lifecycleError('ACTIVE_RUN_CONFLICT', 'an active roadmap run already exists');
        }
        await this.clearActivePointer(existingPointer.runId, { activeLockHeld: true });
      }
      if ((await this.activeJournals()).length > 0) {
        throw lifecycleError('ACTIVE_RUN_CONFLICT', 'an active roadmap journal already exists');
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
    } finally {
      await startLock.release();
    }
  }

  async next(runId) {
    return this.withRunLock(runId, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
      if (run.status !== 'active') throw lifecycleError('RUN_CLOSED', 'the roadmap run is closed');
      if (run.currentItemId !== null) {
        throw lifecycleError('ACTIVE_ITEM_CONFLICT', 'the roadmap run already has an active item', { itemId: run.currentItemId });
      }
      const candidates = readyItems(this.roadmap, run.scope, run);
      if (candidates.length === 0) {
        const status = this.statusSnapshot(run);
        return {
          runId,
          item: null,
          terminal: true,
          action: status.action,
          blockers: status.blockers,
          remaining: status.remaining,
          outcome: this.runOutcome(run)
        };
      }

      const item = this.roadmap.nodes.find(node => node.id === candidates[0]);
      const spec = await this.readSpec(item);
      const state = await this.assertRunRepository(run);
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
      const updated = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => ({
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
      const run = await this.readRunRecovering(journalPath);
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
      const updated = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => ({
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
        sharedContractHashes: spec.sharedContracts.map(reference => reference.hash)
      },
      spec
    };
  }

  async verify(runId, itemId) {
    return this.withRunLock(runId, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
      const { attempt } = activeAttempt(run, itemId, 'verifying');
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      if (!item || attempt.implementationSha === null) {
        throw lifecycleError('ATTEMPT_STATE_INVALID', 'verification requires a recorded implementation');
      }
      const { bindings } = await this.evidenceContext(run, item, attempt);
      await this.assertRunRepository(run, attempt.implementationSha);
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
      await this.assertRunRepository(run, attempt.implementationSha);
      const nextAttempt = { ...attempt, evidence };
      const updated = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => ({
        ...current,
        attempts: replaceLastAttempt(current, itemId, nextAttempt),
        events: addEvent(current, this.timestamp(), 'gates-verified', itemId, { gates: executed })
      }), { fs: this.fs, randomUUID: this.createId });
      return { runId, itemId, gates: executed, revision: updated.revision };
    });
  }

  async attest(runId, itemId, gateName, reportPath) {
    return this.withRunLock(runId, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
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
      await this.assertRunRepository(run, attempt.implementationSha);
      const normalized = validateAttestation({ bindings, gateName }, gate, report);
      const nextAttempt = { ...attempt, evidence: { ...attempt.evidence, [gateName]: normalized } };
      const updated = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => ({
        ...current,
        attempts: replaceLastAttempt(current, itemId, nextAttempt),
        events: addEvent(current, this.timestamp(), 'attestation-recorded', itemId, { gate: gateName })
      }), { fs: this.fs, randomUUID: this.createId });
      return { runId, itemId, gate: gateName, status: normalized.status, revision: updated.revision };
    });
  }

  assertTransactionPaths(transaction, expectedPaths) {
    if (transaction.allowedPaths.length !== expectedPaths.length
        || transaction.allowedPaths.some((path, index) => path !== expectedPaths[index])) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'prepared transaction paths do not match controller-owned paths');
    }
  }

  async controllerCommitAtHead(run, transaction, subject) {
    const state = await repositoryState(this.root);
    if (state.branch !== run.runBranch) {
      throw lifecycleError('RUN_BRANCH_CONFLICT', 'prepared transaction is not on its run branch');
    }
    const expectedParent = transaction.implementationSha;
    if (expectedParent === null) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'prepared transaction has no exact Git parent');
    }
    if (state.head === expectedParent) return null;
    if (!state.clean) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'prepared transaction diverged from its exact Git parent');
    }
    const actualSubject = (await git(this.root, ['show', '-s', '--format=%s', state.head])).stdout.trim();
    const actualParents = (await git(this.root, ['show', '-s', '--format=%P', state.head])).stdout.trim();
    if (actualSubject !== subject || actualParents !== expectedParent) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'prepared transaction head is not the exact controller commit');
    }
    const paths = await changedFiles(this.root, expectedParent, state.head);
    const allowed = new Set(transaction.allowedPaths);
    if (paths.length === 0 || paths.some(path => !allowed.has(path))) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'prepared transaction head changes paths outside its allowlist');
    }
    return state.head;
  }

  async roadmapAtCommit(commit) {
    const roadmapPath = relative(this.root, this.roadmapPath).split('\\').join('/');
    try {
      const source = (await git(this.root, ['show', `${commit}:${roadmapPath}`])).stdout;
      return { roadmap: parseRoadmap(JSON.parse(source)), source };
    } catch (error) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'prepared transaction cannot reconstruct its exact roadmap parent', {
        causeCode: error.code
      });
    }
  }

  async recoverPrepared(journalPath, run) {
    const transaction = run.pendingTransaction;
    if (!transaction || transaction.state !== 'prepared') return run;

    if (transaction.type === 'settle-item') {
      const { roadmap: baseRoadmap, source: baseRoadmapSource } = await this.roadmapAtCommit(transaction.implementationSha);
      const item = baseRoadmap.nodes.find(node => node.id === transaction.itemId && node.kind === 'item');
      if (!item) throw lifecycleError('TRANSACTION_CONFLICT', 'prepared settlement item no longer exists');
      const expectedPaths = [
        relative(this.root, this.roadmapPath).split('\\').join('/'),
        relative(this.root, this.markdownPath).split('\\').join('/')
      ];
      this.assertTransactionPaths(transaction, expectedPaths);
      const subject = `chore(roadmapctl): settle ${item.id} as ${transaction.targetState}`;
      await this.controllerCommitAtHead(run, transaction, subject);
      if (baseRoadmap.revision !== transaction.expectedRoadmapRevision) {
        throw lifecycleError('TRANSACTION_CONFLICT', 'prepared settlement parent has the wrong roadmap revision');
      }
      const roadmap = parseRoadmap({
        ...baseRoadmap,
        revision: baseRoadmap.revision + 1,
        nodes: baseRoadmap.nodes.map(node => node.id === item.id
          ? { ...node, status: transaction.targetState }
          : node)
      });
      const currentSource = await this.fs.readFile(this.roadmapPath, 'utf8');
      parseRoadmap(JSON.parse(currentSource));
      if (currentSource !== baseRoadmapSource
          && currentSource !== canonicalStringify(roadmap)) {
        throw lifecycleError('TRANSACTION_CONFLICT', 'roadmap differs from both exact prepared transaction states');
      }
      await writeJsonAtomic(this.roadmapPath, roadmap, { fs: this.fs, randomUUID: this.createId });
      this.roadmap = roadmap;
      await writeTextAtomic(this.markdownPath, renderRoadmap(roadmap, { ...run, currentItemId: null }), this.fs);
      let bookkeepingSha = await this.controllerCommitAtHead(run, transaction, subject);
      if (!bookkeepingSha) {
        bookkeepingSha = await commitGenerated(this.root, { paths: transaction.allowedPaths, message: subject });
      }
      const { attempt } = activeAttempt(run, item.id);
      const finishedAt = this.timestamp();
      const settledAttempt = {
        ...attempt,
        state: transaction.targetState,
        reason: attempt.reason,
        finishedAt
      };
      const withSha = parseRun({
        ...run,
        pendingTransaction: { ...transaction, bookkeepingSha }
      });
      const committed = commitTransaction(withSha, transaction.id);
      return mutateRevisionRegular(journalPath, parseRun, run.revision, () => ({
        ...committed,
        currentItemId: null,
        attempts: replaceLastAttempt(committed, item.id, settledAttempt),
        events: addEvent(committed, finishedAt, 'item-settled', item.id, {
          state: transaction.targetState,
          recovered: true
        })
      }), { fs: this.fs, randomUUID: this.createId });
    }

    const { roadmap, source: roadmapSource } = await this.roadmapAtCommit(transaction.implementationSha);
    if (roadmap.revision !== transaction.expectedRoadmapRevision) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'roadmap revision does not match the prepared close');
    }
    const currentRoadmapSource = await this.fs.readFile(this.roadmapPath, 'utf8');
    parseRoadmap(JSON.parse(currentRoadmapSource));
    if (currentRoadmapSource !== roadmapSource) {
      throw lifecycleError('TRANSACTION_CONFLICT', 'roadmap differs from the exact prepared close parent');
    }
    this.roadmap = roadmap;
    const outcome = this.runOutcome(run);
    const reportPath = join(this.root, 'docs/runs', `${run.runId}.json`);
    await ensureContainedDirectory(this.root, dirname(reportPath), this.fs);
    const expectedPaths = [
      relative(this.root, this.markdownPath).split('\\').join('/'),
      relative(this.root, reportPath).split('\\').join('/')
    ];
    this.assertTransactionPaths(transaction, expectedPaths);
    const subject = `chore(roadmapctl): close ${run.runId} as ${outcome}`;
    await this.controllerCommitAtHead(run, transaction, subject);
    const closingRun = { ...run, status: outcome };
    const report = parseReport(buildRunReport(roadmap, closingRun));
    await writeImmutableReport(reportPath, report, { fs: this.fs, randomUUID: this.createId });
    await writeTextAtomic(this.markdownPath, renderRoadmap(roadmap, closingRun), this.fs);
    let bookkeepingSha = await this.controllerCommitAtHead(run, transaction, subject);
    if (!bookkeepingSha) {
      bookkeepingSha = await commitGenerated(this.root, { paths: transaction.allowedPaths, message: subject });
    }
    const withSha = parseRun({
      ...run,
      pendingTransaction: { ...transaction, bookkeepingSha }
    });
    const committed = commitTransaction(withSha, transaction.id);
    const at = this.timestamp();
    const finalized = await mutateRevisionRegular(journalPath, parseRun, run.revision, () => ({
      ...committed,
      status: outcome,
      events: addEvent(committed, at, 'run-closed', null, { status: outcome, recovered: true })
    }), { fs: this.fs, randomUUID: this.createId });
    await this.clearActivePointer(run.runId);
    return finalized;
  }

  async readRunRecovering(journalPath) {
    const run = await readJsonRegular(journalPath, parseRun, { fs: this.fs });
    const recovered = await this.recoverPrepared(journalPath, run);
    if (recovered.status !== 'active') {
      await this.clearActivePointer(recovered.runId, { missingOk: true });
    }
    return recovered;
  }

  async settleItem(journalPath, run, item, attempt, targetState, reason) {
    const roadmap = await readJson(this.roadmapPath, parseRoadmap, { fs: this.fs });
    const repository = await this.assertRunRepository(run, attempt.implementationSha ?? expectedRunHead(run));
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
      implementationSha: repository.head,
      allowedPaths,
      bookkeepingSha: null
    };
    const prepared = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => {
      const begun = beginTransaction(current, transaction);
      return {
        ...begun,
        attempts: replaceLastAttempt(begun, item.id, { ...attempt, reason })
      };
    }, {
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
    const finalized = await mutateRevisionRegular(journalPath, parseRun, prepared.revision, () => ({
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
      const run = await this.readRunRecovering(journalPath);
      const { attempt } = activeAttempt(run, itemId, 'verifying');
      const item = this.roadmap.nodes.find(node => node.kind === 'item' && node.id === itemId);
      if (!item) throw lifecycleError('ITEM_OUT_OF_SCOPE', 'item is outside the run scope');
      const { bindings } = await this.evidenceContext(run, item, attempt);
      await this.assertRunRepository(run, attempt.implementationSha);
      const decision = evaluateCompletion({
        item,
        evidence: attempt.evidence,
        bindings: {
          ...bindings,
          hasUnrecordedRelevantChanges: false
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

  async resolveRunId(runId, { allowClosedPointer = false } = {}) {
    await this.ensureStateRoot();
    if (runId !== null) return assertLifecycleRunId(runId);
    let pointer;
    try {
      pointer = await this.readActivePointer();
    } catch (error) {
      if (error.code === 'STATE_PATH_UNSAFE') throw error;
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer is missing or corrupt', { causeCode: error.code });
    }
    const active = await this.activeJournals();
    if (active.length === 0 && allowClosedPointer) {
      const closed = await readJsonRegular(this.runPath(pointer.runId), parseRun, { fs: this.fs });
      if (closed.status !== 'active') return pointer.runId;
    }
    if (active.length !== 1 || active[0] !== pointer.runId) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer does not identify the only active journal');
    }
    try {
      const run = await readJsonRegular(this.runPath(pointer.runId), parseRun, { fs: this.fs });
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
    const run = await readJsonRegular(this.runPath(resolved), parseRun, { fs: this.fs });
    return this.statusSnapshot(run);
  }

  async resume(runId) {
    const resolved = await this.resolveRunId(runId, { allowClosedPointer: true });
    return this.withRunLock(resolved, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
      return this.statusSnapshot(run);
    });
  }

  async retry(runId, itemId, reasonText) {
    return this.withRunLock(runId, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
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
      const repository = await this.assertRunRepository(run);
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
      const updated = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => ({
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

  async clearActivePointer(runId, { missingOk = false, activeLockHeld = false } = {}) {
    if (!activeLockHeld) {
      return this.withActivePointerLock(() => this.clearActivePointer(runId, {
        missingOk,
        activeLockHeld: true
      }));
    }
    let expected;
    try {
      expected = await this.readActivePointer();
    } catch (error) {
      if (missingOk && error.code === 'ENOENT') return false;
      if (error.code === 'STATE_PATH_UNSAFE') throw error;
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer is missing or corrupt', { causeCode: error.code });
    }
    if (expected.runId !== runId) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer identifies another run');
    }
    const diagnostic = `${this.activeRunPath()}.closed-${this.createId()}`;
    try {
      await this.fs.rename(this.activeRunPath(), diagnostic);
    } catch (error) {
      if (missingOk && error.code === 'ENOENT') return false;
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer could not be cleared', { causeCode: error.code });
    }
    let pointer;
    try {
      pointer = await this.readActivePointer(diagnostic);
    } catch (error) {
      if (error.code === 'STATE_PATH_UNSAFE') throw error;
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the moved active-run pointer is corrupt', { causeCode: error.code });
    }
    if (canonicalStringify(pointer) !== canonicalStringify(expected)) {
      throw lifecycleError('ACTIVE_POINTER_STALE', 'the active-run pointer changed during close');
    }
    return true;
  }

  async closeLocked(journalPath, run, { requireSuccess = false } = {}) {
    const runId = run.runId;
    if (run.status !== 'active') throw lifecycleError('RUN_CLOSED', 'the roadmap run is already closed');
    if (run.currentItemId !== null) throw lifecycleError('ACTIVE_ITEM_CONFLICT', 'an active item must settle before close');
    const repository = await this.assertRunRepository(run);
    const outcome = this.runOutcome(run);
    if (requireSuccess && outcome !== 'successful') {
      throw lifecycleError('RUN_NOT_SUCCESSFUL', 'the run still contains incomplete items', {
        remaining: run.scope.filter(id => this.roadmap.nodes.find(node => node.id === id).status !== 'done')
      });
    }
    const reportPath = join(this.root, 'docs/runs', `${runId}.json`);
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
      implementationSha: repository.head,
      allowedPaths: [relativeMarkdown, relativeReport],
      bookkeepingSha: null
    };
    const prepared = await mutateRevisionRegular(journalPath, parseRun, run.revision, current => beginTransaction(current, transaction), {
      fs: this.fs,
      randomUUID: this.createId
    });
    const closingRun = { ...prepared, status: outcome };
    const report = parseReport(buildRunReport(this.roadmap, closingRun));
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
    const finalized = await mutateRevisionRegular(journalPath, parseRun, prepared.revision, () => ({
      ...committed,
      status: outcome,
      events: addEvent(committed, at, 'run-closed', null, { status: outcome })
    }), { fs: this.fs, randomUUID: this.createId });
    await this.clearActivePointer(runId);
    return { runId, status: outcome, reportPath: relativeReport, bookkeepingSha, revision: finalized.revision };
  }

  async close(runId, options = {}) {
    return this.withRunLock(runId, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
      return this.closeLocked(journalPath, run, options);
    });
  }

  async abort(runId, { confirmed = false } = {}) {
    if (!confirmed) throw lifecycleError('ABORT_CONFIRMATION_REQUIRED', 'abort requires explicit confirmation');
    return this.withRunLock(runId, async journalPath => {
      const run = await this.readRunRecovering(journalPath);
      if (run.status !== 'active' || run.currentItemId === null) {
        throw lifecycleError('ABORT_INVALID', 'abort requires one active item');
      }
      const itemId = run.currentItemId;
      const { attempt } = activeAttempt(run, itemId);
      await this.assertRunRepository(run, attempt.implementationSha ?? expectedRunHead(run));
      const item = this.roadmap.nodes.find(node => node.id === itemId);
      const reason = { code: 'USER_ABORTED', message: 'the user cancelled the active attempt', details: {} };
      const { finalized } = await this.settleItem(journalPath, run, item, attempt, 'cancelled', reason);
      return this.closeLocked(journalPath, finalized);
    });
  }
}
