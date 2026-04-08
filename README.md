# DDD Coding Skill

English | [中文](README.zh-CN.md)

A complete Domain-Driven Design development workflow for coding agents. Three composable skills that cover the full lifecycle: planning, implementing, and auditing.

## How It Works

The three skills form a pipeline:

```
ddd-roadmap  →  ddd-develop  →  ddd-audit
 (plan)         (implement)      (audit)
```

**ddd-roadmap** analyzes your project and generates a structured, phased roadmap with actionable checkbox items.

**ddd-develop** picks the next unchecked roadmap item, generates an implementation plan, executes it with TDD via subagents, runs an audit, fixes all findings, and commits. Self-contained — no external skill dependencies.

**ddd-audit** performs an 8-dimension audit against DDD architecture standards: design, architecture, quality, security, testing, integration, performance, and observability.

## Skills

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **ddd-roadmap** | Generate phased development roadmap | "generate roadmap", "plan development phases" |
| **ddd-develop** | Implement next roadmap item (full pipeline) | "continue development", "next roadmap item" |
| **ddd-audit** | 8-dimension DDD architecture audit | "audit this project", "DDD review" |

### ddd-roadmap

Scans project structure, aligns on product goals through conversation, decomposes features into actionable items, and organizes them into prioritized phases (P0-P3).

Output: standardized checkbox-format roadmap in `docs/roadmap/`.

### ddd-develop

Self-contained development workflow with 6 phases:

1. **LOCATE** — Scan roadmap, find next unchecked item
2. **PLAN** — Generate bite-sized implementation plan with TDD steps
3. **IMPLEMENT** — Subagent-per-task execution with spec + quality review loops
4. **AUDIT** — Incremental DDD code review, fix ALL findings (all severity levels)
5. **VERIFY** — Lint, type check, full test suite with evidence
6. **COMPLETE** — Update roadmap, commit, push (with user confirmation)

Built-in: TDD (RED-GREEN-REFACTOR), implementation planning, subagent orchestration (implementer + spec reviewer + quality reviewer), and verification-before-completion.

### ddd-audit

8-dimension audit matrix with parallel subagent execution:

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

## Installation

### Option 1: Plugin Marketplace (Recommended)

Add the repository as a marketplace source, then install:

```bash
claude plugin marketplace add litecore-ai/ddd-coding-skills
claude plugin install ddd-coding-skills@ddd-coding-skills
```

### Option 2: `--plugin-dir` Flag

Clone the repository and load it per-session:

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git ~/.local/share/claude/plugins/ddd-coding-skills
claude --plugin-dir ~/.local/share/claude/plugins/ddd-coding-skills
```

### Option 3: Manual Skill Installation

Copy individual skills into your personal or project skills directory:

```bash
# Clone the repository
git clone https://github.com/litecore-ai/ddd-coding-skills.git /tmp/ddd-coding-skills

# Install as personal skills (available in all projects)
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit ~/.claude/skills/ddd-audit

# Or install as project-specific skills (version-controlled with your project)
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap .claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-develop .claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit .claude/skills/ddd-audit
```

## Updating

### Plugin Marketplace

```bash
# Update the marketplace cache first
claude plugin marketplace update ddd-coding-skills

# Then update the plugin
claude plugin update ddd-coding-skills@ddd-coding-skills
```

Restart Claude Code after updating for changes to take effect.

### Manual Installation

Pull the latest changes and re-copy the skill files:

```bash
cd /tmp/ddd-coding-skills && git pull
cp -r skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r skills/ddd-audit ~/.claude/skills/ddd-audit
```

## Usage Examples

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

### Implement the Next Roadmap Item

```
You: /ddd-develop

# The skill will automatically:
# 1. Find the next unchecked item in your roadmap
# 2. Generate an implementation plan
# 3. Execute via TDD (RED → GREEN → REFACTOR) with subagents
# 4. Run a DDD audit and fix all findings
# 5. Verify (lint, type check, tests)
# 6. Update the roadmap and commit (with your confirmation)
```

Run it repeatedly to work through your roadmap item by item:

```
You: /ddd-develop   # implements item 1
You: /ddd-develop   # implements item 2
You: /ddd-develop   # implements item 3
...
```

### Audit Your Project

```
You: /ddd-audit

# Runs a full 8-dimension audit:
# D1 Design, D2 Architecture, D3 Quality, D4 Security,
# D5 Testing, D6 Integration, D7 Performance, D8 Observability
# Output: scored report + fix roadmap in docs/audit/
```

Audit only recent changes (incremental mode):

```
You: /ddd-audit --diff HEAD~3
```

### Full Workflow Example

A typical end-to-end workflow:

```
# Step 1: Plan your project
You: /ddd-roadmap

# Step 2: Implement features one by one
You: /ddd-develop
You: /ddd-develop
You: /ddd-develop

# Step 3: Run a final audit before release
You: /ddd-audit
```

## Requirements

- A coding agent with subagent support (Claude Code, Codex, etc.)
- A project following (or adopting) DDD architecture patterns

## Project Structure

```
ddd-coding-skills/
├── .claude-plugin/
│   ├── marketplace.json     # Marketplace manifest
│   └── plugin.json          # Plugin manifest
├── skills/
│   ├── ddd-roadmap/
│   │   └── SKILL.md         # Roadmap generation
│   ├── ddd-develop/
│   │   └── SKILL.md         # Development workflow
│   └── ddd-audit/
│       └── SKILL.md         # 8-dimension audit
├── LICENSE                  # MIT
├── package.json
└── README.md
```

## License

MIT - see [LICENSE](LICENSE) for details.
