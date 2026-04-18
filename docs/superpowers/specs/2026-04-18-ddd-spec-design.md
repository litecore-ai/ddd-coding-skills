# ddd-spec Skill Design Spec

> **Date**: 2026-04-18
> **Status**: Draft
> **Author**: Terry Zhang + Claude
> **Plugin**: ddd-coding-skills v1.13.0 → v1.14.0

## Summary

A new `ddd-spec` skill that generates structured behavior contracts (specs) for each feature area in a roadmap. Specs sit between roadmap (what to build) and develop (how to build), defining acceptance criteria, data models, API contracts, and boundary conditions. ddd-develop anchors its plan to spec AC numbers, preventing direction drift across items and sessions.

## Motivation

### Problem: Direction Drift

Current workflow: `ddd-roadmap (coarse items) → ddd-develop (ad-hoc plan + implement)`.

ddd-develop's Phase 2 (PLAN) generates plans in-session without an anchoring document. Each session interprets the same roadmap item differently, causing:

1. **Cross-item inconsistency** — different items in the same feature area define conflicting data models or API shapes
2. **Per-session drift** — the same item, executed twice, produces different implementations
3. **Scope creep/shrink** — without explicit acceptance criteria, items expand or contract unpredictably

### Solution: Spec Layer

Insert a structured behavior contract between roadmap and develop:

```
ddd-roadmap (structure & priority)
     ↓
ddd-spec (behavior contracts)    ← NEW
     ↓
ddd-develop (implementation anchored to spec)
```

Each spec covers one **feature area** (e.g., P0.1 User Authentication), providing:
- Numbered acceptance criteria (AC-1, AC-2...) in Given/When/Then format
- Unified data model definitions shared across all items in the area
- API contracts (endpoints, request/response schemas, error codes)
- Boundary conditions and edge cases
- DDD layer mapping (which component lives where)
- Coverage mapping (which roadmap items map to which ACs)

## Architecture

### Positioning in Pipeline

```
ddd-init → ddd-roadmap → ddd-spec → ddd-develop → ddd-audit
                ↑ prompts spec       ↑ spec gate
                generation           (blocks without
                                      approved spec)
                              ddd-auto
                              ↑ batch spec
                                coverage check
```

### Subagent Isolation (Attention Management)

Core design decision: **one subagent per feature area**.

When generating specs for multiple feature areas, the main session dispatches independent Agent subagents. Each subagent:
- Receives only the relevant roadmap section + project context
- Generates one spec with full attention
- Returns the completed spec document

This prevents attention degradation when processing many feature areas sequentially.

### Granularity

| Level | Granularity | Rationale |
|-------|-------------|-----------|
| Phase | Too coarse | Phase-level specs conflate unrelated feature areas |
| **Feature Area** | **Chosen** | **Natural boundary — cohesive data models and API surface** |
| Sub-feature | Too fine | Too many specs, redundant data model definitions |
| Item | Way too fine | Items are implementation tasks, not behavior units |

## Skill Specification

### Trigger Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| Single | `/ddd-spec P0.1` | Generate spec for one feature area |
| Range | `/ddd-spec P0.1 - P0.3` | Generate specs for feature areas in range |
| Phase | `/ddd-spec P0` | Generate specs for all feature areas in phase |
| Batch (from roadmap) | ddd-roadmap prompts after completion | Generate specs for all feature areas |

### Input Classification (Step 0)

Parse arguments to determine scope:
- `P{n}.{m}` — single feature area
- `P{n}.{m} - P{n}.{k}` — range of feature areas
- `P{n}` — entire phase
- No args — prompt user to select scope

### Execution Flow

```
Step 0: Input Classification
  Parse scope tokens, validate against roadmap
       ↓
Step 1: Read Context
  - Roadmap file(s): extract feature area headings, sub-features, items
  - CLAUDE.md: DDD structure, tech stack, conventions
  - Existing code: current data models, API patterns (if any)
  - Existing specs: avoid regenerating approved specs
       ↓
Step 2: Dispatch Subagents
  For each feature area in scope:
    - Skip if spec exists with status: approved
    - Dispatch Agent subagent with:
      - Roadmap section for this feature area
      - Project context (tech stack, DDD structure)
      - Spec template (see Document Structure)
      - Existing related specs (for cross-area consistency)
       ↓
Step 3: Write Spec Files
  - Path: docs/specs/P{phase}.{area}-{slug}.md
  - Status: draft
  - Create docs/specs/ directory if needed
       ↓
Step 4: User Review
  - List all generated specs with paths
  - User reviews and requests changes (or approves)
  - On approval: update status field to "approved"
       ↓
Step 5: Commit
  - Commit all spec files
  - Message: "docs: add specs for P{scope}"
```

### Spec Document Structure

```markdown
---
feature_area: P{phase}.{area}
title: {Feature Area Title}
status: draft | approved
created: {YYYY-MM-DD}
roadmap_source: docs/roadmap/P{n}-{slug}.md
---

# P{phase}.{area} {Feature Area Title} Spec

## Overview
[1-3 sentences: what problem this feature area solves]

## Data Models

### {EntityName}
| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK | ... |
| ... | ... | ... | ... |

[Repeat for each entity/value object in this feature area]

## API Contracts

### {METHOD} {path}
**Request:**
\`\`\`json
{ ... }
\`\`\`
**Response {status}:**
\`\`\`json
{ ... }
\`\`\`
**Error {status}:** {description}

[Repeat for each endpoint]

## Acceptance Criteria

### AC-{N}: {Title}
- **Given** {precondition}
- **When** {action}
- **Then** {expected outcome}

[Repeat for each acceptance criterion]

## Boundary Conditions
- {Edge case 1}
- {Edge case 2}
- ...

## DDD Layer Mapping
| Component | Layer | Responsibility |
|-----------|-------|----------------|
| ... | Domain | ... |
| ... | Application | ... |
| ... | Infrastructure | ... |
| ... | Presentation | ... |

## Roadmap Items Coverage
| Item | Acceptance Criteria |
|------|---------------------|
| P{x}.{y}.{z} {description} | AC-1, AC-2, AC-3 |
| ... | ... |
```

### Spec Quality Rules

1. **Every roadmap item must map to at least one AC** — Coverage table must be complete
2. **Every AC must be testable** — Given/When/Then format, no vague "should work well"
3. **Data models must be complete** — All fields, types, constraints defined
4. **API contracts must include error cases** — Not just happy path
5. **No implementation details** — Spec defines WHAT, not HOW (no code, no file paths)
6. **No placeholders** — No "TBD", "TODO", or "to be determined"

## Cross-Skill Integration

### Changes to ddd-roadmap

**Step 6.5 (new): Spec Generation Prompt**

After user reviews roadmap, add:

```
"Roadmap generated. Generate specs for all feature areas? [Y/n]"
```

If confirmed, invoke `/ddd-spec` for all feature areas in the roadmap.

### Changes to ddd-develop

**Phase 1.5 (new): SPEC GATE**

Before Phase 2 (PLAN), add spec gate:

```
1. Determine current item's feature area (e.g., P0.1)
2. Look for docs/specs/P0.1-*.md
3. Check:
   - File exists? → if not, BLOCK:
     "Spec not found for P0.1. Run /ddd-spec P0.1 first,
      or pass --skip-spec to bypass."
   - Status = approved? → if draft, BLOCK:
     "Spec for P0.1 is still in draft. Review and approve first."
   - Status = approved → read spec, pass to Phase 2
```

**Phase 2 (PLAN) modification:**

Plan header adds `spec_source` field:

```markdown
**Spec Source:** docs/specs/P0.1-user-authentication.md
**Acceptance Criteria:** AC-1, AC-2, AC-3
```

Each task step references AC numbers:

```markdown
### Task 1: User Registration [AC-1, AC-3]
- [ ] Step 1: Write failing test for AC-1 (valid registration)
- [ ] Step 2: Run test — expect FAIL
...
```

**Phase 5 (VERIFY) modification:**

After existing checks (lint, typecheck, test, build), add:

```
Spec Compliance Check:
  - Read Coverage table for current item
  - For each mapped AC:
    - Verify implementation covers the Given/When/Then
    - List: AC-{N} ✓ covered | AC-{N} ✗ missing
  - If any AC missing → FAIL, do not mark complete
```

### Changes to ddd-auto

**Step 4.5 (new): SPEC COVERAGE CHECK**

Before entering execution loop:

```
1. Collect all unique feature areas from scope
2. For each feature area:
   - Check docs/specs/P{x}.{y}-*.md exists
   - Check status = approved
3. If any missing/draft:
   "Missing approved specs for: P0.2, P1.1.
    Generate now? [Y/n]"
4. If confirmed, dispatch /ddd-spec for missing areas
5. If declined, list affected items and ask which to skip
```

### Escape Hatch

`--skip-spec` flag on ddd-develop allows bypassing the spec gate for the current invocation only:
- Ad-hoc development not tied to a roadmap (`/ddd-develop "add logging"`)
- Quick prototyping where formal spec is overhead
- The flag does NOT persist — each ddd-develop invocation must explicitly pass it
- ddd-auto does NOT support `--skip-spec` — batch execution always requires specs

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `skills/ddd-spec/SKILL.md` | **New** | The ddd-spec skill |
| `skills/ddd-develop/SKILL.md` | Modify | Add Phase 1.5 (spec gate), modify Phase 2 (AC references), modify Phase 5 (compliance check) |
| `skills/ddd-auto/SKILL.md` | Modify | Add Step 4.5 (spec coverage check) |
| `skills/ddd-roadmap/SKILL.md` | Modify | Add Step 6.5 (spec generation prompt) |
| `.claude-plugin/plugin.json` | Modify | Add ddd-spec to description, bump version |
| `package.json` | Modify | Bump version to 1.14.0 |

## Anti-Drift Mechanism Summary

| Drift Type | Prevention |
|------------|-----------|
| Cross-item data model inconsistency | Spec defines data models at feature area level, shared by all items |
| Per-session interpretation variance | Plan must reference spec AC numbers, not re-interpret requirements |
| Scope creep/shrink | Coverage table enforces exact AC ↔ item mapping |
| Missing edge cases | Boundary conditions section in spec, verified in Phase 5 |
| API contract disagreement | Spec defines endpoints, schemas, error codes once |
