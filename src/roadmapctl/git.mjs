import { execFile } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(message, { code = 'GIT_ERROR', args = [], stdout = '', stderr = '', exitCode, cause } = {}) {
    super(message, { cause });
    this.name = 'GitError';
    this.code = code;
    this.args = [...args];
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

function stateError(code, message, details = {}) {
  return new GitError(message, { code, ...details });
}

export async function git(root, args, options = {}) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw stateError('INVALID_GIT_ARGUMENTS', 'Git arguments must be an array of strings');
  }

  try {
    return await execFileAsync('git', args, {
      ...options,
      cwd: root,
      encoding: 'utf8',
      shell: false
    });
  } catch (cause) {
    throw new GitError(`git ${args[0] ?? ''} failed`, {
      code: 'GIT_COMMAND_FAILED',
      args,
      stdout: cause.stdout ?? '',
      stderr: cause.stderr ?? '',
      exitCode: cause.code,
      cause
    });
  }
}

async function output(root, args) {
  return (await git(root, args)).stdout.trim();
}

export async function repositoryState(root) {
  const [repositoryRoot, head, branchName, gitDir, commonDir, status] = await Promise.all([
    output(root, ['rev-parse', '--show-toplevel']),
    output(root, ['rev-parse', 'HEAD']),
    output(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    output(root, ['rev-parse', '--absolute-git-dir']),
    output(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  ]);

  const absoluteGitDir = resolve(gitDir);
  const absoluteCommonDir = resolve(commonDir);
  return {
    root: resolve(repositoryRoot),
    head,
    branch: branchName === 'HEAD' ? null : branchName,
    gitDir: absoluteGitDir,
    commonDir: absoluteCommonDir,
    linkedWorktree: absoluteGitDir !== absoluteCommonDir,
    clean: status.stdout.length === 0
  };
}

export async function assertClean(root) {
  const state = await repositoryState(root);
  if (!state.clean) {
    throw stateError('DIRTY_WORKTREE', 'The Git worktree contains uncommitted changes');
  }
  return state;
}

export async function prepareRunBranch(root, runId) {
  const state = await assertClean(root);
  if (state.branch === null) {
    throw stateError('DETACHED_HEAD', 'A roadmap run cannot start from detached HEAD');
  }
  if (state.linkedWorktree) {
    return state;
  }

  const runBranch = `ddd/run/${runId}`;
  if (state.branch !== runBranch) {
    await git(root, ['switch', '-c', runBranch]);
  }
  return repositoryState(root);
}

async function resolveCommit(root, revision) {
  try {
    return await output(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  } catch (error) {
    if (error instanceof GitError) {
      throw stateError('INVALID_COMMIT', `Not a commit: ${revision}`, {
        args: error.args,
        stdout: error.stdout,
        stderr: error.stderr,
        exitCode: error.exitCode,
        cause: error
      });
    }
    throw error;
  }
}

async function isAncestor(root, ancestor, descendant) {
  try {
    await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) {
      return false;
    }
    throw error;
  }
}

export async function assertImplementationCommit(root, { baseline, commit, runBranch }) {
  const state = await assertClean(root);
  if (state.branch === null) {
    throw stateError('DETACHED_HEAD', 'Implementation evidence cannot be verified from detached HEAD');
  }
  if (state.branch !== runBranch) {
    throw stateError('RUN_BRANCH_MISMATCH', `Expected run branch ${runBranch}, found ${state.branch}`);
  }

  const baselineSha = await resolveCommit(root, baseline);
  const commitSha = await resolveCommit(root, commit);
  if (baselineSha === commitSha) {
    throw stateError('IMPLEMENTATION_EQUALS_BASELINE', 'The implementation commit must differ from the baseline');
  }
  const branchSha = await resolveCommit(root, runBranch);
  if (!await isAncestor(root, baselineSha, commitSha) || !await isAncestor(root, commitSha, branchSha)) {
    throw stateError(
      'IMPLEMENTATION_NOT_DESCENDANT',
      'The implementation commit must descend from the baseline and belong to the run branch'
    );
  }
  const commitChanges = await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitSha]);
  if (commitChanges.stdout.length === 0) {
    throw stateError('EMPTY_IMPLEMENTATION', 'The implementation commit changes no files');
  }
  return commitSha;
}

export async function changedFiles(root, baseline, commit) {
  const result = await git(root, [
    '--literal-pathspecs',
    '-c',
    'diff.renames=false',
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    baseline,
    commit,
    '--'
  ]);
  return result.stdout.split('\0').filter(Boolean).sort();
}

function dirtyPaths(porcelain) {
  const fields = porcelain.split('\0');
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const originalPath = fields[index + 1];
      if (originalPath) paths.push(originalPath);
      index += 1;
    }
  }
  return paths;
}

function stagedPaths(porcelain) {
  const fields = porcelain.split('\0');
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    if (status[0] !== ' ' && status[0] !== '?') paths.push(field.slice(3));
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return paths;
}

function invalidGeneratedPaths(message) {
  return stateError('INVALID_GENERATED_PATHS', message);
}

async function validateGeneratedPaths(root, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw invalidGeneratedPaths('Generated paths must be a non-empty array');
  }

  const seen = new Set();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.includes('\0') ||
      path.includes('\\') ||
      posix.isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path === '.' ||
      path === '..' ||
      posix.normalize(path) !== path ||
      path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
      seen.has(path)
    ) {
      throw invalidGeneratedPaths(`Generated path is not canonical and repository-relative: ${String(path)}`);
    }
    seen.add(path);

    try {
      const metadata = await lstat(join(root, path));
      if (metadata.isDirectory()) {
        throw invalidGeneratedPaths(`Generated path names a directory: ${path}`);
      }
    } catch (error) {
      if (error instanceof GitError) throw error;
      if (error.code !== 'ENOENT') {
        throw invalidGeneratedPaths(`Generated path cannot be validated: ${path}`);
      }
    }
  }
  return [...paths];
}

export async function assertGeneratedWorktree(root, paths) {
  const allowedPaths = await validateGeneratedPaths(root, paths);
  const allowed = new Set(allowedPaths);
  const state = await repositoryState(root);
  if (state.branch === null) {
    throw stateError('DETACHED_HEAD', 'Generated files cannot be committed from detached HEAD');
  }

  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const staged = stagedPaths(status.stdout);
  if (staged.length > 0) {
    throw stateError('STAGED_WORKTREE', `Generated commit requires an empty index: ${staged.join(', ')}`);
  }
  const unrelated = dirtyPaths(status.stdout).filter(path => !allowed.has(path));
  if (unrelated.length > 0) {
    throw stateError('DIRTY_WORKTREE', `Dirty paths are outside the generated allowlist: ${unrelated.join(', ')}`);
  }
  return { allowedPaths, state };
}

export async function commitGenerated(root, { paths, message }) {
  const { allowedPaths, state } = await assertGeneratedWorktree(root, paths);
  const allowed = new Set(allowedPaths);

  const baseline = state.head;
  await git(root, ['--literal-pathspecs', 'add', '--', ...allowedPaths]);
  const emptyHooksDir = await mkdtemp(join(tmpdir(), 'roadmapctl-empty-hooks-'));
  try {
    await git(root, ['-c', `core.hooksPath=${emptyHooksDir}`, 'commit', '-m', message]);
  } finally {
    await rm(emptyHooksDir, { recursive: true, force: true });
  }

  const commit = await output(root, ['rev-parse', 'HEAD']);
  const committedPaths = await changedFiles(root, baseline, commit);
  if (committedPaths.length === 0 || committedPaths.some(path => !allowed.has(path))) {
    throw stateError('COMMIT_PATH_MISMATCH', 'Generated commit changed paths outside its allowlist');
  }
  await assertClean(root);
  return commit;
}
