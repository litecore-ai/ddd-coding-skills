import { randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalStringify } from './canonical-json.mjs';
import { RoadmapError } from './errors.mjs';
import { parseRun } from './schema.mjs';

async function synchronizeDirectory(directory, fs) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported uniformly. The attempt is best effort.
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The write and rename have already completed; close is best effort here.
      }
    }
  }
}

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino };
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

export async function readJson(path, parser, { fs = fileSystem } = {}) {
  const source = await fs.readFile(path, 'utf8');
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new RoadmapError('STATE_CORRUPT', `JSON state at ${path} is corrupt`, {
      path,
      cause: error.message
    });
  }
  return parser(value);
}

export async function writeJsonAtomic(path, value, {
  fs = fileSystem,
  randomUUID: createId = randomUUID
} = {}) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `${basename(path)}.tmp-${createId()}`);
  let handle;
  let temporaryIdentity;

  await fs.mkdir(directory, { recursive: true });
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    temporaryIdentity = identityOf(await handle.stat({ bigint: true }));
    await handle.writeFile(canonicalStringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, path);
    temporaryIdentity = undefined;
    await synchronizeDirectory(directory, fs);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary persistence failure.
      }
    }
    if (await pathHasIdentity(temporaryPath, temporaryIdentity, fs)) {
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch {
        // Never broaden cleanup beyond the temporary path owned by this call.
      }
    }
    throw error;
  }
}

export async function mutateRevision(path, parser, expectedRevision, mutator, options = {}) {
  const current = await readJson(path, parser, options);
  if (current.revision !== expectedRevision) {
    throw new RoadmapError(
      'REVISION_CONFLICT',
      `Revision conflict for ${path}: expected ${expectedRevision}, found ${current.revision}`,
      { path, expectedRevision, actualRevision: current.revision }
    );
  }

  const nextRevision = current.revision + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    throw new RoadmapError(
      'REVISION_OVERFLOW',
      `Revision ${current.revision} for ${path} cannot be incremented safely`,
      { path, revision: current.revision }
    );
  }

  const proposed = await mutator(current);
  const updated = parser({ ...proposed, revision: nextRevision });
  await writeJsonAtomic(path, updated, options);
  return updated;
}

function sameTransaction(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function transactionConflict(message, details = {}) {
  throw new RoadmapError('TRANSACTION_CONFLICT', message, details);
}

export function beginTransaction(run, transaction) {
  if (transaction === null || transaction === undefined) {
    throw new RoadmapError('TRANSACTION_INVALID', 'Transaction must be a defined object');
  }
  const parsedRun = parseRun(run);
  const validated = parseRun({ ...parsedRun, pendingTransaction: transaction }).pendingTransaction;
  const current = parsedRun.pendingTransaction;

  if (current) {
    if (current.id === validated.id && sameTransaction(current, validated)) return run;
    if (current.id === validated.id) {
      transactionConflict(`Transaction ${current.id} cannot be changed after it is recorded`, {
        currentId: current.id,
        requestedId: validated.id,
        currentState: current.state,
        requestedState: validated.state
      });
    }
    if (current.state === 'prepared') {
      transactionConflict(`Transaction ${current.id} is already prepared`, {
        currentId: current.id,
        requestedId: validated.id
      });
    }
  }

  if (validated.state !== 'prepared') {
    throw new RoadmapError('TRANSACTION_INVALID', 'A new transaction must begin in the prepared state', {
      id: validated.id,
      state: validated.state
    });
  }

  return parseRun({ ...parsedRun, pendingTransaction: validated });
}

export function commitTransaction(run, id) {
  const parsedRun = parseRun(run);
  const current = parsedRun.pendingTransaction;
  if (!current || current.id !== id) {
    transactionConflict(`Transaction ${id} is not the pending transaction`, {
      currentId: current?.id ?? null,
      requestedId: id
    });
  }
  if (current.state === 'committed') return run;
  if (current.bookkeepingSha === null) {
    throw new RoadmapError(
      'TRANSACTION_INCOMPLETE',
      `Transaction ${id} cannot commit before its bookkeeping SHA is recorded`,
      { id }
    );
  }
  return parseRun({
    ...parsedRun,
    pendingTransaction: { ...current, state: 'committed' }
  });
}
