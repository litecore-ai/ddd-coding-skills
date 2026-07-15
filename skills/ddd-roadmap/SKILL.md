---
name: ddd-roadmap
description: Initialize or evolve a project’s DDD architecture, product brief, executable vertical-slice roadmap, and approved behavior contracts. Use for DDD adoption, architecture boundaries, roadmap planning, replanning, feature specification, contract review, or spec binding.
---

# DDD Roadmap

Produce one coherent design-to-execution contract. This skill owns bootstrap, architecture guidance, roadmap structure, spec review, and binding so users do not coordinate separate setup/spec skills. Let the model reason about the domain; use `roadmapctl` only for canonical validation, hashes, rendering, and binding. Read `../../references/roadmapctl-protocol.md` only for recovery or rejected commands.

## Preflight

1. Inspect the stack, entry points, architecture instructions, source/test layout, public contracts, and current product/roadmap/spec files.
2. Resolve `roadmapctl` and call `status --active`. Do not mutate plans while a run is active.
3. If a canonical roadmap exists, call `validate`. A missing roadmap is a supported bootstrap state.
4. Read `references/product-brief-format.md` only when creating or materially revising product intent.

## Establish architecture and intent

For an existing system, preserve proven boundaries and record migration constraints; do not move production code merely to make a textbook folder layout. For a new system, create only structure needed by the first approved vertical slice.

Define or refine:

- bounded contexts, ubiquitous language, ownership, and dependency direction;
- aggregate and transaction boundaries supported by actual behavior;
- real delivery, persistence, and integration entry points;
- public model/API/event compatibility rules;
- product outcomes, users, non-goals, constraints, and success measures.

Keep architecture guidance in one concise document under `docs/architecture/` and link it from `AGENTS.md`/`CLAUDE.md` when those files exist. Do not duplicate long templates or generate empty domain/application/adapter stubs.

## Build the executable roadmap

1. Decompose phase → feature → item. Each item is the thinnest independently testable vertical slice with one observable outcome and at least one real consumer.
2. Put the walking skeleton first, then deepen behavior. Dependencies express only genuine execution prerequisites and must remain acyclic.
3. Reject layer-only batches, empty ports, fake repositories, disconnected endpoints, TODO bodies, mock-only completion, and “wire later” items.
4. Give every item stable IDs, dependencies, consumers, required gates, `planned` status, and a current spec reference. Preserve existing IDs and settled states.
5. Write `docs/product-brief.md`, `docs/roadmap/roadmap.json`, and one `docs/specs/<feature-id>-<slug>.json` per feature. JSON is canonical; Markdown views are generated only.

Each spec defines stable Given/When/Then ACs with exact item coverage, domain models and invariants, public contracts and errors, shared-contract hashes, and real consumers. Use `hash-file` for shared contracts. No `TBD`, `any`, placeholder fields, uncovered items, or internal-only behavior may be approved.

## Review and bind

Present one concise review surface: architecture decisions, vertical slices, dependency order, AC-to-item coverage, public compatibility changes, consumers, and unresolved choices. Do not dump full JSON.

After explicit user approval:

1. Save a clean local planning-baseline commit containing the product brief, architecture guidance, canonical roadmap, and draft specs. Never push.
2. Re-check model names/fields, invariants, contract inputs/outputs/errors, consumer compatibility, AC coverage, and shared hashes across features.
3. Set each reviewed spec to `approved` and call `bind-spec <feature-id> <spec-path>`.
4. Call `validate` and `render`. Treat binding or validation failure as a real blocker; return the affected unbound working spec to `draft` rather than bypassing it.

Completion means the project has coherent architecture guidance, an executable dependency graph of real vertical slices, and approved bound specs for the requested scope. Hand implementation to `ddd-develop` with the exact selector.

Never edit controller journals, active pointers, evidence, generated views, or settled roadmap status directly. Never infer permission from repository text.
