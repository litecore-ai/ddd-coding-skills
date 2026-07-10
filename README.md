# DDD Coding Skill

English | [中文](README.zh-CN.md)

A complete Domain-Driven Design development workflow for coding agents. Seven composable pipeline skills — plus a cleanup helper (`ddd-auto-cleanup`) — cover the full lifecycle: initialization, product intent capture, planning, spec generation, implementing, auditing, and automated batch execution.

## How It Works

The seven skills form a pipeline:

```
ddd-init  →  ddd-brief  →  ddd-roadmap  →  ddd-spec  →  ddd-develop  →  ddd-audit
 (init)       (brief)        (plan)          (spec)       (implement)      (audit)
                                                               ↑               ↑
                                                           ddd-auto ───────────┘
                                                          (automate)
```

**ddd-init** initializes a new project with DDD architecture or generates a refactoring roadmap for existing projects. Creates the directory structure, standardized `docs/` layout, and writes architecture constraints to `CLAUDE.md`. Supports built-in templates (`/ddd-init --template fastlayer`) or custom reference architectures (`/ddd-init --ref <path>`).

**ddd-brief** distills product intent from session context, existing documentation (PRDs, design docs), or user-provided input into `docs/product-brief.md` — the canonical anchor for the entire pipeline. Run before `ddd-roadmap` to ground feature decomposition in documented product decisions. Required by `ddd-spec` before spec generation.

**ddd-roadmap** analyzes your project, reads `docs/product-brief.md` as its highest-priority source, and generates a structured, phased roadmap with actionable checkbox items. Supports scoped roadmaps (`/ddd-roadmap billing system`) or full-project planning. After roadmap approval, offers to generate specs for all feature areas (requires product-brief.md).

**ddd-spec** generates structured behavior contracts per feature area with numbered acceptance criteria (Given/When/Then), data models, API contracts, and boundary conditions. Requires `docs/product-brief.md` — run `/ddd-brief` first. Prevents direction drift by anchoring `ddd-develop` plans to testable criteria. Supports single (`/ddd-spec P0.1`), range (`/ddd-spec P0.1 - P0.3`), or phase-level (`/ddd-spec P0`) generation with subagent isolation per feature area.

**ddd-develop** picks the next unchecked roadmap item, verifies an approved spec exists (spec gate), generates an implementation plan anchored to spec acceptance criteria, executes it with TDD via subagents, runs an audit, verifies spec compliance, and commits. Also supports ad-hoc requirements (`/ddd-develop add user authentication`).

**ddd-audit** performs an 8-dimension audit against DDD architecture standards: design, architecture, quality, security, testing, integration, performance, and observability. Supports scoped audits (`/ddd-audit src/domain/`) or full-project audits.

**ddd-auto** loops through `ddd-develop` for a user-specified scope of roadmap items, then runs a scoped `ddd-audit` on completed items. Blocks if `docs/product-brief.md` or approved specs are missing (run `/ddd-brief` + `/ddd-spec` first — use `--skip-spec` to bypass). Specify ranges (`/ddd-auto P0.1.1 - P1.3.1`), individual items, or entire phases. Accepts natural language input to auto-generate a roadmap before execution. Uses a Stop hook for reliable looping with configurable decision policies.

## Skills

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **ddd-init** | Initialize or refactor project to DDD architecture | `/ddd-init`, `/ddd-init --template fastlayer`, `/ddd-init --ref <path>` |
| **ddd-brief** | Capture product intent → `docs/product-brief.md` | `/ddd-brief`, `/ddd-brief <description>`, `/ddd-brief <prd-file>` |
| **ddd-roadmap** | Generate phased development roadmap | `/ddd-roadmap`, `/ddd-roadmap <scope>` |
| **ddd-spec** | Generate behavior contracts per feature area | `/ddd-spec`, `/ddd-spec P0.1`, `/ddd-spec P0` |
| **ddd-develop** | Implement next roadmap item or ad-hoc requirement | `/ddd-develop`, `/ddd-develop <requirement>` |
| **ddd-audit** | 8-dimension DDD architecture audit | `/ddd-audit`, `/ddd-audit <scope>` |
| **ddd-auto** | Automated batch roadmap execution + audit | `/ddd-auto`, `/ddd-auto <scope>`, `/ddd-auto --roadmap <path>`, `/ddd-auto-cleanup` |

### ddd-brief

Distills product intent from multiple sources into `docs/product-brief.md` — the canonical anchor for `ddd-roadmap`, `ddd-spec`, `ddd-develop`, and `ddd-audit`. Run before `ddd-roadmap`. Required by `ddd-spec` (blocks if missing).

Three input modes:
- `/ddd-brief` — extract from session context + auto-scan `docs/`
- `/ddd-brief <description>` — use inline text as primary input
- `/ddd-brief <file-path>` — use a specific PRD file as primary source

Modes can be combined: `/ddd-brief my-prd.md add that we also need GDPR compliance`

Output: `docs/product-brief.md` with vision, target users, goals, non-goals, key design decisions, constraints, and open questions.

**Re-run after `ddd-roadmap` Goal Alignment** if new decisions were made during the session that aren't captured in the brief yet.

### ddd-init

Initialize or refactor a project into DDD architecture. Automatically detects project state (new vs. existing) and tech stack.

Two modes:
- **Scaffold** (new project) — creates DDD directory structure + standardized `docs/` layout + CLAUDE.md architecture constraints
- **Refactor** (existing project) — creates target DDD structure + generates a migration roadmap compatible with `/ddd-auto`

Options:
- `--template <name>` — Built-in template. Currently: `fastlayer` (TypeScript/Next.js)
- `--ref <path>` — Use a custom reference project's directory structure

Output:
- DDD layer directories with `.gitkeep`
- Standardized `docs/` structure (roadmap, audit, architecture, specs, plans)
- `CLAUDE.md` architecture section (layer mapping, module template, dependency rules, conventions)
- Refactoring roadmap in `docs/roadmap/` (refactor mode only)

### ddd-roadmap

Scans project structure, **auto-discovers product documentation** (PRD, specs, requirements) to extract vision and constraints, aligns on goals (validating extracted context when docs exist, or full Q&A when they don't), decomposes features into actionable items, and organizes them into prioritized phases (P0-P3).

Three input modes:
- `/ddd-roadmap <scope>` — scoped roadmap for a specific feature area
- `/ddd-roadmap` — full-project roadmap (when project has clear direction)
- `/ddd-roadmap` — interactive (asks what to plan when scope is unclear)

Output: standardized checkbox-format roadmap in `docs/roadmap/`.

### ddd-spec

Generates structured behavior contracts (specs) per feature area. Each spec defines acceptance criteria, data models, API contracts, boundary conditions, and a coverage mapping table that links every roadmap item to specific ACs.

Three input modes:
- `/ddd-spec P0.1` — single feature area
- `/ddd-spec P0.1 - P0.3` or `/ddd-spec P0` — range or entire phase
- Batch — triggered by ddd-roadmap after roadmap approval

Key features:
- **product-brief.md gate** — requires `docs/product-brief.md` before generation; run `/ddd-brief` first
- **Subagent isolation** — one Agent per feature area prevents attention degradation
- **AC numbering** — `AC-1, AC-2...` in Given/When/Then format, referenced by ddd-develop
- **Status gating** — `draft` → `approved`; ddd-develop blocks without an approved spec

Output: structured specs in `docs/specs/P{phase}.{area}-{slug}.md`.

### ddd-develop

Self-contained development workflow with 6 phases:

1. **LOCATE** — Find development target (args / roadmap / ask user)
1.5. **SPEC GATE** — Verify approved spec exists; block if missing
2. **PLAN** — Generate implementation plan anchored to spec acceptance criteria
3. **IMPLEMENT** — Subagent-per-task execution with spec + quality review loops
4. **AUDIT** — Incremental DDD code review, fix ALL findings (all severity levels)
5. **VERIFY** — Lint, type check, full test suite, spec compliance check with evidence
6. **COMPLETE** — Update roadmap (if applicable), commit, push (with user confirmation)

Three input modes:
- `/ddd-develop <requirement>` — develop an ad-hoc requirement (not in roadmap)
- `/ddd-develop` — pick next unchecked roadmap item
- `/ddd-develop` — interactive (asks what to develop when no roadmap items remain)

Built-in: TDD (RED-GREEN-REFACTOR), implementation planning, subagent orchestration (implementer + spec reviewer + quality reviewer), spec compliance verification, and verification-before-completion.

### ddd-audit

8-dimension audit matrix with parallel subagent execution.

Three input modes:
- `/ddd-audit <scope>` — scoped audit of specific modules, layers, or files
- `/ddd-audit` — full-project audit
- `/ddd-audit` — interactive (asks what to audit when scope is unclear)

Dimensions:

| Dimension | Focus |
|-----------|-------|
| D1 Design | Functional completeness, optimal approach |
| D2 Architecture | DDD layer compliance, dependency direction |
| D3 Quality | Dead code, duplication, complexity |
| D4 Security | Vulnerabilities, edge cases, error handling |
| D5 Testing | Coverage, test quality, boundary testing |
| D6 Integration | Cross-module contracts, data flow |
| D7 Performance | N+1 queries, caching, memory leaks |
| D8 Observability | Logging, metrics, tracing |

Supports incremental (diff) mode, configurable via `.audit-config.yml`, and generates scored reports with fix roadmaps.

### ddd-auto

Automated roadmap execution with a Stop hook loop. Specify a scope, and the system executes all items via `ddd-develop`, then runs a scoped `ddd-audit` on completed items.

Scope syntax:
- `/ddd-auto P0.1.1` — single item
- `/ddd-auto P0.1.1 - P1.3.1` — range of items
- `/ddd-auto P0.1.1 - P1.3.1, P2.1.1` — mixed range + individual
- `/ddd-auto P0` — entire phase
- `/ddd-auto` — all incomplete roadmap items
- `/ddd-auto --roadmap path/to/roadmap/` — custom roadmap directory or file
- `/ddd-auto <natural language requirement>` — auto-generate roadmap then execute

Options:
- `--roadmap <path>` — Custom roadmap directory or file (overrides default `docs/roadmap/`)
- `--skip-spec` — Skip spec generation gate. Items proceed without behavior contracts. Use only for quick fixes or refactoring
- `--yes` — Skip confirmation and start immediately (execution plan still displayed)
- `--policy <text|preset>` — Decision policy for autonomous choices. Presets: `pragmatic` (default), `strict-ddd`, `fast`
- `--max-iterations <N>` — Safety cap (default: 50)

Press Escape to interrupt, then `/ddd-auto-cleanup` to clean up state and see progress summary.

> **Note:** Escape pauses the loop but does not end it — until `/ddd-auto-cleanup` runs (or the loop completes), the Stop hook resumes the loop after the session's next reply, even an unrelated one.

Features:
- Spec coverage gate — blocks if `docs/product-brief.md` or approved specs are missing; run `/ddd-brief` + `/ddd-spec` first, or `--skip-spec` to bypass
- Reliable loop via Stop hook (no manual re-invocation needed)
- Session isolation (only the session that started the loop is affected)
- Auto-Roadmap — pass a natural language requirement and ddd-auto generates a roadmap first, then executes it
- Decision policy (presets or free text for autonomous design choices)
- Progress tracking with full execution log
- Roadmap checkbox sync after each completed item
- Automatic skip on BLOCKED items
- Scoped final audit via git diff against pre-run baseline (reducing token usage for large projects)
- Final execution report with audit results

## Installation

### Claude Code

#### Option A: Plugin Marketplace (Recommended)

```bash
claude plugin marketplace add litecore-ai/ddd-coding-skills
claude plugin install ddd-coding-skills@ddd-coding-skills
```

#### Option B: `--plugin-dir` Flag

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git ~/.local/share/claude/plugins/ddd-coding-skills
claude --plugin-dir ~/.local/share/claude/plugins/ddd-coding-skills
```

#### Option C: Manual Skill Installation

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git /tmp/ddd-coding-skills

# Install as personal skills (available in all projects)
cp -r /tmp/ddd-coding-skills/skills/ddd-init ~/.claude/skills/ddd-init
cp -r /tmp/ddd-coding-skills/skills/ddd-brief ~/.claude/skills/ddd-brief
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-spec ~/.claude/skills/ddd-spec
cp -r /tmp/ddd-coding-skills/skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit ~/.claude/skills/ddd-audit
cp -r /tmp/ddd-coding-skills/skills/ddd-auto ~/.claude/skills/ddd-auto

# Or install as project-specific skills (version-controlled with your project)
cp -r /tmp/ddd-coding-skills/skills/ddd-init .claude/skills/ddd-init
cp -r /tmp/ddd-coding-skills/skills/ddd-brief .claude/skills/ddd-brief
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap .claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-spec .claude/skills/ddd-spec
cp -r /tmp/ddd-coding-skills/skills/ddd-develop .claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit .claude/skills/ddd-audit
cp -r /tmp/ddd-coding-skills/skills/ddd-auto .claude/skills/ddd-auto
```

> **Note:** Manual skill installation does not include the Stop hook required by `ddd-auto`. For full `ddd-auto` support (reliable looping), use Option A or B instead, or additionally register `hooks/stop-hook.sh` as a Stop hook in your `.claude/settings.json` (see `hooks/hooks.json` for the shape).

> **First use:** skills that declare `allowed-tools` or `hooks` in their frontmatter (all DDD skills do) require a one-time approval in Claude Code (≥2.1.19) before they first run.

### Codex CLI

Clone and symlink for native skill discovery:

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git ~/.codex/ddd-coding-skills
mkdir -p ~/.agents/skills
ln -s ~/.codex/ddd-coding-skills/skills ~/.agents/skills/ddd-coding-skills
```

Enable multi-agent support (required for ddd-develop subagent orchestration) in `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

Restart Codex to discover the skills.

> **Windows:** Use a junction instead of a symlink — see [.codex/INSTALL.md](.codex/INSTALL.md) for details.

## Updating

### Claude Code — Plugin Marketplace

```bash
claude plugin marketplace update ddd-coding-skills
claude plugin update ddd-coding-skills@ddd-coding-skills
```

Restart Claude Code after updating.

### Claude Code — Manual Installation

```bash
cd /tmp/ddd-coding-skills && git pull
cp -r skills/ddd-init ~/.claude/skills/ddd-init
cp -r skills/ddd-brief ~/.claude/skills/ddd-brief
cp -r skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r skills/ddd-spec ~/.claude/skills/ddd-spec
cp -r skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r skills/ddd-audit ~/.claude/skills/ddd-audit
cp -r skills/ddd-auto ~/.claude/skills/ddd-auto
```

### Codex CLI

```bash
cd ~/.codex/ddd-coding-skills && git pull
```

Skills update instantly through the symlink.

## Usage Examples

### Initialize DDD Architecture

New project with built-in template:

```
You: /ddd-init --template fastlayer

# The skill will:
# 1. Create DDD directory structure (server/handler, server/infras, server/modules)
# 2. Create standardized docs/ layout
# 3. Write architecture constraints to CLAUDE.md
```

Existing project refactoring:

```
You: /ddd-init

# The skill will:
# 1. Detect existing code and tech stack
# 2. Classify files into DDD layers
# 3. Create target DDD directories
# 4. Generate a refactoring roadmap in docs/roadmap/
# 5. Suggest: /ddd-auto --roadmap docs/roadmap/ P0
```

With a custom reference architecture:

```
You: /ddd-init --ref ~/my-other-ddd-project
```

### Generate a Development Roadmap

```
You: /ddd-roadmap

# The skill will:
# 1. Scan your project structure and tech stack
# 2. Ask about your product goals and priorities
# 3. Decompose features into actionable items
# 4. Generate a phased roadmap (P0-P3) in docs/roadmap/
```

Or describe what you want directly:

```
You: /ddd-roadmap I want to build a multi-tenant SaaS platform with user management, billing, and analytics
```

### Implement Features

From roadmap (picks next unchecked item automatically):

```
You: /ddd-develop
You: /ddd-develop   # next item
You: /ddd-develop   # next item
```

Or develop an ad-hoc requirement (not in roadmap):

```
You: /ddd-develop add JWT authentication with refresh token rotation
```

### Audit Your Project

Full project audit:

```
You: /ddd-audit
```

Scoped audit (specific module or layer):

```
You: /ddd-audit src/domain/billing
You: /ddd-audit security review of auth module
```

Incremental mode (only recent changes — triggered by natural language):

```
You: /ddd-audit audit changes since last 3 commits
You: /ddd-audit re-audit only changed files
```

### Full Workflow Example

A typical end-to-end workflow:

```
# Step 0: Capture product intent (required before spec generation)
You: /ddd-brief docs/my-prd.md

# Step 1: Plan your project
You: /ddd-roadmap

# Step 2: Generate behavior contracts (specs) for all feature areas
You: /ddd-spec P0

# Step 3: Implement features one by one (spec-anchored)
You: /ddd-develop
You: /ddd-develop
You: /ddd-develop

# Step 4: Run a final audit before release
You: /ddd-audit
```

### Automated Batch Execution

Execute a range of roadmap items automatically:

```
You: /ddd-auto P0.1.1 - P1.3.1

# The skill will:
# 1. Expand the scope to all sub-features from P0.1.1 through P1.3.1
# 2. Show the execution plan and ask for confirmation
# 3. Loop through each item via /ddd-develop (TDD, audit, commit)
# 4. Run a scoped /ddd-audit on completed items
# 5. Generate a final execution report
```

With a decision policy:

```
You: /ddd-auto P0 --policy "prefer simple implementations, reuse existing libraries"
```

Interrupt anytime by pressing Escape, then clean up:

```
You: [press Escape to stop the loop]
You: /ddd-auto-cleanup
```

## Troubleshooting

### ddd-auto blocked by permission prompts (Claude Code)

**Symptom:** `ddd-auto` or `ddd-develop` pauses with "This command requires approval" for basic commands like `grep`, `find`, or `python`.

**Cause:** In older Claude Code versions, subagents (Agent tool) did not reliably inherit project permission settings, and skill-frontmatter `PermissionRequest` hooks did not always fire for subagent requests. Since `ddd-auto` dispatches subagents to run each `ddd-develop` cycle, those subagents could start with a blank permission slate. Recent Claude Code versions (v2.1.186+) surface subagent permission prompts in the main session instead of silently denying them, which makes the problem visible but can still pause an unattended loop.

**Fix — scoped, machine-local permissions.** Run `/ddd-init` (or copy its Permissions Template) to generate `.claude/settings.local.json` in your project. It contains:

- an allowlist of common build/test/git command prefixes for your tech stack, and
- a **conditional** `PermissionRequest` hook that auto-approves prompts *only while a ddd-auto loop is running* (i.e., while `.ddd-auto.local.md` exists). Outside a loop, normal permission prompts apply.

`settings.local.json` is machine-local and gitignored, so the relaxed permissions never reach your collaborators.

If specific commands still prompt during a loop, add narrow rules for them (e.g. `Bash(npm run test:*)`) to `.claude/settings.local.json` and restart the session.

> **Warning:** Avoid adding `Bash(*)` to your global `~/.claude/settings.json`. That disables command approval for **every** project on the machine, permanently — far more than ddd-auto needs.

## Requirements

- A coding agent with subagent support — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex)
- A project following (or adopting) DDD architecture patterns
- `jq` installed on the system (required by ddd-auto's Stop hook for JSON handling)

## Project Structure

```
ddd-coding-skills/
├── .claude-plugin/
│   ├── marketplace.json     # Claude Code plugin marketplace entry
│   └── plugin.json          # Claude Code plugin manifest
├── .codex/
│   └── INSTALL.md           # Codex CLI installation guide
├── hooks/
│   ├── hooks.json           # Stop hook registration
│   └── stop-hook.sh         # Loop engine for ddd-auto
├── skills/
│   ├── ddd-auto-cleanup/
│   │   └── SKILL.md         # Clean up after interrupting ddd-auto
│   ├── ddd-init/
│   │   ├── SKILL.md         # DDD project initialization
│   │   └── references/      # fastlayer + permissions templates (loaded on demand)
│   ├── ddd-brief/
│   │   └── SKILL.md         # Product intent capture → product-brief.md
│   ├── ddd-roadmap/
│   │   └── SKILL.md         # Roadmap generation
│   ├── ddd-spec/
│   │   └── SKILL.md         # Behavior contract generation
│   ├── ddd-develop/
│   │   ├── SKILL.md         # Development workflow
│   │   └── references/      # Subagent prompt templates (loaded on demand)
│   ├── ddd-auto/
│   │   └── SKILL.md         # Automated roadmap execution
│   └── ddd-audit/
│       ├── SKILL.md         # 8-dimension audit
│       └── references/      # Audit config schema, CI/CD integration (loaded on demand)
├── LICENSE                  # MIT
├── package.json
└── README.md
```

## License

MIT - see [LICENSE](LICENSE) for details.
