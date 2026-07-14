import { randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { hostname as systemHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RoadmapError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';

const OWNER_KEYS = new Set(['runId', 'pid', 'hostname', 'createdAt', 'leaseExpiresAt', 'token']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ACQUIRE_RACES = 8;

function lockError(code, message, details = {}) {
  return new RoadmapError(code, message, details);
}

function isoTimestamp(value, path) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw lockError('LOCK_CORRUPT', `${path} must be an ISO timestamp`, { path });
  }
  if (new Date(value).toISOString() !== value) {
    throw lockError('LOCK_CORRUPT', `${path} must use canonical ISO format`, { path });
  }
}

function parseOwner(value) {
  if (value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw lockError('LOCK_CORRUPT', 'Lock owner metadata must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!OWNER_KEYS.has(key)) throw lockError('LOCK_CORRUPT', `Lock owner contains unknown key ${key}`);
  }
  for (const key of OWNER_KEYS) {
    if (!Object.hasOwn(value, key)) throw lockError('LOCK_CORRUPT', `Lock owner is missing ${key}`);
  }
  if (typeof value.runId !== 'string' || value.runId.length === 0) throw lockError('LOCK_CORRUPT', 'Lock owner runId is invalid');
  if (!Number.isInteger(value.pid) || value.pid <= 0) throw lockError('LOCK_CORRUPT', 'Lock owner PID is invalid');
  if (typeof value.hostname !== 'string' || value.hostname.length === 0) throw lockError('LOCK_CORRUPT', 'Lock owner hostname is invalid');
  isoTimestamp(value.createdAt, 'createdAt');
  isoTimestamp(value.leaseExpiresAt, 'leaseExpiresAt');
  if (Date.parse(value.leaseExpiresAt) < Date.parse(value.createdAt)) {
    throw lockError('LOCK_CORRUPT', 'Lock owner lease expires before it was created');
  }
  if (typeof value.token !== 'string' || !UUID.test(value.token)) throw lockError('LOCK_CORRUPT', 'Lock owner token is invalid');
  return Object.freeze({ ...value });
}

async function readOwner(lockPath, fs) {
  try {
    return await readJson(join(lockPath, 'owner.json'), parseOwner, { fs });
  } catch (error) {
    if (error.code === 'LOCK_CORRUPT') throw error;
    throw lockError('LOCK_CORRUPT', `Cannot validate lock owner at ${lockPath}`, {
      lockPath,
      causeCode: error.code,
      cause: error.message
    });
  }
}

function optionValue(value, fallback) {
  const selected = value ?? fallback;
  return typeof selected === 'function' ? selected() : selected;
}

function held(owner) {
  throw lockError('LOCK_HELD', `Run lock is held by live owner ${owner.runId}`, { owner });
}

async function validateStaleJournal(options, owner, fs) {
  try {
    if (typeof options.validateJournal === 'function') {
      const valid = await options.validateJournal(owner);
      if (valid === false) throw lockError('LOCK_RECOVERY_UNSAFE', 'Journal validator rejected stale-lock recovery');
      return;
    }
    if (options.journalPath && typeof options.journalParser === 'function') {
      const journalPath = typeof options.journalPath === 'function'
        ? options.journalPath(owner)
        : options.journalPath;
      const journal = await readJson(journalPath, options.journalParser, { fs });
      if (journal.runId !== owner.runId) {
        throw lockError('LOCK_RECOVERY_UNSAFE', 'Stale lock and journal run IDs do not match', {
          ownerRunId: owner.runId,
          journalRunId: journal.runId
        });
      }
      return;
    }
    throw lockError('LOCK_RECOVERY_UNSAFE', 'Stale-lock recovery requires journal validation');
  } catch (error) {
    if (error.code === 'LOCK_RECOVERY_UNSAFE') throw error;
    throw lockError('LOCK_RECOVERY_UNSAFE', `Journal validation failed for stale lock ${owner.runId}`, {
      runId: owner.runId,
      causeCode: error.code,
      cause: error.message
    });
  }
}

async function failClosedAfterQuarantine(lockPath, diagnosticPath, cause, fs, {
  code = cause?.code?.startsWith?.('LOCK_') ? cause.code : 'LOCK_RECOVERY_REQUIRED',
  message = cause?.code?.startsWith?.('LOCK_')
    ? cause.message
    : `Lock recovery is required for ${lockPath}`,
  details = {}
} = {}) {
  let reservationCreated = false;
  let reservationError;
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
    reservationCreated = true;
  } catch (error) {
    if (error.code !== 'EEXIST') reservationError = error;
  }

  throw lockError(code, message, {
    ...(cause?.details ?? {}),
    ...details,
    lockPath,
    diagnosticPath,
    reservationPath: lockPath,
    reservationCreated,
    causeCode: cause?.code ?? null,
    cause: cause?.message ?? String(cause),
    ...(reservationError
      ? {
          reservationErrorCode: reservationError.code ?? null,
          reservationError: reservationError.message
        }
      : {})
  });
}

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

async function pathIdentity(path, fs) {
  return identityOf(await fs.lstat(path, { bigint: true }));
}

async function pathHasIdentity(path, identity, fs) {
  if (!identity) return false;
  try {
    const current = await fs.lstat(path, { bigint: true });
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

async function quarantineStaleLock(lockPath, owner, fs, createId) {
  const diagnosticPath = `${lockPath}.stale-${owner.token}-${createId()}`;
  try {
    await fs.rename(lockPath, diagnosticPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  let movedOwner;
  try {
    movedOwner = await readOwner(diagnosticPath, fs);
  } catch (error) {
    await failClosedAfterQuarantine(lockPath, diagnosticPath, error, fs);
  }
  if (movedOwner.token !== owner.token) {
    const error = lockError('LOCK_RACE', 'Lock owner changed while stale recovery was in progress', {
      expectedToken: owner.token,
      actualToken: movedOwner.token
    });
    await failClosedAfterQuarantine(lockPath, diagnosticPath, error, fs);
  }

  // The moved name can be replaced after revalidation. Retain every diagnostic
  // so automated recovery never deletes an entry whose identity is unproven.
  return true;
}

async function cleanFailedAcquisition(lockPath, token, identity, cause, fs, createId) {
  if (identity && !await pathHasIdentity(lockPath, identity, fs)) return;
  const diagnosticPath = `${lockPath}.failed-${token}-${createId()}`;
  try {
    await fs.rename(lockPath, diagnosticPath);
  } catch {
    return;
  }
  if (!identity) {
    await failClosedAfterQuarantine(lockPath, diagnosticPath, cause, fs);
  }
  if (!await pathHasIdentity(diagnosticPath, identity, fs)) {
    await failClosedAfterQuarantine(lockPath, diagnosticPath, cause, fs, {
      message: `Lock recovery is required after failed acquisition at ${lockPath}`
    });
  }
  // Matching identity authorizes removal from the active path, not deletion of
  // the diagnostic name, which can be replaced immediately after this check.
}

export async function acquireRunLock(lockPath, options = {}) {
  const fs = options.fs ?? fileSystem;
  const createId = options.randomUUID ?? randomUUID;
  const localHostname = optionValue(options.hostname, systemHostname);
  const ownerPid = optionValue(options.pid, process.pid);
  const runId = options.runId ?? basename(lockPath).replace(/\.lock$/, '');
  const leaseMs = options.leaseMs ?? 60_000;
  const processKill = options.processKill ?? process.kill.bind(process);

  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw lockError('LOCK_OPTIONS_INVALID', 'leaseMs must be positive');
  await fs.mkdir(dirname(lockPath), { recursive: true });

  for (let race = 0; race < MAX_ACQUIRE_RACES; race += 1) {
    let created = false;
    let createdIdentity;
    let token;
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      created = true;
      token = createId();
      createdIdentity = await pathIdentity(lockPath, fs);
      const createdAt = optionValue(options.now, Date.now);
      const owner = parseOwner({
        runId,
        pid: ownerPid,
        hostname: localHostname,
        createdAt: new Date(createdAt).toISOString(),
        leaseExpiresAt: new Date(createdAt + leaseMs).toISOString(),
        token
      });
      await writeJsonAtomic(join(lockPath, 'owner.json'), owner, { fs, randomUUID: createId });
      return {
        owner,
        release: () => releaseRunLock(lockPath, owner, { fs, randomUUID: createId })
      };
    } catch (error) {
      if (created) {
        await cleanFailedAcquisition(lockPath, token, createdIdentity, error, fs, createId);
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
    }

    const existing = await readOwner(lockPath, fs);
    const now = optionValue(options.now, Date.now);
    let stale = false;
    if (existing.hostname === localHostname) {
      try {
        processKill(existing.pid, 0);
        held(existing);
      } catch (error) {
        if (error.code === 'EPERM') held(existing);
        if (error.code === 'ESRCH') stale = true;
        else if (error.code === 'LOCK_HELD') throw error;
        else {
          throw lockError('LOCK_PROBE_FAILED', `Cannot determine whether PID ${existing.pid} is live`, {
            pid: existing.pid,
            causeCode: error.code,
            cause: error.message
          });
        }
      }
    } else if (now >= Date.parse(existing.leaseExpiresAt)) {
      stale = true;
    } else {
      held(existing);
    }

    if (!stale) held(existing);
    await validateStaleJournal(options, existing, fs);
    await quarantineStaleLock(lockPath, existing, fs, createId);
  }

  throw lockError('LOCK_RACE', `Run lock at ${lockPath} changed too many times during acquisition`, { lockPath });
}

export async function releaseRunLock(lockPath, owner, options = {}) {
  const fs = options.fs ?? fileSystem;
  const createId = options.randomUUID ?? randomUUID;
  const current = await readOwner(lockPath, fs);
  if (!owner || typeof owner.token !== 'string' || current.token !== owner.token) {
    throw lockError('LOCK_OWNER_MISMATCH', 'Lock owner token does not match the current owner', {
      expectedToken: current.token,
      actualToken: owner?.token ?? null
    });
  }

  const diagnosticPath = `${lockPath}.release-${owner.token}-${createId()}`;
  try {
    await fs.rename(lockPath, diagnosticPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw lockError('LOCK_OWNER_MISMATCH', 'Lock disappeared before its owner could release it', { lockPath });
    }
    throw error;
  }

  let moved;
  try {
    moved = await readOwner(diagnosticPath, fs);
  } catch (error) {
    await failClosedAfterQuarantine(lockPath, diagnosticPath, error, fs);
  }
  if (moved.token !== owner.token) {
    const error = lockError('LOCK_OWNER_MISMATCH', 'Lock owner changed while release was in progress', {
      expectedToken: owner.token,
      actualToken: moved.token
    });
    await failClosedAfterQuarantine(lockPath, diagnosticPath, error, fs);
  }
  // Successful release frees lockPath atomically but retains the moved entry.
  // A future lock-protected maintenance operation may remove diagnostics.
}
