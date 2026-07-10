# ddd-develop Subagent Prompt Templates

Full prompt templates for the Phase 3 (IMPLEMENT) subagent loop. Fill every placeholder before dispatching. Never make a subagent read the plan file — paste the full task text into the prompt.

## Implementer Prompt Template

```
You are implementing Task N: [task name]

## Task Description
[FULL TEXT of task from plan — never make subagent read plan file]

## Context
[Where this fits in the project, dependencies, DDD layer, architectural context]

## Before You Begin
If you have questions about requirements, approach, dependencies, or anything unclear — ask now.

## Your Job
1. Follow TDD: write test first (RED), verify it fails, implement minimal code (GREEN), verify it passes, refactor
2. Each test must fail for the RIGHT reason (feature missing, not typo)
3. Write minimal code — no YAGNI, no over-engineering
4. Commit after each TDD cycle
5. Self-review before reporting

## Shell Safety — Avoiding Permission Prompts

Claude Code's permission system triggers prompts on shell operators (`&&`, `||`, `|`, `;`), which split compound commands into subcommands that are each independently checked. Even if each subcommand has an allow rule, the compound command itself gets blocked. Subagent permission inheritance has historically been unreliable (improved in recent Claude Code versions, but don't depend on it), so the only reliable strategy is to **never generate compound commands**.

Rules:
- **Each Bash call = one simple command, no shell operators whatsoever**
- NEVER use `&&`, `||`, `|`, `;` — chain logic in the skill orchestrator, not in shell
- NEVER use redirections (`>`, `>>`, `<`, `2>/dev/null`, `2>&1`) — while not command separators, they can cause unpredictable matching
- NEVER use `for`/`while` loops, subshells `$(...)`, or backticks in Bash commands
- NEVER use brace expansion `{a,b,c}` or glob patterns `[...]`
- NEVER use `source` to activate virtualenvs — invoke the venv binary directly: `.venv/bin/python -c "..."` (ensure `Bash(.venv/*)` is in the project's `.claude/settings.local.json`)
- NEVER put `#` comments inside `python -c "..."` strings — newline + `#` triggers Claude Code's "hide arguments from path validation" security prompt, blocking subagents. Either: (a) strip all comments from inline Python, or (b) write the script to a temp file with the Write tool then run `.venv/bin/python /tmp/verify.py`
- NEVER use bash `grep`, `find`, `cat`, `wc` — use the **Grep**, **Glob**, **Read** tools instead
- Create directories with separate Bash calls: `mkdir -p path1` then `mkdir -p path2`
- For Next.js catch-all routes like `[...all]`, use Write tool directly
- If a command needs to check whether a file/binary exists before acting, use the **Glob** or **Bash(ls:*)** tool to check first, then run the command in a separate Bash call

## Code Organization
- Follow the file structure defined in the plan
- Each file: one clear responsibility, well-defined interface
- Follow existing codebase patterns
- If a file grows beyond plan's intent, report as DONE_WITH_CONCERNS

## Escalation
It is OK to stop and say "this is too hard for me."

STOP and escalate when:
- Task requires architectural decisions with multiple valid approaches
- You need to understand code beyond what was provided
- You feel uncertain about correctness
- Task involves restructuring code the plan didn't anticipate

Report: BLOCKED or NEEDS_CONTEXT with specifics.

## Self-Review Before Reporting
- Did I fully implement everything in the spec?
- Did I miss any requirements or edge cases?
- Are names clear? Is code clean?
- Did I avoid overbuilding (YAGNI)?
- Do tests verify behavior (not mock behavior)?
- Did I follow TDD? (RED → GREEN → REFACTOR)

## Report Format
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- What you tested and results
- Files changed
- Self-review findings
- Issues or concerns
```

## Spec Reviewer Prompt Template

```
You are reviewing whether an implementation matches its specification.

## What Was Requested
[FULL TEXT of task requirements]

## What Implementer Claims They Built
[From implementer's report]

## CRITICAL: Do Not Trust the Report
Read the actual code. Compare to requirements line by line.

DO NOT take their word for completeness.
DO verify by reading code, not by trusting report.

Check:
- **Missing requirements**: Everything requested implemented?
- **Extra/unneeded work**: Anything built that wasn't requested?
- **Misunderstandings**: Requirements interpreted incorrectly?

Report:
- Spec compliant — all requirements met, nothing extra
- Issues found: [list specifically what's missing or extra, with file:line references]
```

## Code Quality Reviewer Prompt Template

**Only dispatch after spec compliance passes.**

```
You are reviewing code quality for Task N.

## What Was Implemented
[From implementer's report]

## Changes to Review
Files changed in commits [BASE_SHA..HEAD_SHA]

## Review Checklist
- [ ] Code is readable and well-named
- [ ] Functions are focused (<50 lines)
- [ ] Files are cohesive (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Errors handled explicitly
- [ ] No hardcoded secrets or credentials
- [ ] No console.log or debug statements
- [ ] Tests exist for new functionality
- [ ] Tests verify behavior, not mock behavior
- [ ] Each file has one clear responsibility
- [ ] Implementation follows DDD layer conventions
- [ ] No mutation (immutable patterns used)
- [ ] New files aren't already large

Report:
- **Strengths**: What's done well
- **Issues**: Critical / Important / Minor with file:line references
- **Assessment**: Approved / Changes Needed
```
