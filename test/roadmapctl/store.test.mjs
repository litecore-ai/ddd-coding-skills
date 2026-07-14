import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalStringify } from '../../src/roadmapctl/canonical-json.mjs';
import { acquireRunLock, releaseRunLock } from '../../src/roadmapctl/lock.mjs';
import { parseRun } from '../../src/roadmapctl/schema.mjs';
import {
  beginTransaction,
  commitTransaction,
  mutateRevision,
  readJson,
  readJsonRegular,
  writeJsonAtomic
} from '../../src/roadmapctl/store.mjs';
import { validRun, validTransaction } from './helpers.mjs';

const OWNER_TOKEN = '550e8400-e29b-41d4-a716-446655440000';
const NEXT_TOKEN = '650e8400-e29b-41d4-a716-446655440000';
const FOREIGN_TOKEN = '750e8400-e29b-41d4-a716-446655440000';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'roadmapctl-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function errorWithCode(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function fixedOwner(overrides = {}) {
  return {
    runId: 'r1',
    pid: 4242,
    hostname: 'local.test',
    createdAt: new Date(1_000).toISOString(),
    leaseExpiresAt: new Date(61_000).toISOString(),
    token: OWNER_TOKEN,
    ...overrides
  };
}

async function seedLock(lockPath, owner = fixedOwner()) {
  await fs.mkdir(lockPath, { recursive: true });
  await writeJsonAtomic(join(lockPath, 'owner.json'), owner);
}

async function seedJournal(directory, overrides = {}) {
  const journalPath = join(directory, 'run.json');
  await writeJsonAtomic(journalPath, validRun(overrides));
  return journalPath;
}

async function onlyQuarantineEntry(directory) {
  const cleanupNames = (await fs.readdir(directory)).filter(name => name.includes('.cleanup-'));
  assert.equal(cleanupNames.length, 1, 'expected exactly one diagnostic quarantine');
  const cleanupDirectory = join(directory, cleanupNames[0]);
  assert.deepEqual(await fs.readdir(cleanupDirectory), ['entry']);
  return join(cleanupDirectory, 'entry');
}

function lockOptions(overrides = {}) {
  return {
    runId: 'r1',
    pid: 5252,
    hostname: () => 'local.test',
    now: () => 70_000,
    leaseMs: 60_000,
    randomUUID: () => NEXT_TOKEN,
    processKill: () => {
      throw errorWithCode('ESRCH');
    },
    ...overrides
  };
}

test('atomic JSON writes create parents and persist canonical bytes', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'nested', 'run.json');
  const value = { z: 1, a: { y: 2, x: 3 } };

  await writeJsonAtomic(file, value);

  assert.equal(await fs.readFile(file, 'utf8'), canonicalStringify(value));
  assert.deepEqual(await fs.readdir(dirname(file)), ['run.json']);
});

test('temporary-write failure preserves the destination and quarantines its temporary file', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const original = validRun({ status: 'active' });
  await writeJsonAtomic(file, original);
  const unrelated = join(directory, `${basename(file)}.tmp-unrelated`);
  await fs.writeFile(unrelated, 'keep');

  const injected = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (flags !== 'wx') return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') return async () => { throw new Error('injected write failure'); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };

  await assert.rejects(
    writeJsonAtomic(file, { ...original, status: 'failed' }, { fs: injected, randomUUID: () => 'owned' }),
    /injected write failure/
  );

  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  const names = await fs.readdir(directory);
  const cleanupName = names.find(name => name.startsWith(`.${basename(file)}.tmp-owned.cleanup-`));
  assert.ok(cleanupName, 'failed temp must be retained in a diagnostic quarantine');
  assert.deepEqual(names.sort(), [cleanupName, 'run.json', `${basename(file)}.tmp-unrelated`].sort());
  assert.deepEqual(await fs.readdir(join(directory, cleanupName)), ['entry']);
  assert.equal(await fs.readFile(join(directory, cleanupName, 'entry'), 'utf8'), '');
});

test('rename failure preserves the destination and quarantines the completed temporary file', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const original = validRun();
  await writeJsonAtomic(file, original);
  const injected = {
    ...fs,
    async rename(source, destination) {
      if (destination === file) throw new Error('injected rename failure');
      return fs.rename(source, destination);
    }
  };

  await assert.rejects(
    writeJsonAtomic(file, { ...original, status: 'failed' }, { fs: injected, randomUUID: () => 'rename-fault' }),
    /injected rename failure/
  );

  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  assert.equal(await fs.readFile(await onlyQuarantineEntry(directory), 'utf8'), canonicalStringify({ ...original, status: 'failed' }));
});

test('rename failure preserves a foreign temporary replacement with a different inode', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const original = validRun();
  const temporaryPath = join(directory, `${basename(file)}.tmp-replaced`);
  const fault = errorWithCode('EIO', 'injected rename replacement failure');
  await writeJsonAtomic(file, original);
  const injected = {
    ...fs,
    async rename(source, destination) {
      if (destination === file) {
        assert.equal(source, temporaryPath);
        await fs.rm(source);
        await fs.writeFile(source, 'foreign temporary bytes');
        throw fault;
      }
      return fs.rename(source, destination);
    }
  };

  await assert.rejects(
    writeJsonAtomic(file, { ...original, status: 'failed' }, { fs: injected, randomUUID: () => 'replaced' }),
    error => error === fault
  );

  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  assert.equal(await fs.readFile(await onlyQuarantineEntry(directory), 'utf8'), 'foreign temporary bytes');
});

test('cleanup cannot delete a foreign replacement installed after its identity lstat', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const original = validRun();
  const temporaryPath = join(directory, `${basename(file)}.tmp-after-check`);
  const foreignBytes = 'foreign bytes installed after lstat';
  const fault = errorWithCode('EIO', 'injected destination rename failure');
  let replaced = false;
  await writeJsonAtomic(file, original);
  const injected = {
    ...fs,
    async rename(source, destination) {
      if (destination === file) throw fault;
      return fs.rename(source, destination);
    },
    async lstat(path, options) {
      const identity = await fs.lstat(path, options);
      if (!replaced && path === temporaryPath) {
        replaced = true;
        await fs.rm(path);
        await fs.writeFile(path, foreignBytes);
      }
      return identity;
    }
  };

  await assert.rejects(
    writeJsonAtomic(file, { ...original, status: 'failed' }, {
      fs: injected,
      randomUUID: () => 'after-check'
    }),
    error => error === fault
  );

  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  if (replaced) assert.equal(await fs.readFile(temporaryPath, 'utf8'), foreignBytes);
  assert.equal(replaced, false, 'cleanup must quarantine before checking path identity');
  assert.equal(await fs.readFile(await onlyQuarantineEntry(directory), 'utf8'), canonicalStringify({ ...original, status: 'failed' }));
});

test('cleanup preserves a foreign replacement installed after a real quarantine lstat', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const original = validRun();
  const next = { ...original, status: 'failed' };
  const foreignBytes = 'foreign bytes installed inside quarantine';
  const fault = errorWithCode('EIO', 'injected destination rename failure');
  let quarantinePath;
  let quarantinedIdentity;
  let staleIdentityReads = 0;
  await writeJsonAtomic(file, original);
  const injected = {
    ...fs,
    async rename(source, destination) {
      if (destination === file) throw fault;
      await fs.rename(source, destination);
      if (basename(destination) === 'entry' && dirname(destination).includes('.cleanup-')) {
        quarantinePath = destination;
        quarantinedIdentity = await fs.lstat(destination, { bigint: true });
        await fs.rm(destination);
        await fs.writeFile(destination, foreignBytes);
      }
    },
    async lstat(path, options) {
      if (path === quarantinePath && quarantinedIdentity) {
        staleIdentityReads += 1;
        return quarantinedIdentity;
      }
      return fs.lstat(path, options);
    }
  };

  await assert.rejects(
    writeJsonAtomic(file, next, { fs: injected, randomUUID: () => 'quarantine-race' }),
    error => error === fault
  );

  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  assert.ok(quarantinePath, 'the fault must install a real replacement in quarantine');
  assert.equal(await fs.readFile(quarantinePath, 'utf8'), foreignBytes);
  assert.deepEqual(await fs.readdir(dirname(quarantinePath)), ['entry']);
  assert.equal(await onlyQuarantineEntry(directory), quarantinePath);
  assert.equal(staleIdentityReads, 0, 'failure cleanup must not inspect or unlink quarantine entries');
});

test('exclusive-open collision never removes a temporary file owned by another writer', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const collidingTemporary = join(directory, `${basename(file)}.tmp-collision`);
  await fs.writeFile(collidingTemporary, 'foreign writer data');

  await assert.rejects(
    writeJsonAtomic(file, validRun(), { randomUUID: () => 'collision' }),
    error => error.code === 'EEXIST'
  );

  assert.equal(await fs.readFile(collidingTemporary, 'utf8'), 'foreign writer data');
  await assert.rejects(fs.stat(file), error => error.code === 'ENOENT');
});

test('corrupt JSON is rejected without modifying or removing the journal', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const corrupt = '{"revision": 3';
  await fs.writeFile(file, corrupt);

  await assert.rejects(
    readJson(file, parseRun),
    error => error.code === 'STATE_CORRUPT' && error.details.path === file
  );

  assert.equal(await fs.readFile(file, 'utf8'), corrupt);
});

test('regular JSON reads reject a symlink without reading its target', async t => {
  const directory = await temporaryDirectory(t);
  const outside = join(directory, 'outside.json');
  const linked = join(directory, 'linked.json');
  await fs.writeFile(outside, canonicalStringify({ revision: 0 }));
  await fs.symlink(outside, linked);

  await assert.rejects(
    readJsonRegular(linked, value => value),
    error => error.code === 'STATE_PATH_UNSAFE'
  );
});

test('revision mutation validates, increments exactly once, and persists the parsed document', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  await writeJsonAtomic(file, validRun({ revision: 3 }));

  const updated = await mutateRevision(file, parseRun, 3, run => ({ ...run, status: 'failed' }));

  assert.equal(updated.revision, 4);
  assert.equal(updated.status, 'failed');
  assert.equal(Object.isFrozen(updated), true);
  assert.deepEqual(await readJson(file, parseRun), updated);
});

test('revision mismatch preserves the original document and never invokes the mutator', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  await writeJsonAtomic(file, validRun({ revision: 3 }));
  let invoked = false;

  await assert.rejects(
    mutateRevision(file, parseRun, 2, value => {
      invoked = true;
      return { ...value, status: 'failed' };
    }),
    error => error.code === 'REVISION_CONFLICT'
      && error.details.expectedRevision === 2
      && error.details.actualRevision === 3
  );

  assert.equal(invoked, false);
  assert.equal((await readJson(file, parseRun)).status, 'active');
});

test('revision overflow fails before mutation and preserves the original document', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'run.json');
  const original = validRun({ revision: Number.MAX_SAFE_INTEGER });
  await writeJsonAtomic(file, original);
  let invoked = false;

  await assert.rejects(
    mutateRevision(file, parseRun, Number.MAX_SAFE_INTEGER, run => {
      invoked = true;
      return { ...run, status: 'failed' };
    }),
    error => error.code === 'REVISION_OVERFLOW'
      && error.details.revision === Number.MAX_SAFE_INTEGER
  );

  assert.equal(invoked, false);
  assert.deepEqual(await readJson(file, parseRun), parseRun(original));
});

test('run schema validates the exact pending transaction envelope', () => {
  const parsed = parseRun(validRun({ pendingTransaction: validTransaction() }));
  assert.equal(parsed.pendingTransaction.type, 'settle-item');
  assert.equal(Object.isFrozen(parsed.pendingTransaction.allowedPaths), true);

  const invalidCases = [
    validTransaction({ extra: true }),
    validTransaction({ id: 'tx-not-a-uuid' }),
    validTransaction({ implementationSha: 'ABC' }),
    validTransaction({ allowedPaths: ['a', 'a'] }),
    validTransaction({ type: 'close-run', itemId: 'P1.1.1', targetState: 'done' }),
    validTransaction({ state: 'committed', bookkeepingSha: null })
  ];
  for (const transaction of invalidCases) {
    assert.throws(() => parseRun(validRun({ pendingTransaction: transaction })), error => error.code === 'SCHEMA_INVALID');
  }
});

test('prepared transaction markers are idempotent and conflicting prepares are rejected', () => {
  const run = validRun();
  const transaction = validTransaction();

  const prepared = beginTransaction(run, transaction);
  assert.deepEqual(prepared.pendingTransaction, transaction);
  assert.equal(run.pendingTransaction, null);
  assert.strictEqual(beginTransaction(prepared, { ...transaction }), prepared);
  assert.throws(
    () => beginTransaction(prepared, { ...transaction, targetState: 'failed' }),
    error => error.code === 'TRANSACTION_CONFLICT'
  );
  assert.throws(
    () => beginTransaction(prepared, validTransaction({ id: `tx-${randomUUID()}` })),
    error => error.code === 'TRANSACTION_CONFLICT'
  );
});

test('null and undefined transactions fail with an explicit typed error', () => {
  for (const transaction of [null, undefined]) {
    assert.throws(
      () => beginTransaction(validRun(), transaction),
      error => error.code === 'TRANSACTION_INVALID'
    );
  }
});

test('transaction commit is idempotent and a later transaction can replace a committed marker', () => {
  const sha = '1'.repeat(40);
  const prepared = beginTransaction(validRun(), validTransaction({ bookkeepingSha: sha }));
  const committed = commitTransaction(prepared, prepared.pendingTransaction.id);

  assert.equal(committed.pendingTransaction.state, 'committed');
  assert.strictEqual(commitTransaction(committed, committed.pendingTransaction.id), committed);
  assert.strictEqual(beginTransaction(committed, { ...committed.pendingTransaction }), committed);

  const next = validTransaction({ id: `tx-${randomUUID()}`, bookkeepingSha: null });
  assert.deepEqual(beginTransaction(committed, next).pendingTransaction, next);
  assert.throws(
    () => commitTransaction(prepared, `tx-${randomUUID()}`),
    error => error.code === 'TRANSACTION_CONFLICT'
  );
});

test('a committed transaction ID can never be downgraded to prepared', () => {
  const transaction = validTransaction({ bookkeepingSha: '1'.repeat(40) });
  const committed = commitTransaction(beginTransaction(validRun(), transaction), transaction.id);

  assert.throws(
    () => beginTransaction(committed, { ...transaction, state: 'prepared' }),
    error => error.code === 'TRANSACTION_CONFLICT'
  );
});

test('transaction commit refuses to claim durability before a bookkeeping SHA exists', () => {
  const prepared = beginTransaction(validRun(), validTransaction({ bookkeepingSha: null }));
  assert.throws(
    () => commitTransaction(prepared, prepared.pendingTransaction.id),
    error => error.code === 'TRANSACTION_INCOMPLETE'
  );
});

test('lock creation writes complete owner metadata and release retains that owner as a diagnostic', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.release-${OWNER_TOKEN}-${OWNER_TOKEN}`;
  const acquired = await acquireRunLock(lockPath, lockOptions({
    now: () => 1_000,
    randomUUID: () => OWNER_TOKEN
  }));

  assert.deepEqual(acquired.owner, fixedOwner({ pid: 5252 }));
  assert.deepEqual(await readJson(join(lockPath, 'owner.json'), value => value), acquired.owner);

  await acquired.release();
  await assert.rejects(fs.stat(lockPath), error => error.code === 'ENOENT');
  assert.deepEqual(await readJson(join(diagnosticPath, 'owner.json'), value => value), acquired.owner);
});

test('owner temporary-file collision reports the original failure and retains the uninitialized diagnostic', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.failed-${NEXT_TOKEN}-${NEXT_TOKEN}`;
  const collision = errorWithCode('EEXIST', 'injected owner temporary-file collision');
  const injected = {
    ...fs,
    async open(path, flags, mode) {
      if (flags === 'wx' && basename(path).startsWith('owner.json.tmp-')) throw collision;
      return fs.open(path, flags, mode);
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected })),
    error => error === collision
  );
  await assert.rejects(fs.stat(lockPath), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(diagnosticPath), []);
});

test('failed acquisition never removes a foreign lock that replaced its created directory', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const foreign = fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 });
  const fault = errorWithCode('EIO', 'injected owner write failure after replacement');
  let replaced = false;
  const injected = {
    ...fs,
    async open(path, flags, mode) {
      if (!replaced && flags === 'wx' && basename(path).startsWith('owner.json.tmp-')) {
        replaced = true;
        await fs.rm(lockPath, { recursive: true });
        await fs.mkdir(lockPath);
        await fs.writeFile(join(lockPath, 'owner.json'), canonicalStringify(foreign));
        throw fault;
      }
      return fs.open(path, flags, mode);
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected })),
    error => error === fault
  );

  assert.deepEqual(await readJson(join(lockPath, 'owner.json'), value => value), foreign);
});

test('failed acquisition preserves a foreign diagnostic replacement installed after diagnostic lstat', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.failed-${NEXT_TOKEN}-${NEXT_TOKEN}`;
  const foreign = fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 });
  const foreignOwnerBytes = canonicalStringify(foreign);
  const foreignMarkerBytes = 'foreign failed-acquisition diagnostic';
  const fault = errorWithCode('EIO', 'injected owner write failure before diagnostic replacement');
  let replaced = false;
  const injected = {
    ...fs,
    async open(path, flags, mode) {
      if (flags === 'wx' && basename(path).startsWith('owner.json.tmp-')) throw fault;
      return fs.open(path, flags, mode);
    },
    async lstat(path, options) {
      const identity = await fs.lstat(path, options);
      if (!replaced && path === diagnosticPath) {
        replaced = true;
        await fs.rm(path, { recursive: true });
        await fs.mkdir(path);
        await fs.writeFile(join(path, 'owner.json'), foreignOwnerBytes);
        await fs.writeFile(join(path, 'marker'), foreignMarkerBytes);
      }
      return identity;
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected })),
    error => error === fault
  );

  assert.equal(replaced, true, 'the fault must replace the moved diagnostic after its real lstat');
  await assert.rejects(fs.stat(lockPath), error => error.code === 'ENOENT');
  assert.equal(await fs.readFile(join(diagnosticPath, 'owner.json'), 'utf8'), foreignOwnerBytes);
  assert.equal(await fs.readFile(join(diagnosticPath, 'marker'), 'utf8'), foreignMarkerBytes);
});

test('failed-acquisition identity mismatch never restores over a foreign empty canonical directory', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.failed-${NEXT_TOKEN}-${NEXT_TOKEN}`;
  const foreignMarkerBytes = 'foreign failed-acquisition mismatch diagnostic';
  const fault = errorWithCode('EIO', 'injected owner write failure before identity mismatch');
  let foreignCanonicalIdentity;
  const injected = {
    ...fs,
    async open(path, flags, mode) {
      if (flags === 'wx' && basename(path).startsWith('owner.json.tmp-')) throw fault;
      return fs.open(path, flags, mode);
    },
    async rename(source, destination) {
      await fs.rename(source, destination);
      if (source === lockPath && destination === diagnosticPath) {
        await fs.mkdir(lockPath);
        foreignCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
        await fs.rm(diagnosticPath, { recursive: true });
        await fs.mkdir(diagnosticPath);
        await fs.writeFile(join(diagnosticPath, 'marker'), foreignMarkerBytes);
      }
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected })),
    error => error.code === 'LOCK_RECOVERY_REQUIRED'
      && error.details.diagnosticPath === diagnosticPath
      && error.details.reservationCreated === false
      && error.details.causeCode === 'EIO'
  );

  const retainedCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
  assert.equal(retainedCanonicalIdentity.dev, foreignCanonicalIdentity.dev);
  assert.equal(retainedCanonicalIdentity.ino, foreignCanonicalIdentity.ino);
  assert.deepEqual(await fs.readdir(lockPath), []);
  assert.equal(await fs.readFile(join(diagnosticPath, 'marker'), 'utf8'), foreignMarkerBytes);
});

test('post-mkdir identity failure quarantines the created directory and installs a fail-closed reservation', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.failed-${NEXT_TOKEN}-${NEXT_TOKEN}`;
  const fault = errorWithCode('EIO', 'injected post-mkdir identity failure');
  let createdIdentity;
  let failed = false;
  const injected = {
    ...fs,
    async lstat(path, options) {
      const identity = await fs.lstat(path, options);
      if (!failed && path === lockPath) {
        failed = true;
        createdIdentity = identity;
        throw fault;
      }
      return identity;
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected })),
    error => error.code === 'LOCK_RECOVERY_REQUIRED'
      && error.details.diagnosticPath === diagnosticPath
      && error.details.reservationCreated === true
      && error.details.causeCode === 'EIO'
  );

  const diagnosticIdentity = await fs.lstat(diagnosticPath, { bigint: true });
  assert.equal(diagnosticIdentity.dev, createdIdentity.dev);
  assert.equal(diagnosticIdentity.ino, createdIdentity.ino);
  assert.deepEqual(await fs.readdir(diagnosticPath), []);
  const reservationIdentity = await fs.lstat(lockPath, { bigint: true });
  assert.notEqual(reservationIdentity.ino, diagnosticIdentity.ino);
  assert.equal(Number(reservationIdentity.mode & 0o777n), 0o700);
  assert.deepEqual(await fs.readdir(lockPath), []);

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions()),
    error => error.code === 'LOCK_CORRUPT'
  );
  const retainedReservationIdentity = await fs.lstat(lockPath, { bigint: true });
  assert.equal(retainedReservationIdentity.dev, reservationIdentity.dev);
  assert.equal(retainedReservationIdentity.ino, reservationIdentity.ino);
  assert.deepEqual(await fs.readdir(diagnosticPath), []);
});

test('fail-closed reservation creation never touches a foreign canonical race winner', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.failed-${NEXT_TOKEN}-${NEXT_TOKEN}`;
  const fault = errorWithCode('EIO', 'injected post-mkdir identity failure before reservation race');
  let createdIdentity;
  let foreignCanonicalIdentity;
  let failed = false;
  const injected = {
    ...fs,
    async lstat(path, options) {
      const identity = await fs.lstat(path, options);
      if (!failed && path === lockPath) {
        failed = true;
        createdIdentity = identity;
        throw fault;
      }
      return identity;
    },
    async rename(source, destination) {
      await fs.rename(source, destination);
      if (source === lockPath && destination === diagnosticPath) {
        await fs.mkdir(lockPath);
        foreignCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
      }
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected })),
    error => error.code === 'LOCK_RECOVERY_REQUIRED'
      && error.details.diagnosticPath === diagnosticPath
      && error.details.reservationCreated === false
      && error.details.causeCode === 'EIO'
  );

  const diagnosticIdentity = await fs.lstat(diagnosticPath, { bigint: true });
  assert.equal(diagnosticIdentity.dev, createdIdentity.dev);
  assert.equal(diagnosticIdentity.ino, createdIdentity.ino);
  assert.deepEqual(await fs.readdir(diagnosticPath), []);
  const retainedCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
  assert.equal(retainedCanonicalIdentity.dev, foreignCanonicalIdentity.dev);
  assert.equal(retainedCanonicalIdentity.ino, foreignCanonicalIdentity.ino);
  assert.deepEqual(await fs.readdir(lockPath), []);
});

test('foreign lock cannot be released and remains byte-for-byte unchanged', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const acquired = await acquireRunLock(lockPath, lockOptions({
    now: () => 1_000,
    randomUUID: () => OWNER_TOKEN
  }));
  const ownerPath = join(lockPath, 'owner.json');
  const before = await fs.readFile(ownerPath);

  await assert.rejects(
    releaseRunLock(lockPath, { ...acquired.owner, token: FOREIGN_TOKEN }),
    error => error.code === 'LOCK_OWNER_MISMATCH' && /owner/i.test(error.message)
  );

  assert.deepEqual(await fs.readFile(ownerPath), before);
  await acquired.release();
});

test('release quarantines corrupt metadata and reserves the active lock path for recovery', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.release-${OWNER_TOKEN}-${NEXT_TOKEN}`;
  const owner = fixedOwner();
  await seedLock(lockPath, owner);
  const injected = {
    ...fs,
    async rename(source, destination) {
      await fs.rename(source, destination);
      if (source === lockPath) await fs.writeFile(join(destination, 'owner.json'), '{corrupt replacement');
    }
  };

  await assert.rejects(
    releaseRunLock(lockPath, owner, { fs: injected, randomUUID: () => NEXT_TOKEN }),
    error => error.code === 'LOCK_CORRUPT'
      && error.details.diagnosticPath === diagnosticPath
      && error.details.reservationCreated === true
  );
  assert.equal(await fs.readFile(join(diagnosticPath, 'owner.json'), 'utf8'), '{corrupt replacement');
  assert.deepEqual(await fs.readdir(lockPath), []);
  const reservation = await fs.lstat(lockPath, { bigint: true });
  assert.equal(Number(reservation.mode & 0o777n), 0o700);
});

for (const movedOwner of ['corrupt', 'token-mismatch']) {
  test(`release ${movedOwner} never restores a diagnostic over a foreign empty canonical directory`, async t => {
    const directory = await temporaryDirectory(t);
    const lockPath = join(directory, 'run.lock');
    const diagnosticPath = `${lockPath}.release-${OWNER_TOKEN}-${NEXT_TOKEN}`;
    const owner = fixedOwner();
    const movedOwnerBytes = movedOwner === 'corrupt'
      ? '{corrupt moved owner'
      : canonicalStringify(fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 }));
    let foreignCanonicalIdentity;
    await seedLock(lockPath, owner);
    const injected = {
      ...fs,
      async rename(source, destination) {
        await fs.rename(source, destination);
        if (source === lockPath && destination === diagnosticPath) {
          await fs.mkdir(lockPath);
          foreignCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
          await fs.writeFile(join(diagnosticPath, 'owner.json'), movedOwnerBytes);
        }
      }
    };

    const expectedCode = movedOwner === 'corrupt' ? 'LOCK_CORRUPT' : 'LOCK_OWNER_MISMATCH';
    await assert.rejects(
      releaseRunLock(lockPath, owner, { fs: injected, randomUUID: () => NEXT_TOKEN }),
      error => error.code === expectedCode
        && error.details.diagnosticPath === diagnosticPath
        && error.details.reservationCreated === false
        && error.details.causeCode === expectedCode
    );

    const retainedCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
    assert.equal(retainedCanonicalIdentity.dev, foreignCanonicalIdentity.dev);
    assert.equal(retainedCanonicalIdentity.ino, foreignCanonicalIdentity.ino);
    assert.deepEqual(await fs.readdir(lockPath), []);
    assert.equal(await fs.readFile(join(diagnosticPath, 'owner.json'), 'utf8'), movedOwnerBytes);
  });
}

test('release fails closed on a foreign diagnostic replacement installed after moved owner read', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.release-${OWNER_TOKEN}-${NEXT_TOKEN}`;
  const diagnosticOwnerPath = join(diagnosticPath, 'owner.json');
  const owner = fixedOwner();
  const foreign = fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 });
  const foreignOwnerBytes = canonicalStringify(foreign);
  const foreignMarkerBytes = 'foreign release diagnostic';
  let replaced = false;
  await seedLock(lockPath, owner);
  const injected = {
    ...fs,
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      if (path !== diagnosticOwnerPath) return handle;
      return {
        stat: options => handle.stat(options),
        async readFile(options) {
          const source = await handle.readFile(options);
          if (!replaced) {
            replaced = true;
            await fs.rm(diagnosticPath, { recursive: true });
            await fs.mkdir(diagnosticPath);
            await fs.writeFile(diagnosticOwnerPath, foreignOwnerBytes);
            await fs.writeFile(join(diagnosticPath, 'marker'), foreignMarkerBytes);
          }
          return source;
        },
        close: () => handle.close()
      };
    }
  };

  await assert.rejects(
    releaseRunLock(lockPath, owner, { fs: injected, randomUUID: () => NEXT_TOKEN }),
    error => error.code === 'LOCK_CORRUPT' && error.details.reservationCreated === true
  );

  assert.equal(replaced, true, 'the fault must replace the moved diagnostic after its real owner read');
  assert.deepEqual(await fs.readdir(lockPath), []);
  assert.equal(await fs.readFile(diagnosticOwnerPath, 'utf8'), foreignOwnerBytes);
  assert.equal(await fs.readFile(join(diagnosticPath, 'marker'), 'utf8'), foreignMarkerBytes);
});

for (const outcome of ['success', 'EPERM']) {
  test(`same-host owner is live when process probe returns ${outcome}`, async t => {
    const directory = await temporaryDirectory(t);
    const lockPath = join(directory, 'run.lock');
    await seedLock(lockPath);
    let journalValidated = false;

    await assert.rejects(
      acquireRunLock(lockPath, lockOptions({
        processKill() {
          if (outcome === 'EPERM') throw errorWithCode('EPERM');
        },
        validateJournal: async () => { journalValidated = true; }
      })),
      error => error.code === 'LOCK_HELD'
    );

    assert.equal(journalValidated, false);
    assert.equal((await readJson(join(lockPath, 'owner.json'), value => value)).token, OWNER_TOKEN);
  });
}

test('absent same-host PID is recovered only after its journal validates', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  await seedLock(lockPath);
  const journalPath = await seedJournal(directory);
  const renameCalls = [];
  const injected = {
    ...fs,
    async rename(source, destination) {
      renameCalls.push([source, destination]);
      return fs.rename(source, destination);
    }
  };

  const acquired = await acquireRunLock(lockPath, lockOptions({ fs: injected, journalPath, journalParser: parseRun }));

  assert.equal(acquired.owner.token, NEXT_TOKEN);
  assert.equal(renameCalls.some(([source, destination]) => source === lockPath && destination.startsWith(`${lockPath}.stale-`)), true);
  const staleNames = (await fs.readdir(directory)).filter(name => name.includes('.stale-'));
  assert.deepEqual(staleNames, [`${basename(lockPath)}.stale-${OWNER_TOKEN}-${NEXT_TOKEN}`]);
  assert.equal((await readJson(join(directory, staleNames[0], 'owner.json'), value => value)).token, OWNER_TOKEN);
  await acquired.release();
});

test('stale recovery fails closed on a foreign diagnostic replacement installed after moved owner read', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.stale-${OWNER_TOKEN}-${NEXT_TOKEN}`;
  const diagnosticOwnerPath = join(diagnosticPath, 'owner.json');
  const journalPath = await seedJournal(directory);
  const foreign = fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 });
  const foreignOwnerBytes = canonicalStringify(foreign);
  const foreignMarkerBytes = 'foreign stale-recovery diagnostic';
  let replaced = false;
  await seedLock(lockPath);
  const injected = {
    ...fs,
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      if (path !== diagnosticOwnerPath) return handle;
      return {
        stat: options => handle.stat(options),
        async readFile(options) {
          const source = await handle.readFile(options);
          if (!replaced) {
            replaced = true;
            await fs.rm(diagnosticPath, { recursive: true });
            await fs.mkdir(diagnosticPath);
            await fs.writeFile(diagnosticOwnerPath, foreignOwnerBytes);
            await fs.writeFile(join(diagnosticPath, 'marker'), foreignMarkerBytes);
          }
          return source;
        },
        close: () => handle.close()
      };
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({
      fs: injected,
      journalPath,
      journalParser: parseRun
    })),
    error => error.code === 'LOCK_CORRUPT' && error.details.reservationCreated === true
  );

  assert.equal(replaced, true, 'the fault must replace the stale diagnostic after its real owner read');
  assert.deepEqual(await fs.readdir(lockPath), []);
  assert.equal(await fs.readFile(diagnosticOwnerPath, 'utf8'), foreignOwnerBytes);
  assert.equal(await fs.readFile(join(diagnosticPath, 'marker'), 'utf8'), foreignMarkerBytes);
});

test('stale-recovery mismatch never restores a diagnostic over a foreign empty canonical directory', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.stale-${OWNER_TOKEN}-${NEXT_TOKEN}`;
  const journalPath = await seedJournal(directory);
  const movedOwnerBytes = canonicalStringify(fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 }));
  let foreignCanonicalIdentity;
  await seedLock(lockPath);
  const injected = {
    ...fs,
    async rename(source, destination) {
      await fs.rename(source, destination);
      if (source === lockPath && destination === diagnosticPath) {
        await fs.mkdir(lockPath);
        foreignCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
        await fs.writeFile(join(diagnosticPath, 'owner.json'), movedOwnerBytes);
      }
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected, journalPath, journalParser: parseRun })),
    error => error.code === 'LOCK_RACE'
      && error.details.diagnosticPath === diagnosticPath
      && error.details.reservationCreated === false
      && error.details.causeCode === 'LOCK_RACE'
  );

  const retainedCanonicalIdentity = await fs.lstat(lockPath, { bigint: true });
  assert.equal(retainedCanonicalIdentity.dev, foreignCanonicalIdentity.dev);
  assert.equal(retainedCanonicalIdentity.ino, foreignCanonicalIdentity.ino);
  assert.deepEqual(await fs.readdir(lockPath), []);
  assert.equal(await fs.readFile(join(diagnosticPath, 'owner.json'), 'utf8'), movedOwnerBytes);
});

test('remote owner is recovered only after lease expiry', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const journalPath = await seedJournal(directory);
  let killCalls = 0;
  await seedLock(lockPath, fixedOwner({ hostname: 'remote.test' }));

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({
      now: () => 60_999,
      journalPath,
      journalParser: parseRun,
      processKill: () => { killCalls += 1; }
    })),
    error => error.code === 'LOCK_HELD'
  );
  assert.equal(killCalls, 0);

  const acquired = await acquireRunLock(lockPath, lockOptions({
    now: () => 61_000,
    journalPath,
    journalParser: parseRun,
    processKill: () => { killCalls += 1; }
  }));
  assert.equal(killCalls, 0);
  assert.equal(acquired.owner.token, NEXT_TOKEN);
  await acquired.release();
});

test('corrupt journal prevents stale recovery and preserves both journal and lock', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const journalPath = join(directory, 'run.json');
  const corrupt = '{"runId":"r1"';
  await seedLock(lockPath);
  await fs.writeFile(journalPath, corrupt);

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ journalPath, journalParser: parseRun })),
    error => error.code === 'LOCK_RECOVERY_UNSAFE' && error.details.causeCode === 'STATE_CORRUPT'
  );

  assert.equal(await fs.readFile(journalPath, 'utf8'), corrupt);
  assert.equal((await readJson(join(lockPath, 'owner.json'), value => value)).token, OWNER_TOKEN);
});

test('stale recovery without a journal validator is rejected conservatively', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  await seedLock(lockPath);

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions()),
    error => error.code === 'LOCK_RECOVERY_UNSAFE'
  );
  assert.equal((await readJson(join(lockPath, 'owner.json'), value => value)).token, OWNER_TOKEN);
});

test('unexpected same-host process probe errors never trigger recovery', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const journalPath = await seedJournal(directory);
  await seedLock(lockPath);

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({
      journalPath,
      journalParser: parseRun,
      processKill: () => { throw errorWithCode('EACCES'); }
    })),
    error => error.code === 'LOCK_PROBE_FAILED' && error.details.causeCode === 'EACCES'
  );
  assert.equal((await readJson(join(lockPath, 'owner.json'), value => value)).token, OWNER_TOKEN);
});

test('stale rename quarantines a concurrently replaced lock and reserves the active path', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const diagnosticPath = `${lockPath}.stale-${OWNER_TOKEN}-${NEXT_TOKEN}`;
  const journalPath = await seedJournal(directory);
  await seedLock(lockPath);
  const replacement = fixedOwner({ token: FOREIGN_TOKEN, pid: 6262 });
  let replaced = false;
  const injected = {
    ...fs,
    async rename(source, destination) {
      if (source === lockPath && !replaced) {
        replaced = true;
        await fs.rm(lockPath, { recursive: true });
        await fs.mkdir(lockPath);
        await fs.writeFile(join(lockPath, 'owner.json'), canonicalStringify(replacement));
      }
      return fs.rename(source, destination);
    }
  };

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ fs: injected, journalPath, journalParser: parseRun })),
    error => error.code === 'LOCK_RACE'
      && error.details.diagnosticPath === diagnosticPath
      && error.details.reservationCreated === true
  );

  assert.deepEqual(await readJson(join(diagnosticPath, 'owner.json'), value => value), replacement);
  assert.deepEqual(await fs.readdir(lockPath), []);
  const reservation = await fs.lstat(lockPath, { bigint: true });
  assert.equal(Number(reservation.mode & 0o777n), 0o700);
});

test('corrupt owner metadata is preserved and never treated as stale', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'run.lock');
  const ownerPath = join(lockPath, 'owner.json');
  await fs.mkdir(lockPath);
  await fs.writeFile(ownerPath, '{bad owner');

  await assert.rejects(
    acquireRunLock(lockPath, lockOptions({ validateJournal: async () => {} })),
    error => error.code === 'LOCK_CORRUPT'
  );
  assert.equal(await fs.readFile(ownerPath, 'utf8'), '{bad owner');
});
