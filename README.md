# DDD Coding Skill

A complete Domain-Driven Design development workflow for coding agents. Three composable skills that cover the full lifecycle: planning, implementing, and auditing.

## How It Works

The three skills form a pipeline:

```
ddd-roadmap  →  ddd-develop  →  ddd-code-review
 (plan)         (implement)      (audit)
```

**ddd-roadmap** analyzes your project and generates a structured, phased roadmap with actionable checkbox items.

**ddd-develop** picks the next unchecked roadmap item, generates an implementation plan, executes it with TDD via subagents, runs an audit, fixes all findings, and commits. Self-contained — no external skill dependencies.

**ddd-code-review** performs an 8-dimension audit against DDD architecture standards: design, architecture, quality, security, testing, integration, performance, and observability.

## Skills

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **ddd-roadmap** | Generate phased development roadmap | "generate roadmap", "plan development phases" |
| **ddd-develop** | Implement next roadmap item (full pipeline) | "continue development", "next roadmap item" |
| **ddd-code-review** | 8-dimension DDD architecture audit | "audit this project", "DDD review" |

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

### ddd-code-review

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

### Claude Code (Plugin Marketplace)

```bash
/install-plugin litecore-ai/ddd-coding-skill
```

### Manual Installation

Clone into your Claude Code plugins directory:

```bash
cd ~/.claude/plugins
git clone https://github.com/litecore-ai/ddd-coding-skill.git
```

Or add as a personal skill:

```bash
cd ~/.claude/skills
git clone https://github.com/litecore-ai/ddd-coding-skill.git
```

## Requirements

- A coding agent with subagent support (Claude Code, Codex, etc.)
- A project following (or adopting) DDD architecture patterns

## Project Structure

```
ddd-coding-skill/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── skills/
│   ├── ddd-roadmap/
│   │   └── SKILL.md         # Roadmap generation
│   ├── ddd-develop/
│   │   └── SKILL.md         # Development workflow
│   └── ddd-code-review/
│       └── SKILL.md         # 8-dimension audit
├── LICENSE                  # MIT
├── package.json
└── README.md
```

## License

MIT - see [LICENSE](LICENSE) for details.
