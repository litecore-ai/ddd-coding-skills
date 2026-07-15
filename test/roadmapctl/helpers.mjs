import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { specHash } from '../../src/roadmapctl/canonical-json.mjs';

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
      {
        id: 'AC-P1.1-001', covers: ['P1.1.1'], given: 'no profile exists',
        when: 'a valid profile is created', then: 'it can be retrieved'
      }
    ],
    models: [{
      name: 'Profile',
      kind: 'aggregate',
      fields: [
        { name: 'id', type: 'ProfileId', required: true, constraints: ['immutable'] },
        { name: 'displayName', type: 'string', required: true, constraints: ['length:1..100'] }
      ]
    }],
    contracts: [
      {
        name: 'ProfileRepository', kind: 'repository', operation: 'save-and-find-by-id',
        input: 'Profile', output: 'Profile|null', errors: ['storage-unavailable']
      },
      {
        name: 'ProfileController', kind: 'api', operation: 'POST/GET /profiles',
        input: 'ProfileRequest', output: 'ProfileResponse', errors: ['invalid-profile', 'profile-not-found']
      }
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
      tests: { type: 'command', executable: 'node', args: ['--test'], cwd: '.', timeoutMs: 30_000 },
      consumer: { type: 'command', executable: 'node', args: ['--test', 'test/consumer.test.mjs'], cwd: '.', timeoutMs: 30_000 },
      e2e: { type: 'command', executable: 'node', args: ['--test', 'test/e2e.test.mjs'], cwd: '.', timeoutMs: 30_000 },
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
    selector: 'P1.1.1',
    scope: ['P1.1.1'],
    originalBranch: 'main',
    runBranch: 'ddd/run/r1',
    baselineSha: '0'.repeat(40),
    manifestAuthorization: { mode: 'sandboxed', hash: `sha256:${'0'.repeat(64)}` },
    maxAttemptsPerItem: 3,
    currentItemId: null,
    attempts: {},
    events: [],
    pendingTransaction: null,
    ...overrides
  };
}

export function auditReportPathFor(runId, itemId, attemptNumber = 1) {
  return `.ddd/audit-${runId}-${itemId}-attempt-${attemptNumber}.json`;
}

export function auditInputReport({
  runId,
  itemId,
  bindings,
  counts = { CRIT: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
}) {
  const findings = [];
  for (const severity of ['CRIT', 'HIGH', 'MEDIUM', 'LOW']) {
    for (let index = 1; index <= counts[severity]; index += 1) {
      findings.push({
        id: `TEST-${severity}-${String(index).padStart(3, '0')}`,
        severity,
        file: 'src/audit-fixture.mjs',
        line: index,
        message: `${severity} fixture finding ${index}`
      });
    }
  }
  return {
    schemaVersion: 1,
    schema: 'ddd-audit/v1',
    runId,
    itemId,
    baselineSha: bindings.itemBaselineSha,
    implementationSha: bindings.implementationSha,
    specHash: bindings.specHash,
    counts: { ...counts },
    findings
  };
}

export function twoLeafRoadmap({ first = 'planned', second = 'planned' } = {}) {
  const roadmap = validRoadmap();
  roadmap.nodes[2].status = first;
  roadmap.nodes.push({
    ...roadmap.nodes[2],
    id: 'P1.1.2',
    title: 'Profile update',
    outcome: 'A user can update a profile',
    status: second
  });
  return roadmap;
}

export function p11SevenLeafSpec() {
  return validSpec({
    acceptanceCriteria: Array.from({ length: 7 }, (_, index) => {
      const leaf = index + 1;
      return {
        id: `AC-P1.1-00${leaf}`,
        covers: [`P1.1.${leaf}`],
        given: `P1.1.${leaf} has not been completed`,
        when: `the P1.1.${leaf} workflow succeeds`,
        then: `the P1.1.${leaf} outcome is observable by its consumer`
      };
    })
  });
}

export function p11SevenLeafRoadmap() {
  const roadmap = validRoadmap();
  const template = roadmap.nodes[2];
  roadmap.nodes = [
    roadmap.nodes[0],
    roadmap.nodes[1],
    ...Array.from({ length: 7 }, (_, index) => {
      const leaf = index + 1;
      return {
        ...template,
        id: `P1.1.${leaf}`,
        title: `Profile workflow ${leaf}`,
        outcome: `Profile workflow ${leaf} is complete end to end`,
        dependsOn: leaf === 1 ? [] : [`P1.1.${leaf - 1}`],
        spec: {
          ...template.spec,
          acceptanceCriteria: [`AC-P1.1-00${leaf}`]
        },
        consumers: ['ProfileController'],
        requiredGates: ['spec', 'tests', 'consumer', 'e2e', 'audit'],
        status: 'planned'
      };
    })
  ];
  return roadmap;
}

export async function roadmapFixture(roadmap = validRoadmap()) {
  const repo = await gitFixture();
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(validSpec(), null, 2)}\n`);
  return repo;
}

export async function specBindingFixture() {
  const repo = await gitFixture();
  const roadmap = twoLeafRoadmap({ first: 'done', second: 'blocked' });
  roadmap.nodes[2].spec.acceptanceCriteria = ['AC-P1.1-099'];
  roadmap.nodes[3].spec.acceptanceCriteria = ['AC-P1.1-099'];
  const spec = validSpec({
    acceptanceCriteria: [
      {
        id: 'AC-P1.1-001',
        covers: ['P1.1.1'],
        given: 'no profile exists',
        when: 'a valid profile is created',
        then: 'it can be retrieved'
      },
      {
        id: 'AC-P1.1-002',
        covers: ['P1.1.2'],
        given: 'a profile exists',
        when: 'the profile is updated',
        then: 'the updated profile can be retrieved'
      }
    ],
    models: validSpec().models,
    contracts: validSpec().contracts,
    sharedContracts: []
  });

  await repo.write('.gitignore', '.ddd/\n');
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(spec, null, 2)}\n`);
  await repo.git(['add', '--', '.gitignore', 'docs/roadmap/roadmap.json', 'docs/specs/P1.1-profile.json']);
  await repo.git(['commit', '-m', 'test: add unbound spec fixture']);

  async function cli(args) {
    const result = await runCli(repo.root, args);
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || `roadmapctl exited ${result.exitCode}`);
      error.exitCode = result.exitCode;
      error.diagnostic = result.stderr ? JSON.parse(result.stderr) : null;
      throw error;
    }
    assertEmpty(result.stderr);
    return JSON.parse(result.stdout);
  }

  return { ...repo, cli, rawCli: args => runCli(repo.root, args), spec };
}

export function runCli(root, args) {
  const bin = fileURLToPath(new URL('../../bin/roadmapctl.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--root', root, ...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

export async function lifecycleFixture(options = {}) {
  const repo = await gitFixture();
  const spec = structuredClone(options.spec ?? validSpec());
  const roadmap = structuredClone(options.roadmap ?? twoLeafRoadmap());
  if (options.roadmap === undefined) roadmap.nodes[3].dependsOn = ['P1.1.1'];
  const items = roadmap.nodes.filter(node => node.kind === 'item');
  for (const criterion of spec.acceptanceCriteria) {
    criterion.covers = items
      .filter(item => item.spec.acceptanceCriteria.includes(criterion.id))
      .map(item => item.id);
  }
  for (const item of items) {
    item.spec.hash = specHash(spec);
  }

  await repo.write('.gitignore', '.ddd/\n');
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.write('docs/specs/P1.1-profile.json', `${JSON.stringify(spec, null, 2)}\n`);
  await repo.write('test/gate-pass.mjs', "process.stdout.write('ok\\n');\n");
  for (const gate of ['tests', 'consumer', 'e2e']) {
    roadmap.gates[gate] = {
      type: 'command',
      executable: process.execPath,
      args: ['test/gate-pass.mjs'],
      cwd: '.',
      timeoutMs: 5_000
    };
  }
  await repo.write('docs/roadmap/roadmap.json', `${JSON.stringify(roadmap, null, 2)}\n`);
  await repo.git(['add', '--', '.gitignore', 'docs/roadmap/roadmap.json', 'docs/specs/P1.1-profile.json', 'test/gate-pass.mjs']);
  await repo.git(['commit', '-m', 'test: add lifecycle fixture']);

  async function cli(args) {
    const result = await runCli(repo.root, args);
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || `roadmapctl exited ${result.exitCode}`);
      error.exitCode = result.exitCode;
      error.diagnostic = result.stderr ? JSON.parse(result.stderr) : null;
      throw error;
    }
    assertEmpty(result.stderr);
    return JSON.parse(result.stdout);
  }

  return {
    ...repo,
    cli,
    rawCli: args => runCli(repo.root, args),
    implementationCommit: async (path, contents) => {
      await repo.write(path, contents);
      await repo.git(['add', '--', path]);
      await repo.git(['commit', '-m', `feat: implement ${path}`]);
      return (await repo.git(['rev-parse', 'HEAD'])).stdout.trim();
    }
  };
}

export function p11SevenLeafLifecycleFixture() {
  return lifecycleFixture({
    roadmap: p11SevenLeafRoadmap(),
    spec: p11SevenLeafSpec()
  });
}

function assertEmpty(value) {
  if (value !== '') throw new Error(`unexpected stderr: ${value}`);
}
