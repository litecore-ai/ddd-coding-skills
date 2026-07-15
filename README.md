# DDD Coding Skills v4

English | [中文](README.zh-CN.md)

A usability-first Domain-Driven Design workflow for Codex and Claude Code. The model owns domain reasoning, implementation, and review. `roadmapctl` performs only deterministic scope, state, gate, Git-binding, and recovery work.

## Design goals

1. Preserve system integrity: every roadmap item is a real vertical slice through a declared consumer, not a disconnected layer or stub.
2. Develop progressively: dependency-ordered leaves are implemented, tested, reviewed, and settled one at a time.
3. Preserve compatibility: approved specs name domain models, public contracts, errors, shared hashes, and consumers; implementation must extend existing concepts and real call paths.
4. Protect model capability: skills state invariants and boundaries, then let the model reason. They do not reteach DDD or script coding judgment.
5. Minimize tokens: controller reads are compact by default; complete feature specs and evidence payloads are never copied into orchestration output.

## Two skills

| Skill | Responsibility |
|---|---|
| `ddd-roadmap` | Bootstrap or evolve architecture guidance, product intent, vertical-slice `roadmap.json`, feature specs, review, and spec binding |
| `ddd-develop` | Implement one ad-hoc vertical slice or continuously execute/resume/cancel an approved selector, including tests, compatibility review, audit, and terminal reporting |

Setup, specification, automation, audit, and cleanup are workflow stages—not separate user-facing skills.

## Coherent flow

1. Use `ddd-roadmap` to inspect the existing system, define bounded contexts and compatibility rules, create the product brief, plan real vertical slices, review specs, and bind them.
2. Use `ddd-develop P1.1` to execute the approved selector. The same skill also handles one leaf, interruption recovery, exact-range audit, and explicitly confirmed cancellation.
3. Use `ddd-develop <bounded request>` without a selector for a lightweight ad-hoc DDD slice that does not mutate roadmap state.

Canonical truth lives in `docs/roadmap/roadmap.json` and `docs/specs/*.json`. Generated Markdown is presentation only. A leaf is complete only when its behavior passes through the real consumer with relevant tests and compatibility checks.

## Controller lifecycle

`validate → start → next → record → verify → audit → attest → finish → close`

The lifecycle is implemented by tools, not narrated by the model. `next` returns only the current leaf's ACs, consumers, public signatures, model names, shared hashes, and evidence bindings. `resume` returns only actionable state. Canonical specs are opened selectively when field-level detail is needed.

Review evidence is produced by `ddd-develop` with schema `ddd-review/v1`; review is a stage of development, not a third skill.

Only terminal status `successful` is success. `blocked`, `failed`, `cancelled`, and `capped` remain explicit. No warning-success, skipped-success, hidden retry, manual parent completion, or gate weakening is allowed.

## Safety and permissions

Gate commands are structured executable/argv/cwd/timeout records and run without a shell. An explicit selector authorizes inspected repository-local build/test/lint gates. Network, credentials, installation, deletion, push/deploy, destructive Git, and writes outside the project still require explicit approval.

## Requirements and installation

- Node.js 20 or newer
- Git
- Codex or Claude Code

For Codex, follow [.codex/INSTALL.md](.codex/INSTALL.md). Claude Code can install the repository as a plugin. Both surfaces use the same controller and two skill directories.

## Verify

```bash
npm run check
```

License: MIT
