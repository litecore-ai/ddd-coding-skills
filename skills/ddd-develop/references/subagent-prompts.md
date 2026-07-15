# Optional Bounded Worker Prompts

GPT-5.6 Sol normally implements one leaf directly. Use a worker only when the host supports isolation and parallel work is materially useful. The parent retains controller authority, exact run/item context, file writes that span workers, the implementation commit, evidence submission, and final settlement.

## Implementation worker

```text
Implement one bounded vertical slice.

Controller-issued item/spec/AC contract:
[paste the exact item, approved spec, AC IDs, baseline SHA, and declared consumers]

Relevant repository conventions:
[paste exact paths or concise observations]

Requirements:
- Work only within this leaf.
- Follow TDD: prove RED, implement GREEN, then refactor.
- Preserve ubiquitous language, aggregate invariants, dependency direction, and public error semantics.
- Wire the declared real consumer and required persistence/delivery adapters in the same slice.
- Do not change roadmap/controller/evidence files or broaden the task.
- Do not perform external or destructive actions.
- Return files changed, tests run with results, unresolved blockers, and any contract mismatch.
```

The parent reads the actual diff and test results. A worker report is not completion evidence.

## Read-only specification reviewer

```text
Review the supplied implementation against this exact item/spec/AC contract.

Contract:
[paste controller-issued context]

Implementation range:
[paste itemBaselineSha..implementationSha]

Read the code and tests. Report only concrete missing behavior, extra scope, contract incompatibility, disconnected consumers, or false-positive tests with repository-relative file and line. Do not modify files or controller state.
```

The parent resolves every finding before calling controller verification or audit. Workers never select the next leaf and never convert concerns into a success state.
