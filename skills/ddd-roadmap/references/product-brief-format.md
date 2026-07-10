# product-brief.md — Format & Distillation Rules

`docs/product-brief.md` is the canonical anchor for product intent, consumed by ddd-spec (blocks if missing), ddd-develop, and ddd-audit. ddd-roadmap generates or updates it during Goal Alignment (Step 2.5).

## Distillation Rules

- **Resolve conflicts**: when sources disagree, prefer the higher-priority source (user input > session context > product docs > README). Note the conflict in the brief.
- **No invention**: only include decisions and constraints that are stated or clearly implied in sources. Do not infer goals or constraints that aren't grounded in source material.
- **Preserve rationale**: when sources explain WHY a decision was made, capture that — it's the most valuable information for downstream specs.
- **Flag gaps**: if critical sections (e.g., target users, non-goals) have no source material, write `[NOT SPECIFIED — confirm with user]` rather than inventing content.
- **Merge, don't replace**: if `docs/product-brief.md` already exists, load it as the baseline and merge new information into it.

## File Format

```markdown
---
generated: [YYYY-MM-DD]
sources: [list of files read, or "session-context"]
---

# Product Brief: [Project Name]

## Vision
[1-3 sentences: what are we building, for whom, and the core value it delivers]

## Target Users
[Who uses this product. Concrete personas if known, otherwise user categories]

## Goals
[Bulleted list of measurable outcomes or capabilities. Each goal should be falsifiable]
- [Goal 1]
- [Goal 2]

## Non-Goals
[Explicit scope exclusions — equally important as goals. Prevents spec drift]
- [Not doing X in this phase]
- [Y is out of scope because Z]

## Key Design Decisions
[Decisions that constrain how the system must be built. Each entry: decision + rationale]

| Decision | Rationale |
|----------|-----------|
| [What was decided] | [Why — the constraint or tradeoff that drove it] |

## Constraints
[Hard limits that specs and implementation must respect]
- **Performance**: [e.g., p95 < 200ms for API responses]
- **Compliance**: [e.g., GDPR, SOC2 requirements]
- **Integration**: [e.g., must work with existing auth system]
- **Technology**: [e.g., must use PostgreSQL, no new infrastructure]

## Open Questions
[Unresolved decisions that ddd-spec will need to make explicit assumptions about]
- [Question 1: what we need to decide]
- [Question 2]
```

## Write Rules

- Create `docs/` if it does not exist
- Keep the file concise — a distillation, not a comprehensive PRD. Target: under 300 lines
- Commit together with the roadmap (`git add docs/product-brief.md docs/roadmap/`)
