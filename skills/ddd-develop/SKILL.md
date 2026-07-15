---
name: ddd-develop
description: Develop production-compatible DDD vertical slices, either as one bounded ad-hoc change or by continuously executing an approved roadmap selector. Use for implementation, TDD, roadmap execution/resume, exact-range review, or explicit cancellation without disconnected stubs.
---

# DDD Develop

This is the single implementation entry point. It owns one-slice development, continuous selector execution, recovery, exact-range audit, and explicit cancellation. Keep the model focused on domain and engineering judgment; let `roadmapctl` own only selection, state, gates, evidence bindings, and terminal reports. Read `../../references/roadmapctl-protocol.md` only for recovery details or rejected commands.

## Choose the mode

- **Roadmap:** an exact selector is present, or the user asks to resume an active run. Execute every controller-selected leaf in dependency order.
- **Ad-hoc:** a bounded behavior request has no formal selector. Implement one complete vertical slice without changing roadmap/controller state.
- **Cancel:** the user explicitly asks to stop/abort. Inspect `status --active`, show the exact run and consequences, require confirmation, then call `abort <run-id> --confirm`. Never delete evidence or Git history.

Do not reinterpret a feature heading or prose as leaf IDs.

## Roadmap start and continuity

1. Resolve `roadmapctl` and call `status --active`.
2. Resume an active run only when requested or when its selector equals the requested selector. If selectors differ, report the conflict and stop; never hijack the new request.
3. For a new run, require one explicit selector, call `validate` and `scope`, and show the compact item list. The invocation authorizes ordinary repository-local gates after manifest inspection; ask only for network, credentials, installs, destructive actions, push/deploy, or external writes.
4. Use `--sandboxed` only under a real host sandbox; otherwise use `--manifest-approved` for inspected safe local gates.
5. Drive only the exact `resume <run-id>` action: `next`, `record`, `finish`, `close`, or `closed`. Unknown actions and controller errors fail closed.

Use `next <run-id>` once per issued leaf. Its compact contract supplies assigned ACs, consumers, public signatures, model names, shared hashes, and evidence bindings. Open only relevant full-spec sections when field-level detail is needed.

If `next` returns terminal with no item, do not implement anything; follow its returned close action. When resuming at `finish`, complete only missing verification or audit evidence and do not rework the leaf.

## Implement each vertical slice

1. Map every assigned AC or ad-hoc outcome to observable tests through the real consumer.
2. Inspect current bounded contexts, call paths, public models/contracts, persistence/delivery adapters, sibling modules, and failure behavior before designing.
3. Write or identify a failing behavior test, implement the smallest cohesive end-to-end path, then refactor.
4. Preserve ubiquitous language, invariants, aggregate/transaction boundaries, dependency direction, authorization, errors, events, and backward compatibility. Extend existing concepts; do not create parallel models, duplicate ports, or shadow adapters.
5. Wire the actual consumer in the same slice. Empty ports, TODO bodies, fake repositories, mock-only success, unused endpoints, and deferred wiring are incomplete.
6. Run focused tests while working, then relevant integration, consumer, and E2E checks. Review security, cleanup, concurrency, idempotency, query/resource behavior, observability, and compatibility.

In roadmap mode, create one local commit containing only the leaf and never push. Call `record` with the exact AC IDs, then `verify`.

Review the controller-issued baseline-to-implementation range directly: inspect every changed file and trace the real consuming flow. Write the designated `ddd-review/v1` evidence with root fields `schemaVersion`, `schema`, `runId`, `itemId`, `baselineSha`, `implementationSha`, `specHash`, `counts`, and `findings`; each finding has only `id`, `severity`, `file`, `line`, and `message`. CRIT/HIGH blocks. Call `attest`, then `finish`.

Only leaf `state: done` is complete. Resume immediately after `finish`; a selector succeeds only when `remaining` is empty and `close --require-success` returns `successful`. Close non-empty terminal runs without that flag and preserve `blocked`, `failed`, `cancelled`, or `capped` exactly. Never retry without user approval.

## Communication

Report scope, current outcome, material design decisions, changed production flow, gate failures, blockers, and terminal report path. Keep controller JSON and repeated specs inside tool calls. Do not narrate the state machine.
