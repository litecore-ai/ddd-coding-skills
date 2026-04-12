# ddd-auto Skill Design Spec

> **Date**: 2026-04-12
> **Status**: Draft
> **Author**: Terry Zhang + Claude
> **Plugin**: ddd-coding-skills v1.5.0 → v1.6.0

## Summary

A new `ddd-auto` skill that automatically executes `ddd-develop` through a user-specified roadmap scope until all items are complete (or skipped), then runs a full-project `ddd-audit`. Uses a lightweight Stop hook (inspired by ralph-loop) for reliable looping, with complex logic handled by Claude via SKILL.md instructions.

## Motivation

Currently, `ddd-develop` processes one roadmap item per invocation. For a roadmap with many items, the user must manually invoke `/ddd-develop` repeatedly. `ddd-auto` eliminates this friction — specify a scope, and the system executes all items automatically, culminating in a comprehensive audit.

## Architecture: Skill + Lightweight Stop Hook (Plan B)

### Design Principle

- **Claude handles complexity**: Scope parsing, progress tracking, decision-making, status file management
- **Stop hook handles reliability**: Mechanical guarantee that the loop continues (block exit → re-inject prompt)
- **State file bridges both**: Simple YAML that both Claude and bash can read

### New Files

```
ddd-coding-skills/
├── skills/
│   └── ddd-auto/
│       └── SKILL.md              # Entry skill (scope parsing, state management, orchestration)
├── hooks/
│   ├── hooks.json                # Register Stop hook
│   └── stop-hook.sh              # Lightweight loop engine (~80 lines bash)
└── commands/
    ├── ddd-auto.md               # /ddd-auto start command
    └── cancel-ddd-auto.md        # /cancel-ddd-auto cancel command
```

### Modified Files

- `package.json` — bump version to 1.6.0
- `.claude-plugin/plugin.json` — bump version, update description
- `.claude-plugin/marketplace.json` — bump version, update description
- `README.md` / `README.zh-CN.md` — document new skill

---

## Scope Syntax

### Supported Input Formats

```bash
# Single item
/ddd-auto P0.1.1

# Enumeration (comma or space separated)
/ddd-auto P0.1.1, P0.1.2, P2.1.1

# Range (hyphen — expands to all sub-features within range)
/ddd-auto P0.1.1 - P1.3.1

# Mixed
/ddd-auto P0.1.1 - P1.3.1, P2.1.1

# Phase level (expands to all items in phase)
/ddd-auto P0
/ddd-auto P0 - P1

# Feature area level (expands to all sub-features in area)
/ddd-auto P0.1
/ddd-auto P0.1 - P1.2

# No arguments (execute all incomplete items from all phases)
/ddd-auto
```

### Expansion Rules

1. **Parse**: Read `docs/roadmap/P[0-3]-*.md` files
2. **Expand**: Map scope identifiers to concrete `- [ ]` sub-features
   - `P0` → all incomplete sub-features in Phase 0
   - `P0.1` → all incomplete sub-features under feature area 0.1
   - `P0.1.1` → specific sub-feature 0.1.1
   - `P0.1.1 - P1.3.1` → all incomplete sub-features from P0.1.1 through P1.3.1 in roadmap order
3. **Sort**: Maintain natural roadmap order (phase → feature area → sub-feature)
4. **Filter**: Skip already-completed items (`- [x]` or `✅`)

### Scope Validation

- After expansion, display the full item list and ask user to confirm before starting
- If no incomplete items found in scope, inform user and exit

---

## Decision Policy

### Purpose

During fully automated execution, `ddd-develop` may encounter design choices (architecture patterns, library selection, implementation approaches). The decision policy tells Claude how to make these choices autonomously without stopping to ask.

### Declaration

```bash
# Free-text policy
/ddd-auto P0.1.1 - P1.3.1 --policy "prefer simple implementations, reuse existing project libraries, defer performance optimization"

# Preset policy
/ddd-auto P0.1.1 - P1.3.1 --policy pragmatic

# Combined (preset + override)
/ddd-auto P0.1.1 - P1.3.1 --policy strict-ddd --policy "but allow infrastructure shortcuts for external API adapters"
```

### Preset Policies

| Preset | Bias |
|--------|------|
| `pragmatic` (default) | Practical first. Reuse existing patterns. Choose simplest viable approach. Avoid over-engineering. |
| `strict-ddd` | Strict DDD layer compliance even if it means more code. Domain purity over convenience. |
| `fast` | Minimum viable implementation. Skip non-essential optimization. Deliver first, refine later. |

### State File Recording

```yaml
policy: "prefer simple implementations, reuse existing project libraries"
# or
policy_preset: pragmatic
```

### Decision Logging

Every autonomous decision is recorded in the Progress Log:

```markdown
- [10:05] P0.1.1 — DONE
  - Decision: chose Repository pattern over direct DB calls (policy: strict-ddd)
- [10:32] P0.1.2 — DONE  
  - Decision: used existing zod library for validation (policy: reuse existing)
```

---

## State File: `.claude/ddd-auto.local.md`

Created and maintained by Claude (guided by SKILL.md). Read by stop-hook.sh for loop decisions.

### Format

```yaml
---
active: true
session_id: "<CLAUDE_CODE_SESSION_ID>"
iteration: 1
max_iterations: 50
started_at: "2026-04-12T10:00:00Z"
scope:
  - "P0.1.1"
  - "P0.1.2"
  - "P0.2.1"
  - "P1.1.1"
  - "P1.1.2"
  - "P1.2.1"
  - "P1.3.1"
  - "P2.1.1"
completed: ["P0.1.1", "P0.2.1"]
skipped: ["P0.1.2"]
current: "P1.1.1"
phase: "develop"
policy: "prefer simple implementations"
policy_preset: "pragmatic"
---

## Original Command

/ddd-auto P0.1.1 - P1.3.1, P2.1.1

## Progress Log

- [2026-04-12 10:05] P0.1.1 — DONE (commit: abc1234)
- [2026-04-12 10:32] P0.1.2 — SKIPPED (BLOCKED: missing dependency X)
- [2026-04-12 11:15] P0.2.1 — DONE (commit: def5678)
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `active` | bool | Whether loop is active |
| `session_id` | string | Session that started the loop (isolation) |
| `iteration` | int | Current iteration count |
| `max_iterations` | int | Safety cap (default 50) |
| `started_at` | string | UTC timestamp |
| `scope` | string[] | Expanded list of target sub-feature IDs |
| `completed` | string[] | Successfully completed items |
| `skipped` | string[] | Items skipped due to BLOCKED |
| `current` | string | Item currently being worked on |
| `phase` | enum | `develop` \| `audit` \| `done` |
| `policy` | string | Free-text decision policy (optional) |
| `policy_preset` | string | Preset policy name (optional) |

---

## Execution Flow

### State Machine

```
START
  ↓
[SKILL.md] Parse scope → Read roadmap → Expand to item list
  ↓
[SKILL.md] Display plan, ask user confirmation
  ↓
[SKILL.md] Create .claude/ddd-auto.local.md (active: true, phase: develop)
  ↓
[SKILL.md] Invoke /ddd-develop (picks current item from scope)
  ↓
[ddd-develop completes] → [SKILL.md] Update state file (completed/skipped, advance current, iteration++)
  ↓
[Claude attempts exit]
  ↓
[stop-hook.sh] Read state file (scalar fields only):
  ├─ active=true, phase=develop
  │   → BLOCK exit, inject: "Continue ddd-auto: read state, run /ddd-develop for current item,
  │     update state. If no items remain, set phase to 'audit'."
  │
  ├─ active=true, phase=audit
  │   → BLOCK exit, inject: "Run /ddd-audit (full project).
  │     After completion, set phase to 'done' and generate final report."
  │
  ├─ active=true, phase=done
  │   → cleanup state file, ALLOW exit (loop ends)
  │
  ├─ max_iterations reached
  │   → cleanup state file, ALLOW exit (safety cap)
  │
  └─ active=false OR file missing OR session mismatch
      → ALLOW exit
```

### Stop Hook Logic (Pseudocode)

The hook only reads simple scalar fields (`active`, `session_id`, `iteration`, `max_iterations`, `phase`). It does NOT parse arrays or compute remaining items. Claude is responsible for transitioning `phase` from `develop` → `audit` → `done`.

```bash
#!/bin/bash
STATE_FILE=".claude/ddd-auto.local.md"

# 1. No state file → allow exit
if [ ! -f "$STATE_FILE" ]; then exit 0; fi

# 2. Parse scalar fields from YAML frontmatter (sed/grep, no jq needed)
active=$(sed -n 's/^active: *//p' "$STATE_FILE" | head -1)
session=$(sed -n 's/^session_id: *"*\([^"]*\)"*/\1/p' "$STATE_FILE" | head -1)
iteration=$(sed -n 's/^iteration: *//p' "$STATE_FILE" | head -1)
max_iter=$(sed -n 's/^max_iterations: *//p' "$STATE_FILE" | head -1)
phase=$(sed -n 's/^phase: *"*\([^"]*\)"*/\1/p' "$STATE_FILE" | head -1)
policy=$(sed -n 's/^policy: *"*\([^"]*\)"*/\1/p' "$STATE_FILE" | head -1)

# 3. Extract session_id from hook input JSON (stdin)
hook_input=$(cat)
hook_session=$(echo "$hook_input" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)

# 4. Not active → allow exit
if [ "$active" != "true" ]; then exit 0; fi

# 5. Session mismatch → allow exit (don't trap other sessions)
if [ -n "$hook_session" ] && [ "$session" != "$hook_session" ]; then exit 0; fi

# 6. Safety cap reached → cleanup, allow exit
if [ "$max_iter" -gt 0 ] 2>/dev/null && [ "$iteration" -ge "$max_iter" ] 2>/dev/null; then
  rm -f "$STATE_FILE"
  exit 0
fi

# 7. Phase done → cleanup, allow exit
if [ "$phase" = "done" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi

# 8. Phase develop → block, inject develop prompt
if [ "$phase" = "develop" ]; then
  policy_hint=""
  [ -n "$policy" ] && policy_hint=" Decision policy: $policy."
  reason="Continue ddd-auto (iteration $iteration): Read .claude/ddd-auto.local.md, find the 'current' item, execute /ddd-develop for that item.$policy_hint After completion, update the state file (move current to next item, add to completed/skipped, increment iteration). If no items remain, set phase to 'audit'."
  printf '{"decision":"block","reason":"%s"}' "$reason"
  exit 0
fi

# 9. Phase audit → block, inject audit prompt
if [ "$phase" = "audit" ]; then
  reason="Continue ddd-auto: Execute /ddd-audit (full project). After audit completes, update .claude/ddd-auto.local.md phase to 'done' and generate the final ddd-auto execution report."
  printf '{"decision":"block","reason":"%s"}' "$reason"
  exit 0
fi

# Fallback: unknown phase → allow exit
exit 0
```

### BLOCKED Handling

When ddd-develop reports BLOCKED for a scope item, SKILL.md instructs Claude to:

1. Add the item to `skipped` list with reason
2. Log `SKIPPED (BLOCKED: reason)` in Progress Log
3. Advance `current` to the next incomplete item in scope
4. If all remaining items are BLOCKED, transition phase to `audit`

### Cancellation

`/cancel-ddd-auto` simply deletes `.claude/ddd-auto.local.md`. The Stop hook finds no state file and allows exit.

---

## ddd-develop Integration

### Scope-Aware Item Selection

When running inside ddd-auto, the Stop hook injects a prompt that includes:

```
Execute /ddd-develop for scope item [current item ID from state file].
Decision policy: [policy text].
After completion, update .claude/ddd-auto.local.md accordingly.
```

This ensures ddd-develop picks the correct item (from the scope) rather than just the first `- [ ]` in the entire roadmap.

### ddd-develop Modifications Required

**None.** ddd-develop already supports:
- Roadmap-driven mode (picks `- [ ]` items)
- Ad-hoc mode (explicit requirement)

The Stop hook injects the specific item reference as an ad-hoc requirement, so ddd-develop processes it naturally without modification.

---

## Final Report

After ddd-audit completes, SKILL.md instructs Claude to generate a summary:

```markdown
## ddd-auto Execution Report

**Scope**: P0.1.1 - P1.3.1, P2.1.1
**Iterations**: [N]
**Duration**: [start] - [end]
**Policy**: [policy description]

### Completed ([N] items)

| # | Item | Description | Commit |
|---|------|-------------|--------|
| 1 | P0.1.1 | [description] | abc1234 |
| 2 | P0.2.1 | [description] | def5678 |

### Skipped ([N] items)

| # | Item | Reason |
|---|------|--------|
| 1 | P0.1.2 | BLOCKED: missing dependency X |

### Key Decisions

| Item | Decision | Rationale |
|------|----------|-----------|
| P0.1.1 | Repository pattern | policy: strict-ddd |
| P0.2.1 | Used existing zod | policy: reuse existing libs |

### Audit Results

- **Score**: [overall score]%
- **Verdict**: [READY / NOT READY]
- **Findings**: CRITICAL: [N], HIGH: [N], MEDIUM: [N], LOW: [N]
- **Full report**: docs/audit/YYYY-MM-DD-NNN/audit-report.md
```

---

## hooks.json Registration

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh\""
          }
        ]
      }
    ]
  }
}
```

---

## Commands

### commands/ddd-auto.md

```markdown
---
name: ddd-auto
description: Auto-execute ddd-develop through a roadmap scope, then run ddd-audit
---

Invoke the ddd-auto skill to automatically execute all roadmap items in the specified scope.

Arguments: [scope] [--policy <text|preset>] [--max-iterations <N>]
```

### commands/cancel-ddd-auto.md

```markdown
---
name: cancel-ddd-auto
description: Cancel a running ddd-auto loop
---

Delete .claude/ddd-auto.local.md to terminate the ddd-auto loop.
```

---

## Safety Mechanisms

| Mechanism | Purpose |
|-----------|---------|
| `max_iterations` (default 50) | Prevent infinite loops |
| Session ID isolation | Only the originating session is affected |
| `/cancel-ddd-auto` | Immediate manual termination |
| State file cleanup on completion | No leftover state after loop ends |
| Scope confirmation before start | User reviews expanded items before committing |
| Decision logging | All autonomous choices are auditable |

---

## Version & Metadata Changes

- **Version**: 1.5.0 → 1.6.0
- **plugin.json description**: Add "automated roadmap execution" to description
- **Keywords**: Add "automation", "loop", "batch"
- **README**: Document `/ddd-auto` usage, scope syntax, decision policy
