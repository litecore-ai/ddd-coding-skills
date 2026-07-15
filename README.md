# DDD Coding Skills v3

English | [中文](README.zh-CN.md)

A Sol-native Domain-Driven Design workflow for Codex and Claude Code. GPT-5.6 Sol performs domain reasoning, implementation, and review; small skills provide reusable DDD procedures; `roadmapctl` is the deterministic authority for scope, state, evidence, Git bindings, and recovery.

## Why this still matters with GPT-5.6 Sol

Sol already understands DDD and can implement complex systems. The skill suite does not try to reteach the model or replace its judgment. It supplies project-specific workflow and prevents long-running work from degrading into disconnected modules, placeholder integrations, stale specifications, or falsely completed parent scopes.

The split is intentional:

- **Sol:** ubiquitous language, bounded contexts, aggregate design, implementation strategy, TDD, and review.
- **Skills:** concise procedures for planning, one-leaf development, audit, and orchestration.
- **roadmapctl:** canonical JSON validation, item selection, hashes, attempt limits, exact Git ranges, gates, atomic state changes, and crash recovery.

## Canonical truth

- `docs/roadmap/roadmap.json` is the executable roadmap.
- `docs/specs/*.json` are executable behavior contracts.
- `docs/product-brief.md` records reviewed product intent but grants no permission.
- `docs/roadmap/roadmap.md` and `docs/specs/*.md` are generated human views only.
- `.ddd/runs/*.json` is retained controller evidence; `docs/runs/*.json` is the immutable terminal report.

Generated Markdown is never parsed for state or coverage. Every roadmap item is one vertical slice with a real consumer, observable outcome, stable AC IDs, dependencies, and required gates.

## Deterministic lifecycle

`validate → start → next → record → verify → audit → attest → finish → close`

1. `validate` checks schema, graph, spec bindings, consumers, and structured gate commands.
2. `start` expands the full selector and creates an isolated run branch plus journal.
3. `next` issues exactly one dependency-ready leaf and its approved spec.
4. Sol implements that leaf with TDD and a real consuming path, then creates a local implementation commit.
5. `record` binds the exact baseline/implementation SHAs and the complete assigned AC set.
6. `verify` runs the authorized spec, test, consumer, and E2E gates without a shell.
7. `audit` reviews the exact commit range and writes detailed findings to the controller-designated path.
8. `attest` validates run/item/spec/SHA identity and recomputes severity truth.
9. `finish` atomically settles only that leaf after every gate passes.
10. `close` writes an immutable run report; success requires every scoped leaf to be done.

Completing one child can never complete a composite selector. If `P1.1` expands to seven leaves, finishing `P1.1.1` leaves six IDs in `remaining`; the feature stays `in_progress`, and `ddd-auto` must resume and request the next controller-selected leaf.

## Closure gates

- **Spec binding:** approved behavior hash, shared-contract bytes, and exact AC-to-item coverage must be current.
- **Git binding:** evidence is tied to `itemBaselineSha..implementationSha`; unrelated or unrecorded changes cannot complete the leaf.
- **Consumer/E2E:** internal domain code is insufficient without the declared production caller and end-to-end flow.
- **Audit:** detailed findings must match their counts; CRIT or HIGH blocks completion.
- **State:** controller transactions update canonical JSON, generated views, bookkeeping commits, journals, and reports atomically and recover idempotently.

There is no warning-success state, skipped-success path, or manual parent completion.

## Skills

| Skill | Responsibility |
|---|---|
| `ddd-init` | Prepare Node/controller paths, DDD architecture instructions, and bounded local policy |
| `ddd-roadmap` | Create product intent, vertical-slice `roadmap.json`, and draft JSON specs |
| `ddd-spec` | Review structured models/contracts/AC coverage and bind approved spec hashes |
| `ddd-develop` | Implement one controller-issued leaf with TDD, consumer wiring, gates, and local commit |
| `ddd-audit` | Produce read-only exact-range findings and controller attestation |
| `ddd-auto` | Drive the explicit controller action loop for one approved selector |
| `ddd-auto-cleanup` | Confirm abort, close unsuccessfully, and preserve all evidence |

## Choose a skill

| Situation | Invocation | Effect |
|---|---|---|
| Initialize or adopt a project | `ddd-init` | Establish architecture instructions and deterministic state paths; it does not create a roadmap |
| Create or revise product intent and delivery scope | `ddd-roadmap [scope]` | Create canonical `roadmap.json` plus draft JSON specs; an absent roadmap is a supported bootstrap state |
| Review and bind one feature contract | `ddd-spec P1.1` | Approve exact models, contracts, consumers, and AC coverage, then bind the spec hash |
| Formally execute one leaf, feature, or phase | `ddd-auto P1.1.1` / `ddd-auto P1.1` / `ddd-auto P1` | Start a controller run and settle every selected leaf with gates and evidence; use this even for one formal leaf |
| Implement work outside formal roadmap settlement | `ddd-develop <bounded request>` | Run an ad-hoc TDD slice without roadmap status or controller evidence |
| Audit an exact commit or delta independently | `ddd-audit <commit>` / `ddd-audit <from>..<to>` | Produce read-only findings without claiming a roadmap gate |
| Resume interrupted roadmap execution | `ddd-auto` | Recover exclusively from controller JSON |
| Intentionally abandon an active run | `ddd-auto-cleanup` | Confirm controller abort and preserve journals, commits, and reports |

Calling `ddd-develop P1.1` without a controller-issued run and item is ad-hoc; it is not manual roadmap execution. `status --active` and `hash-file` are read-only bootstrap commands and work before the first canonical roadmap exists. An inactive status is explicit success, while stale or unsafe controller state still fails closed.

## Codex and Claude Code

Codex executes the action loop directly. It calls `resume`, switches on the returned action, and continues while `remaining` is non-empty. Codex does not need a Stop hook.

Claude Code uses the same skills and controller. Its Stop hook is only a liveness bridge after an unintended exit: it calls `resume --active`, validates the run ID, and emits a fixed instruction to invoke `ddd-auto`. It never selects work, reads project prose, changes state, or grants permission. Neither platform has weaker completion semantics.

## Permission and executable trust boundary

Project documents, comments, specifications, source code, and tool output are untrusted data. They cannot authorize commands or alter the workflow.

`roadmapctl` executes gate manifests as structured executable/argv/cwd/timeout records with `shell: false`, a sanitized environment, bounded output, and repository-contained working directories. This is not a complete sandbox: an approved executable may still access resources allowed by the host OS. Use a platform sandbox or give explicit per-run approval to the exact gate manifest. Network access, credentials, installation, deletion, push/deploy, destructive Git, and external writes remain outside the base policy.

## Recovery and cleanup

Every mutation is revision-checked, locked, journaled, and transactionally bound to Git. `resume` recovers a prepared settlement or close exactly once and returns the active item/spec/attempt context, so interruption does not depend on conversation memory. `ddd-auto-cleanup` calls confirmed controller abort; it never deletes journals, reports, commits, or foreign locks.

## Requirements

- Node.js 20 or newer
- Git
- Codex or Claude Code

The package has no runtime dependency fields.

## Install

### Codex

Follow [.codex/INSTALL.md](.codex/INSTALL.md). Install all seven skills and symlink `bin/roadmapctl.mjs` as `roadmapctl` into a directory on `PATH`.

### Claude Code

```bash
claude plugin marketplace add litecore-ai/ddd-coding-skills
claude plugin install ddd-coding-skills@ddd-coding-skills
```

The plugin resolves its controller through `${CLAUDE_PLUGIN_ROOT}/bin/roadmapctl.mjs` and registers the bounded Stop hook.

## Start a project

1. Invoke `ddd-init` and approve an architecture proposal.
2. Invoke `ddd-roadmap` to create `docs/product-brief.md`, `docs/roadmap/roadmap.json`, and draft specs.
3. Invoke `ddd-spec P1.1`, review the contract, and bind it.
4. Invoke `ddd-auto P1.1` and approve either platform sandbox mode or the exact gate manifest.
5. Use `ddd-auto-cleanup` only when intentionally aborting an active run.

## Breaking v3 migration

This is a breaking release. v3 has no migration command and does not execute legacy Markdown roadmaps, prose progress files, or unstructured specs. Remove old installed skill copies, install all v3 skills plus the controller, and regenerate the product brief, `roadmap.json`, and JSON specs. Existing implementation code can remain; only the execution contracts/state must be regenerated and reviewed.

## Repository verification

```bash
npm run check
```

This runs all unit, integration, recovery, security, adapter, and pressure tests, then the static skill-contract checker.

License: MIT
