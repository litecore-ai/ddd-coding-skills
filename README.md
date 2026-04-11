# DDD Coding Skill

English | [中文](README.zh-CN.md)

A complete Domain-Driven Design development workflow for coding agents. Three composable skills that cover the full lifecycle: planning, implementing, and auditing.

## How It Works

The three skills form a pipeline:

```
ddd-roadmap  →  ddd-develop  →  ddd-audit
 (plan)         (implement)      (audit)
```

**ddd-roadmap** analyzes your project and generates a structured, phased roadmap with actionable checkbox items. Supports scoped roadmaps (`/ddd-roadmap billing system`) or full-project planning.

**ddd-develop** picks the next unchecked roadmap item, generates an implementation plan, executes it with TDD via subagents, runs an audit, fixes all findings, and commits. Also supports ad-hoc requirements (`/ddd-develop add user authentication`). Self-contained — no external skill dependencies.

**ddd-audit** performs an 8-dimension audit against DDD architecture standards: design, architecture, quality, security, testing, integration, performance, and observability. Supports scoped audits (`/ddd-audit src/domain/`) or full-project audits.

## Skills

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **ddd-roadmap** | Generate phased development roadmap | `/ddd-roadmap`, `/ddd-roadmap <scope>` |
| **ddd-develop** | Implement next roadmap item or ad-hoc requirement | `/ddd-develop`, `/ddd-develop <requirement>` |
| **ddd-audit** | 8-dimension DDD architecture audit | `/ddd-audit`, `/ddd-audit <scope>` |

### ddd-roadmap

Scans project structure, **auto-discovers product documentation** (PRD, specs, requirements) to extract vision and constraints, aligns on goals (validating extracted context when docs exist, or full Q&A when they don't), decomposes features into actionable items, and organizes them into prioritized phases (P0-P3).

Three input modes:
- `/ddd-roadmap <scope>` — scoped roadmap for a specific feature area
- `/ddd-roadmap` — full-project roadmap (when project has clear direction)
- `/ddd-roadmap` — interactive (asks what to plan when scope is unclear)

Output: standardized checkbox-format roadmap in `docs/roadmap/`.

### ddd-develop

Self-contained development workflow with 6 phases:

1. **LOCATE** — Find development target (args / roadmap / ask user)
2. **PLAN** — Generate bite-sized implementation plan with TDD steps
3. **IMPLEMENT** — Subagent-per-task execution with spec + quality review loops
4. **AUDIT** — Incremental DDD code review, fix ALL findings (all severity levels)
5. **VERIFY** — Lint, type check, full test suite with evidence
6. **COMPLETE** — Update roadmap (if applicable), commit, push (with user confirmation)

Three input modes:
- `/ddd-develop <requirement>` — develop an ad-hoc requirement (not in roadmap)
- `/ddd-develop` — pick next unchecked roadmap item
- `/ddd-develop` — interactive (asks what to develop when no roadmap items remain)

Built-in: TDD (RED-GREEN-REFACTOR), implementation planning, subagent orchestration (implementer + spec reviewer + quality reviewer), and verification-before-completion.

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
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit ~/.claude/skills/ddd-audit

# Or install as project-specific skills (version-controlled with your project)
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap .claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-develop .claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit .claude/skills/ddd-audit
```

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
cp -r skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r skills/ddd-audit ~/.claude/skills/ddd-audit
```

### Codex CLI

```bash
cd ~/.codex/ddd-coding-skills && git pull
```

Skills update instantly through the symlink.

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

Incremental mode (only recent changes):

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

- A coding agent with subagent support — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex)
- A project following (or adopting) DDD architecture patterns

## Project Structure

```
ddd-coding-skills/
├── .claude-plugin/
│   └── plugin.json          # Claude Code plugin manifest
├── .codex/
│   └── INSTALL.md           # Codex CLI installation guide
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
