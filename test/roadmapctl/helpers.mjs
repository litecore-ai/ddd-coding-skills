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
