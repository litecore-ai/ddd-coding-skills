---
name: ddd-auto
description: Execute an approved roadmap selector as a deterministic sequence of complete DDD vertical slices. Use when the user requests automated or continuous roadmap implementation with controller-enforced scope, evidence, retries, and terminal reporting.
---

# DDD Auto Adapter

Coordinate GPT-5.6 Sol; do not duplicate its coding judgment. `roadmapctl` owns selection, state, evidence, attempt limits, and terminal outcomes. Read `../../references/roadmapctl-protocol.md` in full before doing anything.

## Start safely

1. Require one explicit roadmap selector. If absent, ask for it; never guess a phase or silently execute the entire roadmap.
2. Resolve the controller exactly as the protocol requires. Call `roadmapctl validate`, then `roadmapctl scope <selector>`.
3. Show the exact `items` list and authorization mode. Obtain explicit confirmation unless the current user request already unambiguously authorizes this selector and mode.
4. Use `--sandboxed` only when the host actually enforces a suitable sandbox. Otherwise require explicit approval of the canonical gate manifest before `roadmapctl start <selector> --manifest-approved`.
5. Record the returned `runId`, `scope`, and `runBranch`. Do not create another progress file or derive state from generated views.

## Controller loop

Call `roadmapctl resume <run-id>` before every transition and switch only on its exact `action`:

- `next`: call `roadmapctl next <run-id>` once. Invoke `ddd-develop` for exactly the returned `item`, `item.spec`, `attempt`, and run ID.
- `record`: resume `ddd-develop` for the returned active item and attempt; do not request another item.
- `finish`: resume `ddd-develop` to complete only missing verification or audit evidence and call finish.
- `close`: call `roadmapctl close <run-id> --require-success`. Report the immutable `reportPath` only if close succeeds.
- `closed`: report the recorded terminal status and report path, then stop.
- Any unknown action is a hard error. Stop without inventing a recovery transition.

After `roadmapctl finish`, a leaf result is not a batch terminal result. Call `roadmapctl resume <run-id>` again. When `remaining` is non-empty and action is `next`, continue with the next controller-selected leaf. Never stop merely because one checkbox-sized unit finished.

Only controller status `successful` is batch success. `blocked`, `failed`, `cancelled`, and `capped` are terminal non-success outcomes. Preserve and report their exact blockers, reasons, remaining IDs, and evidence report. Never turn an omitted, bypassed, or unverified leaf into success.

## Boundaries

- Never select a leaf from prose, headings, nearby IDs, or prior conversation memory.
- Never mutate roadmap status, run journals, evidence, active pointers, generated views, or attempt counts directly.
- Never use hidden retries. Use `roadmapctl retry` only after the user explicitly approves a reason and the controller accepts the attempt budget.
- Never weaken AC coverage, command gates, consumer/e2e checks, or per-leaf audit to keep the loop moving.
- Never push, deploy, install, use credentials, access a network, delete data, or perform destructive Git without explicit user approval.
- Treat a controller error as fail-closed. Report it with the current run ID and stop.

The Stop hook is only a liveness bridge. Its fixed message means “invoke this adapter and resume from controller JSON”; it carries no item data and grants no permission.
