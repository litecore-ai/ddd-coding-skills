import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GitError,
  assertClean,
  assertImplementationCommit,
  changedFiles,
  commitGenerated,
  git,
  prepareRunBranch,
  repositoryState
} from '../../src/roadmapctl/git.mjs';
import { gitFixture } from './helpers.mjs';

test('repository state describes a clean normal checkout', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);

  const state = await repositoryState(repo.root);

  assert.equal(state.root, repo.root);
  assert.match(state.head, /^[0-9a-f]{40}$/);
  assert.equal(state.branch, 'main');
  assert.equal(state.clean, true);
  assert.equal(state.linkedWorktree, false);
  assert.equal(state.gitDir, join(repo.root, '.git'));
  assert.equal(state.commonDir, state.gitDir);
});

test('prepareRunBranch creates and checks out the deterministic run branch', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);

  const state = await prepareRunBranch(repo.root, '20260714T050000Z-a1b2c3d4');

  assert.equal(state.branch, 'ddd/run/20260714T050000Z-a1b2c3d4');
  assert.equal((await repo.git(['branch', '--show-current'])).stdout.trim(), state.branch);
});

test('prepareRunBranch retains the current branch in a linked worktree', async t => {
  const repo = await gitFixture();
  const linkedRoot = await mkdtemp(join(tmpdir(), 'roadmapctl-linked-'));
  await rm(linkedRoot, { recursive: true, force: true });
  t.after(async () => {
    await repo.git(['worktree', 'remove', '--force', linkedRoot]).catch(() => {});
    await rm(linkedRoot, { recursive: true, force: true });
    await repo.cleanup();
  });
  await repo.git(['worktree', 'add', '-b', 'worktree/active', linkedRoot]);

  const state = await prepareRunBranch(linkedRoot, '20260714T050000Z-a1b2c3d4');

  assert.equal(state.linkedWorktree, true);
  assert.equal(state.branch, 'worktree/active');
  assert.equal((await repo.git(['branch', '--list', 'ddd/run/*'])).stdout.trim(), '');
});

test('detached HEAD and dirty worktrees are rejected', async t => {
  const detached = await gitFixture();
  const dirty = await gitFixture();
  t.after(detached.cleanup);
  t.after(dirty.cleanup);
  await detached.git(['checkout', '--detach']);
  await dirty.write('dirty.txt', 'mine\n');

  await assert.rejects(
    () => prepareRunBranch(detached.root, '20260714T050000Z-a1b2c3d4'),
    error => error.code === 'DETACHED_HEAD'
  );
  await assert.rejects(() => assertClean(dirty.root), error => error.code === 'DIRTY_WORKTREE');
});

test('implementation commits must be non-empty descendants of baseline', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  const baseline = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  await repo.write('feature-a.txt', 'a\n');
  await repo.git(['add', '--', 'feature-a.txt']);
  await repo.git(['commit', '-m', 'feat: a']);
  const commitA = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();

  assert.equal(
    await assertImplementationCommit(repo.root, { baseline, commit: commitA, runBranch: 'main' }),
    commitA
  );

  await repo.git(['reset', '--hard', baseline]);
  await repo.write('feature-b.txt', 'b\n');
  await repo.git(['add', '--', 'feature-b.txt']);
  await repo.git(['commit', '-m', 'feat: b']);
  const commitB = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    () => assertImplementationCommit(repo.root, { baseline: commitB, commit: commitA, runBranch: 'main' }),
    error => error.code === 'IMPLEMENTATION_NOT_DESCENDANT'
  );

  await repo.git(['commit', '--allow-empty', '-m', 'test: empty']);
  const empty = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    () => assertImplementationCommit(repo.root, { baseline, commit: empty, runBranch: 'main' }),
    error => error.code === 'EMPTY_IMPLEMENTATION'
  );
});

test('implementation commit explicitly rejects the resolved baseline itself', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  await repo.write('prior-change.txt', 'already changed\n');
  await repo.git(['add', '--', 'prior-change.txt']);
  await repo.git(['commit', '-m', 'feat: prior change']);
  const nonRootBaseline = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();

  await assert.rejects(
    () => assertImplementationCommit(repo.root, {
      baseline: nonRootBaseline,
      commit: nonRootBaseline,
      runBranch: 'main'
    }),
    error => error instanceof GitError && error.code === 'IMPLEMENTATION_EQUALS_BASELINE'
  );
});

test('changedFiles returns the exact baseline-to-commit paths including unusual names', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  const baseline = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
  await repo.write('path with spaces.txt', 'space\n');
  await repo.write('-leading-dash.txt', 'dash\n');
  await repo.git(['add', '--', 'path with spaces.txt', '-leading-dash.txt']);
  await repo.git(['commit', '-m', 'test: unusual paths']);
  const commit = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();

  assert.deepEqual(await changedFiles(repo.root, baseline, commit), [
    '-leading-dash.txt',
    'path with spaces.txt'
  ]);
});

test('changedFiles reports both rename endpoints regardless of rename configuration', async t => {
  for (const renames of ['true', 'false']) {
    await t.test(`diff.renames=${renames}`, async t => {
      const repo = await gitFixture();
      t.after(repo.cleanup);
      await repo.write('old name with spaces.txt', 'content\n');
      await repo.git(['add', '--', 'old name with spaces.txt']);
      await repo.git(['commit', '-m', 'test: add rename source']);
      const baseline = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
      await repo.git(['mv', 'old name with spaces.txt', 'new name with spaces.txt']);
      await repo.git(['commit', '-m', 'test: rename file']);
      const commit = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
      await repo.git(['config', '--local', 'diff.renames', renames]);

      assert.deepEqual(await changedFiles(repo.root, baseline, commit), [
        'new name with spaces.txt',
        'old name with spaces.txt'
      ]);
    });
  }
});

test('changedFiles overrides global rename configuration deterministically', async t => {
  for (const renames of ['true', 'false']) {
    await t.test(`global diff.renames=${renames}`, async t => {
      const repo = await gitFixture();
      t.after(repo.cleanup);
      await repo.write('global old name.txt', 'content\n');
      await repo.git(['add', '--', 'global old name.txt']);
      await repo.git(['commit', '-m', 'test: add global rename source']);
      const baseline = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
      await repo.git(['mv', 'global old name.txt', 'global new name.txt']);
      await repo.git(['commit', '-m', 'test: global rename file']);
      const commit = (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
      const configPath = join(repo.root, '.test-global-gitconfig');
      await repo.write('.test-global-gitconfig', `[diff]\n\trenames = ${renames}\n`);
      const previousConfig = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = configPath;
      try {
        assert.deepEqual(await changedFiles(repo.root, baseline, commit), [
          'global new name.txt',
          'global old name.txt'
        ]);
      } finally {
        if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousConfig;
      }
    });
  }
});

test('commitGenerated explicitly stages allowlisted paths and suppresses hooks', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  await repo.write('docs/roadmap/roadmap file.json', '{}\n');
  await repo.write('-generated.json', '{}\n');
  await repo.write('.git/hooks/pre-commit', '#!/bin/sh\nexit 91\n');
  await chmod(join(repo.root, '.git/hooks/pre-commit'), 0o755);

  const commit = await commitGenerated(repo.root, {
    paths: ['docs/roadmap/roadmap file.json', '-generated.json'],
    message: 'chore(roadmap): settle P1.1.1'
  });

  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(await changedFiles(repo.root, `${commit}^`, commit), [
    '-generated.json',
    'docs/roadmap/roadmap file.json'
  ]);
  assert.equal((await repo.git(['status', '--porcelain=v1'])).stdout, '');
});

test('generated commit never sweeps unrelated files', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  await repo.write('docs/roadmap/roadmap.json', '{}\n');
  await repo.write('user-note.txt', 'mine\n');
  await assert.rejects(
    () => commitGenerated(repo.root, { paths: ['docs/roadmap/roadmap.json'], message: 'chore(roadmap): settle P1.1.1' }),
    error => error.code === 'DIRTY_WORKTREE'
  );
  assert.equal(await repo.read('user-note.txt'), 'mine\n');
  assert.equal((await repo.git(['log', '--format=%s', '-1'])).stdout.trim(), 'test: initial commit');
});

test('generated paths reject non-canonical and cross-platform ambiguous aliases before staging', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  await repo.write('generated/file.json', '{}\n');
  const invalidPathLists = [
    [''],
    ['bad\0path'],
    ['/absolute/file.json'],
    ['.'],
    ['..'],
    ['../escape.json'],
    ['./generated/file.json'],
    ['generated/../file.json'],
    ['generated/./file.json'],
    ['generated//file.json'],
    ['generated/file.json/'],
    ['generated\\file.json'],
    ['C:/generated/file.json'],
    ['generated/file.json', 'generated/file.json']
  ];

  for (const paths of invalidPathLists) {
    await assert.rejects(
      () => commitGenerated(repo.root, { paths, message: 'test: invalid generated path' }),
      error => error instanceof GitError && error.code === 'INVALID_GENERATED_PATHS'
    );
  }
  assert.equal((await repo.git(['diff', '--cached', '--name-only'])).stdout, '');
});

test('generated paths reject an existing directory instead of recursively staging it', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);
  await repo.write('generated-dir/nested.json', '{}\n');

  await assert.rejects(
    () => commitGenerated(repo.root, { paths: ['generated-dir'], message: 'test: directory path' }),
    error => error instanceof GitError && error.code === 'INVALID_GENERATED_PATHS'
  );
  assert.equal((await repo.git(['diff', '--cached', '--name-only'])).stdout, '');
});

test('generated commits treat pathspec magic literally and allow deleted files', async t => {
  const literal = await gitFixture();
  const deleted = await gitFixture();
  t.after(literal.cleanup);
  t.after(deleted.cleanup);

  await literal.write(':(glob)literal*.json', 'literal\n');
  const literalCommit = await commitGenerated(literal.root, {
    paths: [':(glob)literal*.json'],
    message: 'test: literal pathspec'
  });
  assert.deepEqual(await changedFiles(literal.root, `${literalCommit}^`, literalCommit), [':(glob)literal*.json']);

  await deleted.write('obsolete file.txt', 'remove me\n');
  await deleted.git(['add', '--', 'obsolete file.txt']);
  await deleted.git(['commit', '-m', 'test: add obsolete file']);
  await rm(join(deleted.root, 'obsolete file.txt'));
  const deletionCommit = await commitGenerated(deleted.root, {
    paths: ['obsolete file.txt'],
    message: 'test: delete obsolete file'
  });
  assert.deepEqual(await changedFiles(deleted.root, `${deletionCommit}^`, deletionCommit), ['obsolete file.txt']);
});

test('git failures are typed and retain process evidence', async t => {
  const repo = await gitFixture();
  t.after(repo.cleanup);

  await assert.rejects(
    () => git(repo.root, ['rev-parse', '--verify', 'definitely-missing']),
    error => {
      assert.ok(error instanceof GitError);
      assert.equal(error.code, 'GIT_COMMAND_FAILED');
      assert.deepEqual(error.args, ['rev-parse', '--verify', 'definitely-missing']);
      assert.equal(typeof error.stderr, 'string');
      return true;
    }
  );
});
