import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function gitFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roadmapctl-git-')));
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const runGit = async args => execFileAsync('git', args, {
    cwd: root,
    env: environment,
    encoding: 'utf8'
  });

  await runGit(['init', '--initial-branch=main']);
  await runGit(['config', '--local', 'user.name', 'Roadmap Fixture']);
  await runGit(['config', '--local', 'user.email', 'roadmap-fixture@example.invalid']);
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await runGit(['add', '--', 'README.md']);
  await runGit(['commit', '-m', 'test: initial commit']);

  return {
    root,
    git: runGit,
    write: async (path, contents) => {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    },
    read: path => readFile(join(root, path), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

export function validSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'P1.1',
    title: 'Profile',
    status: 'approved',
    acceptanceCriteria: [
      { id: 'AC-P1.1-001', given: 'no profile exists', when: 'a valid profile is created', then: 'it can be retrieved' }
    ],
    sharedContracts: [],
    consumers: ['ProfileController'],
    ...overrides
  };
}

export function validRoadmap(overrides = {}) {
  return {
    schemaVersion: 1,
    project: 'fixture',
    revision: 0,
    nodes: [
      { id: 'P1', kind: 'phase', title: 'Core' },
      { id: 'P1.1', kind: 'feature', parentId: 'P1', title: 'Profile' },
      {
        id: 'P1.1.1', kind: 'item', parentId: 'P1.1', title: 'Profile flow',
        outcome: 'A user can create and retrieve a profile', dependsOn: [],
        spec: { path: 'docs/specs/P1.1-profile.json', hash: 'sha256:' + '0'.repeat(64), acceptanceCriteria: ['AC-P1.1-001'] },
        consumers: ['ProfileController'], requiredGates: ['spec', 'tests', 'consumer', 'e2e', 'audit'], status: 'planned'
      }
    ],
    gates: {
      tests: { type: 'command', executable: 'node', args: ['--test'], cwd: '.' },
      consumer: { type: 'command', executable: 'node', args: ['--test', 'test/consumer.test.mjs'], cwd: '.' },
      e2e: { type: 'command', executable: 'node', args: ['--test', 'test/e2e.test.mjs'], cwd: '.' },
      audit: { type: 'attestation', producer: 'ddd-audit', schema: 'ddd-audit/v1' }
    },
    ...overrides
  };
}

export function validTransaction(overrides = {}) {
  return {
    id: 'tx-550e8400-e29b-41d4-a716-446655440000',
    type: 'settle-item',
    state: 'prepared',
    expectedRoadmapRevision: 4,
    itemId: 'P1.1.1',
    targetState: 'done',
    implementationSha: '0'.repeat(40),
    allowedPaths: ['docs/roadmap/roadmap.json', 'docs/roadmap/roadmap.md'],
    bookkeepingSha: null,
    ...overrides
  };
}

export function validRun(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 0,
    runId: 'r1',
    status: 'active',
    pendingTransaction: null,
    ...overrides
  };
}
