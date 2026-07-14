# Deterministic Roadmap Core Design

> **Date**: 2026-07-14
> **Status**: Approved
> **Authors**: Terry Zhang + Codex
> **Scope**: Phase 1 of the ddd-coding-skills repair program
> **Compatibility**: No backward compatibility with Markdown-only roadmaps or legacy ddd-auto state

## Summary

Replace prompt-driven roadmap execution with a deterministic, zero-dependency Node.js controller named `roadmapctl`. The controller becomes the only component allowed to select executable work, transition item state, accept verification evidence, and mark work complete. Codex and Claude Code remain first-class execution platforms, but their skills and hooks become thin adapters over the same controller.

This phase fixes the failure mode where a command scoped to `P1.1` implements one checkbox and later marks the entire heading complete. It also removes warning-based pseudo-completion, prevents stale specs and missing consumers from passing completion, preserves interrupted-run evidence, and removes broad automatic shell permissions.

The deterministic core can prove that declared gates ran against a specific commit and passed. It cannot prove that tests are meaningful or that the domain model is conceptually correct. Semantic quality remains the responsibility of acceptance criteria, integration tests, and read-only audit/review gates. Later phases will deepen strategic DDD and contract governance.

## Goals

1. Make `docs/roadmap/roadmap.json` the only machine-readable roadmap source of truth.
2. Make completion a controller-owned state transition backed by immutable evidence.
3. Execute the complete leaf set of a requested scope in dependency order.
4. Prevent incomplete, unconsumed, stale, or critically audited work from becoming `done`.
5. Give Codex and Claude Code identical scope, state, verification, and recovery semantics.
6. Preserve local autonomy for project-scoped implementation, tests, builds, and commits without granting broad external permissions.
7. Provide a Node.js 20+ implementation with no third-party runtime dependencies and a comprehensive `node:test` suite.

## Non-goals for Phase 1

- Migrating legacy Markdown roadmaps or `.ddd-auto.local.md` files.
- Generating strategic DDD context maps, subdomains, or team ownership models.
- Generating or diffing OpenAPI, AsyncAPI, protobuf, or database migration contracts.
- Proving that a passing test contains meaningful assertions.
- Installing dependencies, pushing branches, opening pull requests, or invoking remote CI without user approval.
- Supporting non-Git projects or Node.js versions below 20.
- Providing a general-purpose workflow engine outside the ddd-coding-skills lifecycle.

## Defects Addressed

The current design gives natural-language skills and a shell hook overlapping authority over scope, progress, completion, and permissions. That produces several unsafe compositions:

- `ddd-develop` interprets a composite selector as a search boundary and executes the first unchecked child rather than every leaf.
- `ddd-auto` can then synchronize the parent heading as complete, creating false completion.
- Warning states such as `UNWIRED` can be accepted as complete even when no consumer closes the flow.
- Approved specs remain usable after their roadmap or shared contracts change.
- Coverage checks rely on text matching and can fail open.
- Post-commit audits can inspect an empty working-tree diff instead of the run's actual commit range.
- A Stop hook parses mutable prose state, owns loop progression, and deletes evidence on caps or malformed state.
- Broad `Bash(*)` and permission-request matching can auto-approve commands derived from untrusted project documents.
- Codex lacks the Claude Stop-hook lifecycle, so platform behavior diverges.
- Dependencies, failure propagation, rollback boundaries, and recovery are not represented as deterministic data.

## Chosen Approach

Phase 1 uses a deterministic core first. Prompt-only patches would reduce individual symptoms while leaving completion authority distributed. A full workflow orchestrator would address more concerns but introduce unnecessary runtime and migration complexity. The chosen controller is intentionally narrow: it owns roadmap mechanics and evidence; AI agents still own planning and implementation within the assigned leaf item.

## System Invariants

These invariants are mandatory and apply to every platform adapter:

1. Only `roadmapctl` may write a leaf item to `done`.
2. Parent state is derived from descendant leaf states and is never directly writable.
3. One run may have at most one active leaf item at a time.
4. A leaf may become `done` only when all declared gates pass against the same Git commit, spec hash, and gate configuration hash.
5. `blocked`, `failed`, and `cancelled` are not completion variants.
6. A dependency that is not `done` prevents downstream work from becoming `ready`.
7. A user-visible feature requires a consumer-facing integration or end-to-end gate. Infrastructure-only work must name a later consumer and remains non-release-ready until that consumer closes the flow.
8. Skills, hooks, roadmap prose, product briefs, and model responses cannot override controller state or permissions.
9. Run evidence is retained on interruption, corruption, cap exhaustion, and verification failure.
10. The same repository state and selector produce the same ordered leaf set on Codex and Claude Code.

## Architecture

### Components

```text
Codex skill adapter ─┐
                     ├── roadmapctl ── roadmap/spec JSON
Claude skill adapter ┘        │
                              ├── local run journal
                              ├── verification processes
                              ├── Git commit evidence
                              └── generated views/reports
```

The implementation is split by responsibility:

- `bin/roadmapctl.mjs`: command-line entry point and stable exit-code mapping.
- `src/roadmapctl/schema/`: strict parsing and validation of roadmap, spec, run, and report documents.
- `src/roadmapctl/scope/`: selector parsing, hierarchy expansion, and deterministic ordering.
- `src/roadmapctl/graph/`: dependency validation, topological sorting, and blockage propagation.
- `src/roadmapctl/state/`: legal transitions, parent-state derivation, and run invariants.
- `src/roadmapctl/store/`: atomic JSON persistence, locking, hashes, and recovery.
- `src/roadmapctl/git/`: clean-tree checks, baseline and commit-range evidence, and local run-branch validation.
- `src/roadmapctl/verify/`: structured command execution and evidence normalization.
- `src/roadmapctl/render/`: generated Markdown roadmap and immutable run reports.
- `test/roadmapctl/`: unit, integration, security, recovery, and cross-adapter contract tests.

Modules communicate with plain JavaScript objects and return structured result objects. Process exit, console formatting, and filesystem lookup remain in the CLI boundary so the core can be tested without spawning itself.

### Machine and Human Documents

| Path | Role | Mutability |
|------|------|------------|
| `docs/roadmap/roadmap.json` | Committed roadmap definition and durable leaf status | Controller-owned updates |
| `docs/roadmap/roadmap.md` | Human-readable generated view | Regenerated; never parsed |
| `docs/specs/*.json` | Machine-readable behavior contracts and stable acceptance criteria | Generated/reviewed by `ddd-spec` |
| `docs/specs/*.md` | Optional generated spec view | Never parsed for state or coverage |
| `.ddd/runs/<run-id>.json` | Active write-ahead run journal and detailed local logs | Mutable, atomic, Git-ignored |
| `.ddd/active-run.json` | Controller-owned pointer used by platform liveness adapters | Mutable, atomic, Git-ignored |
| `docs/runs/<run-id>.json` | Redacted immutable final evidence report | Write-once, committed locally |

`roadmap.json` is the roadmap truth. It stores settled leaf states (`planned`, `blocked`, `failed`, `cancelled`, and `done`). `ready` is derived from the graph, while `in_progress` and `verifying` belong to one active run journal. The controller combines those documents to calculate the effective state, but the journal cannot redefine hierarchy or claim completion. If a settled-state update is interrupted, recovery replays its write-ahead transaction idempotently.

### Runtime and Packaging

- Minimum runtime: Node.js 20.
- Module format: native ESM.
- Runtime dependencies: none outside Node.js and Git.
- Tests: `node:test` and `node:assert/strict`.
- Child processes: `node:child_process.spawn` with `shell: false`.
- Root package scripts provide a single test and static-validation entry point.

## Roadmap Model

The roadmap uses a flat hierarchy so every selector and dependency references a stable ID directly. Only `item` nodes are executable.

```json
{
  "schemaVersion": 1,
  "project": "example",
  "nodes": [
    {
      "id": "P1",
      "kind": "phase",
      "title": "Profile delivery"
    },
    {
      "id": "P1.1",
      "kind": "feature",
      "parentId": "P1",
      "title": "DocType Profile"
    },
    {
      "id": "P1.1.1",
      "kind": "item",
      "parentId": "P1.1",
      "title": "Profile persistence and REST query",
      "outcome": "A user can create and retrieve a persisted Profile",
      "dependsOn": [],
      "spec": {
        "path": "docs/specs/P1.1-profile.json",
        "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "acceptanceCriteria": ["AC-P1.1-001", "AC-P1.1-002"]
      },
      "consumers": ["ProfileController"],
      "requiredGates": ["spec", "tests", "build", "consumer", "e2e", "audit"],
      "status": "planned"
    }
  ],
  "gates": {
    "tests": {
      "type": "command",
      "executable": "npm",
      "args": ["test"],
      "cwd": "."
    },
    "build": {
      "type": "command",
      "executable": "npm",
      "args": ["run", "build"],
      "cwd": "."
    },
    "consumer": {
      "type": "command",
      "executable": "node",
      "args": ["--test", "test/profile-consumer.test.mjs"],
      "cwd": "."
    },
    "e2e": {
      "type": "command",
      "executable": "node",
      "args": ["--test", "test/profile-e2e.test.mjs"],
      "cwd": "."
    },
    "audit": {
      "type": "attestation",
      "producer": "ddd-audit",
      "schema": "ddd-audit/v1"
    }
  }
}
```

Validation rejects:

- Unknown properties in controller-owned structures.
- Duplicate IDs or IDs that do not match their declared hierarchy.
- Missing or cyclic parents and dependencies.
- Dependencies on aggregate nodes.
- Executable fields on aggregate nodes.
- Work items without an outcome, spec reference, acceptance criteria, or required gates.
- User-visible outcomes without consumer and integration evidence requirements.
- Shell command strings in place of structured executable and argument fields.

`spec` is the built-in internal gate. Test, build, consumer, and E2E gates are normally `command` gates. AI-driven `ddd-audit` is an `attestation` gate: the audit skill submits a schema-valid, commit-bound report through the controller; it is never represented as a fictitious project executable.

No legacy Markdown import path is provided. A project with only Markdown roadmaps receives a clear validation error directing the user to regenerate its roadmap and specs.

## Spec Binding and Coverage

Specs use stable acceptance-criterion IDs that do not depend on heading position. The canonical hash covers normalized machine-readable behavior, including acceptance criteria, public contracts, referenced shared contracts, and consumer declarations. Presentation fields and generated Markdown do not affect the hash.

Before an item becomes `in_progress`, the controller verifies that:

1. The spec exists and passes schema validation.
2. The spec status is `approved`.
3. The current canonical spec hash matches the roadmap reference.
4. Every acceptance-criterion ID referenced by the item exists exactly once.
5. Shared-contract hashes referenced by the spec remain current.
6. Required gates can collectively map evidence to every referenced criterion.

Any mismatch returns the item to `blocked` with a machine-readable reason. Text searching is never used for coverage.

## State Model

### Leaf States

```text
planned → ready → in_progress → verifying → done
               ↘ blocked          ↘ failed
planned/ready/in_progress/verifying → cancelled
blocked/failed → ready  (explicit bounded retry)
```

- `planned`: valid work exists but dependencies or prerequisites are not yet satisfied.
- `ready`: all dependencies and preflight checks pass.
- `in_progress`: assigned to the current run with a captured baseline.
- `verifying`: implementation commit recorded; gates are being evaluated.
- `done`: all required evidence passed and the finalization transaction completed.
- `blocked`: an external prerequisite, consumer, spec, or dependency prevents progress.
- `failed`: an attempted implementation or verification failed.
- `cancelled`: the user explicitly removed the work from the active execution scope; it is not complete.

There is no `UNWIRED`, `DONE_WITH_WARNING`, `skipped-as-success`, or equivalent state.

`ready` is recalculated rather than durably stored. `in_progress` and `verifying` are active-attempt states in the journal. The remaining states are persisted on the leaf in `roadmap.json`. A successful settled-state transaction clears the corresponding active attempt, so one item never has two effective states.

### Aggregate State

Phase and feature nodes do not store mutable status. Their rendered status is derived:

- `done` only when every descendant leaf is `done`.
- `failed` if any descendant is `failed`.
- `blocked` if none failed and any descendant is blocked by an unsatisfied condition.
- `in_progress` if any descendant is active or done while others remain incomplete.
- `cancelled` if every remaining non-done descendant is cancelled.
- `planned` otherwise.

Selectors always expand to leaf items before execution. Selecting `P1.1` therefore means every eligible descendant leaf, never the first unchecked child and never the heading itself.

### Dependency Propagation

The graph is validated as a directed acyclic graph. A leaf becomes ready only after all direct dependencies are done. A blocked, failed, or cancelled dependency gives each downstream leaf a derived blocker containing the upstream ID and state. Downstream work is not offered by `next` until the blocker is resolved.

## Controller Interface

Commands emit machine-readable JSON on stdout and diagnostics on stderr. Success and failure use documented stable exit codes.

| Command | Responsibility |
|---------|----------------|
| `validate` | Validate roadmap, specs, graph, gates, paths, and Git prerequisites |
| `scope <selector>` | Expand selectors and ranges to an ordered leaf list without mutation |
| `bind-spec <feature-id> <spec-path>` | Canonically bind a reviewed spec hash and stable AC coverage to roadmap items |
| `start <selector>` | Require a clean tree, create a run journal, capture baseline SHA, and establish the local run branch |
| `next <run-id>` | Return exactly one ready item or a structured terminal/blockage result |
| `record <run-id> <item-id>` | Bind the implementation commit, changed files, decisions, and AC mapping |
| `verify <run-id> <item-id>` | Execute declared gates and record normalized evidence |
| `attest <run-id> <item-id> <gate> <report-path>` | Validate and bind a non-command evidence report such as `ddd-audit/v1` |
| `finish <run-id> <item-id>` | Apply the only legal transition to `done`, or persist blocked/failed reasons |
| `status <run-id>` | Report effective item, aggregate, and run state without mutation; `--active` resolves the controller pointer |
| `resume <run-id>` | Recover an interrupted journal and return the deterministic next action; `--active` resolves the controller pointer |
| `retry <run-id> <item-id>` | Start a new bounded attempt for blocked/failed work with a recorded reason and remaining attempt budget |
| `abort <run-id>` | Cancel the active attempt with explicit confirmation and close unsuccessfully without deleting evidence |
| `close <run-id>` | Finalize a run only when no item is active and emit its immutable report |
| `render` | Regenerate human-readable roadmap and spec views from JSON |

An item cannot be assigned twice concurrently. `next` records the current HEAD as that item's baseline. `record` rejects commits outside the run branch, commits that do not descend from the item baseline, and an unchanged commit. `verify` invalidates prior evidence whenever the implementation SHA, spec hash, gate configuration hash, or relevant shared-contract hash changes.

## Execution Flow

1. `validate` rejects malformed inputs and unsafe gate commands.
2. `scope` expands the requested selector and topologically sorts leaves, using lexical stable IDs as the tie-breaker.
3. `start` requires a clean Git worktree and captures the original branch and baseline SHA. In a normal checkout it creates a local `ddd/run/<run-id>` branch; in a platform-managed linked worktree it validates and retains the already-isolated branch. It then writes the initial journal and `.ddd/active-run.json` pointer atomically.
4. `next` records the current HEAD as the item baseline and returns one ready leaf as JSON. If none is ready, it returns exact blockers or a closeable terminal state.
5. The platform adapter gives the leaf, its bounded spec context, and controller rules to the AI implementer.
6. The implementer changes only project-scoped files and creates a local commit.
7. `record` binds that commit and its diff from the item baseline to the item.
8. `verify` runs each required command gate and records internal and process evidence.
9. The read-only audit adapter inspects the exact item commit range and submits its structured report with `attest`.
10. `finish` checks the full evidence set. It either finalizes `done` or stores a specific `blocked` or `failed` reason. It commits only controller-owned roadmap and generated-view changes in a separate local bookkeeping commit before another leaf can start.
11. The adapter requests `next` again. It never infers remaining work from prose or Markdown checkboxes.
12. `close` writes the immutable report, updates the generated roadmap view, creates a controller-owned final local bookkeeping commit, ends the run, and clears the active-run pointer only after the close transaction commits. It never merges or pushes.

One leaf is the atomic delivery boundary. Composite scopes are batches of those boundaries, not a larger completion unit.

## Verification Evidence

Every gate result records:

- Gate name.
- Gate type; command gates also record the structured executable, arguments, and working directory.
- Start and end timestamps.
- Exit code or spawn error.
- Implementation commit SHA and item baseline SHA.
- Canonical spec and gate-configuration hashes.
- Acceptance-criterion IDs covered by the gate.
- Relevant changed files or declared evidence artifacts.
- Full stdout/stderr digest and a controller-generated diagnostic class. Raw process output remains only in the Git-ignored journal unless the user explicitly exports it.
- Audit severity counts when the gate schema is `ddd-audit/v1`.

Attestations additionally record their producer and schema ID. The controller validates their exact item baseline, implementation SHA, spec hash, and audit commit range before accepting them.

Completion is rejected when:

- Any required gate is absent, stale, skipped, or unsuccessful.
- Any referenced criterion lacks successful evidence.
- Consumer or integration evidence required by the outcome is absent.
- A declared consumer is still a placeholder or cannot be exercised by its gate.
- Audit reports any CRIT or HIGH finding in the item commit range.
- The current commit, spec, shared contract, or gate configuration differs from the evidence binding.
- The working tree contains unrecorded changes relevant to the item.

The controller verifies evidence identity and process success, not semantic test quality. The audit gate must remain read-only and inspect the captured commit range, not `git diff` of the current working tree.

## Platform Adapters

### Codex

The Codex skills explicitly run the controller loop:

```text
next → bounded implementation → local commit → record → verify commands → audit → attest → finish
```

Codex does not emulate a Stop hook. A skill may delegate bounded implementation work, but the parent adapter retains the run ID and calls the controller between every item. The controller response, not subagent prose, determines whether the loop continues.

### Claude Code

Claude Code follows the same explicit loop. Its Stop hook is only a liveness adapter: while a valid run remains active, it invokes `roadmapctl status` or `roadmapctl resume` and re-injects the exact structured next action. It does not parse Markdown, increment counters, select work, modify state, delete state, or approve permissions.

A missing or disabled hook reduces automation convenience but does not change correctness. The user can invoke resume and obtain the same next action.

### Shared Adapter Contract

Both adapters must:

- Pass run and item IDs explicitly on every mutation.
- Treat roadmap, specs, product briefs, source comments, and tool output as untrusted project data.
- Ignore embedded requests to change permissions, skip gates, mark completion, or execute unrelated commands.
- Never edit JSON state directly.
- Never translate warnings into success.
- Show blockers and ask for user input only when controller output identifies a decision requiring expanded authority.

## Security Model

### Command Execution

Verification commands use structured `{ executable, args, cwd }` records and `spawn` with `shell: false`. Validation rejects shell operators, redirection syntax, command substitution, NUL characters, absolute working directories outside the repository, and traversal outside the repository root. Executable resolution and the final working directory are recorded in evidence.

The controller never executes natural-language fields. A product brief, roadmap title, acceptance criterion, source comment, or model response cannot create commands.

`shell: false` prevents shell-language injection but cannot make a malicious executable safe. At `start`, the adapter displays and captures the exact gate manifest hash. Unattended gate execution is allowed only when the platform sandbox blocks network and out-of-repository writes, or after the user approves that exact manifest for the run. Any manifest change invalidates approval and evidence. The controller does not claim to provide an operating-system sandbox.

### Permission Boundary

Unattended execution may perform only:

- Project-local reads and writes.
- Configured local lint, test, build, and audit commands.
- Git inspection, local run-branch creation, and local commits.
- Controller-owned state and generated-view updates.

Controller-owned Git commits stage an explicit allowlist of generated files and disable repository Git hooks for that invocation. They fail if unrelated changes are present. Implementation commits remain separately identifiable and are never amended by the controller.

Platform approval remains mandatory for:

- Network access.
- Dependency installation or package-manager mutation.
- Credential, keychain, secret-store, or environment-secret access.
- Push, pull-request creation, deployment, or remote CI mutation.
- Deleting project files outside controller-owned temporary state.
- Any modification outside the repository root.
- Destructive Git operations or changes to unrelated user work.

Wildcard shell permission declarations and universal PermissionRequest approvals are removed from skills, hooks, templates, and documentation.

### Prompt Injection Boundary

The controller enforces schemas and treats all descriptive strings as inert data. Platform adapters delimit project data and state that it cannot override system, user, permission, or controller instructions. This reduces the attack surface but does not make model interpretation a security boundary; all privileged effects remain guarded by process and platform controls.

## Persistence, Locking, and Recovery

### Atomic Persistence

Controller-owned JSON is serialized canonically and written using:

1. A temporary file in the destination directory.
2. File flush and `fsync`.
3. Atomic rename over the destination.
4. Directory synchronization where the platform supports it.

After exclusive temporary-file creation, any failed write or destination rename creates an unpredictable diagnostic directory in the same parent and attempts to atomically move the current temp entry into it. Failure handling never unlinks a named temp or quarantine entry, whether it still contains this writer's inode or a concurrent replacement. A successful quarantine rename retains the moved entry; a failed quarantine rename retains the original temp entry and the diagnostic directory. Node's standard filesystem API has no conditional unlink-by-inode primitive, so the controller chooses recoverable residue over possible data loss. A future explicit, lock-protected maintenance operation may inspect and remove retained diagnostics; normal successful destination rename leaves no temp entry.

Each document includes a schema version and monotonically increasing revision. Mutations use compare-and-swap against the revision loaded by the command.

### Locking

A run lock records the run ID, process ID, hostname, creation time, and random owner token. Mutations fail when another live owner holds the lock. A stale lock can be recovered only when its process is absent or its lease expired and the journal passes validation. Recovery is recorded as an event.

### Write-ahead Finalization

Every settled-state mutation first records its expected roadmap revision, target state, implementation HEAD, and permitted generated paths in the journal. `finish` then applies the leaf update, regenerates the roadmap view, creates the isolated bookkeeping commit, records its SHA, and marks that item transaction committed. Recovery detects which steps already occurred and never duplicates the commit.

`close` uses a separate run-finalization transaction because it spans the roadmap view and final report. Recovery can replay these idempotent steps:

1. Confirm that no item is active and determine whether the run result is successful, blocked, failed, cancelled, or capped.
2. Write the immutable report if it does not exist.
3. Regenerate views from the current roadmap revision.
4. Create the isolated final bookkeeping commit if its exact tree is not already committed.
5. Record the commit SHA and mark the run-finalization transaction committed in the journal.

An existing report with different content is a hard integrity failure.

### Failure Behavior

- Spawn failure, non-zero gates, audit CRIT/HIGH, or invalid evidence sets the item to `failed` with retained evidence.
- Missing specs, unavailable consumers, and unmet external prerequisites set the item to `blocked`.
- Corrupt state is preserved and copied into a diagnostic report; it is never silently deleted.
- Iteration limits count leaf attempts only. Audit, rendering, status, recovery, and close operations do not consume attempts.
- Reaching a cap closes the run as unsuccessful while preserving its branch, journal, commits, blockers, and report.
- Partial local commits remain on the run branch. The controller never merges, resets, or pushes them.

## Skill Changes in Phase 1

### ddd-roadmap

- Generate schema-valid `roadmap.json` with stable IDs, outcomes, dependencies, consumers, and gates.
- Generate schema-valid draft spec JSON alongside the roadmap so every item has stable AC IDs and a current initial hash before the roadmap is persisted.
- Ask the controller to render Markdown.
- Stop emitting Markdown as a machine-executable checklist.

### ddd-spec

- Generate machine-readable specs with stable AC IDs and shared-contract hashes.
- Produce Markdown only as a generated review view.
- Invalidate approval bindings whenever canonical behavior or referenced shared contracts change.
- After review, call `bind-spec` so hash and item coverage updates are validated and committed through the controller rather than edited as status prose.

### ddd-develop

- Require a controller-issued run and item.
- Implement exactly one leaf vertical slice.
- Commit locally, then record and verify through the controller.
- Never search for the first unchecked Markdown checkbox or edit completion markers.

### ddd-auto

- Expand and select work only through the controller.
- Loop over one controller-issued leaf at a time.
- Stop on controller-reported failure, blockage, authority expansion, or terminal state.
- Never accept incomplete integration as a warning-level success.

### ddd-audit

- Be read-only by default.
- Audit the captured baseline-to-item commit range.
- Return structured severities and evidence without modifying or committing user files.

### ddd-auto-cleanup

- Become a safe abort/status workflow.
- Preserve journals and evidence.
- Release only controller-owned locks after validating ownership.

### ddd-init and Documentation

- Install the Node.js runtime files and project-local configuration.
- Add `.ddd/runs/` to generated Git ignore rules.
- Document the machine-truth boundary and approval policy.
- Remove legacy state, Markdown parsing, broad permissions, and false-completion guidance from English and Chinese documentation.

## Test Strategy

Development follows test-driven increments using `node:test`. Temporary repositories created by the tests exercise real Git baselines, branches, commits, diffs, and dirty-tree rejection.

### Schema and Model

- Missing fields, unknown properties, duplicate IDs, invalid hierarchy, and invalid statuses.
- Stable AC IDs, canonical hashes, and shared-contract invalidation.
- Legacy Markdown-only roadmap rejection.

### Scope and Graph

- `P1`, `P1.1`, `P1.1.1`, enumerations, and ranges.
- Deterministic tie-breaking and full descendant expansion.
- Missing dependencies, cycles, topological order, and downstream blockage.

### State and Evidence

- Every legal and illegal transition.
- Parent-state derivation from mixed leaf states.
- One active item per run and concurrent assignment rejection.
- Stale commit, spec, shared-contract, and gate-configuration evidence.
- Missing AC, consumer, integration, build, or audit evidence.
- CRIT/HIGH audit rejection.

### Regression Scenario

A fixture matching the reported `P1.1` failure contains two sub-features and seven checklist-equivalent leaf requirements. After one leaf is implemented and verified:

- That leaf may become done.
- Every untouched leaf remains incomplete.
- `P1.1` remains in progress.
- `close` reports the remaining exact leaves and refuses successful completion.

This scenario must pass through both Codex and Claude adapter contract fixtures.

### Persistence and Recovery

- Interrupted temporary writes and transaction replay.
- Lock contention, owner mismatch, and stale-lock recovery.
- Corrupt journal retention and diagnostic reporting.
- Attempt-cap behavior without evidence deletion.
- Resume before commit, after record, during verification, and during finalization.
- Controller bookkeeping commit isolation, hook suppression, and idempotent commit recovery.

### Security

- Shell operators, command substitution, redirection, traversal, NUL input, and out-of-repository working directories.
- Prompt-like commands embedded in titles, outcomes, specs, source comments, and tool output remain inert.
- Static checks ensure no skill, hook, or template grants wildcard shell permissions or writes completion directly.
- Network, installation, credential, deletion, push, and external-path operations remain approval-gated.

### Adapter Consistency

Given the same fixture, baseline, selector, and gate outcomes, Codex and Claude adapters must produce the same ordered items, effective states, blockers, and normalized final report. Platform-specific lifecycle text may differ but cannot change state semantics.

## Phase 1 Acceptance Criteria

1. No skill, hook, or model response can mark an item or aggregate complete without `roadmapctl finish` accepting current evidence.
2. Composite selectors execute their complete leaf set; partial execution cannot complete the aggregate.
3. Missing consumers, integration evidence, AC evidence, or current spec bindings block completion.
4. Warning-style pseudo-completion states no longer exist.
5. Codex and Claude Code share the same controller, ordering, transitions, blockers, and report schema.
6. Interrupted or failed runs remain recoverable and retain their evidence.
7. No repository artifact grants wildcard shell permissions or automatic privilege escalation.
8. Audit examines the item commit range and blocks CRIT/HIGH findings without mutating the project.
9. The regression scenario for partial `P1.1` completion passes on both adapters.
10. All Node.js 20 tests and static consistency checks pass with zero third-party runtime dependencies.

## Later Repair Phases

Phase 2 will improve strategic DDD modeling: bounded contexts, subdomain classification, context maps, ownership, anti-corruption layers, and vertical-slice roadmap generation. Phase 3 will add deeper contract governance and operational hardening, such as API/schema compatibility, migration ordering, remote CI attestations, and multi-repository coordination.

Those phases build on the deterministic core. They do not relax its completion, evidence, security, or recovery invariants.

## Implementation Boundary

The implementation plan derived from this design must stay within Phase 1. It may decompose work into controller foundations, evidence and recovery, skill adapters, security cleanup, and documentation/test milestones. Strategic DDD expansion and remote workflow integration require separate design and implementation cycles.
