# Install DDD Coding Skills v3 for Codex

## Prerequisites

- Node.js 20 or newer
- Git
- Codex with native skill discovery
- A directory such as `$HOME/.local/bin` on `PATH`

## Install

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git "$HOME/.codex/ddd-coding-skills"
mkdir -p "$HOME/.agents/skills" "$HOME/.local/bin"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-init" "$HOME/.agents/skills/ddd-init"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-roadmap" "$HOME/.agents/skills/ddd-roadmap"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-spec" "$HOME/.agents/skills/ddd-spec"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-develop" "$HOME/.agents/skills/ddd-develop"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-audit" "$HOME/.agents/skills/ddd-audit"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-auto" "$HOME/.agents/skills/ddd-auto"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-auto-cleanup" "$HOME/.agents/skills/ddd-auto-cleanup"
ln -s "$HOME/.codex/ddd-coding-skills/bin/roadmapctl.mjs" "$HOME/.local/bin/roadmapctl"
```

Restart Codex after installation. Codex drives the explicit `ddd-auto` controller loop itself; no Stop hook is required, and completion semantics are identical to Claude Code.

## Verify

```bash
node --version
roadmapctl --root /path/to/project validate
ls "$HOME/.agents/skills/ddd-develop/SKILL.md"
```

The Node version must be 20 or newer. The project validation command requires a v3 canonical `docs/roadmap/roadmap.json`.

## Update

```bash
git -C "$HOME/.codex/ddd-coding-skills" pull --ff-only
```

The symlinks expose the update immediately. Restart Codex if skill metadata changed.

## Breaking migration from v2

v3 does not execute legacy Markdown roadmaps or prose state. No migration command exists. Remove old installed skill copies, install all seven v3 skills plus `bin/roadmapctl.mjs`, then regenerate product briefs, `roadmap.json`, and JSON specs with `ddd-roadmap`/`ddd-spec`.

## Windows

Use directory junctions for each skill and place a small `roadmapctl.cmd` launcher on `PATH` that invokes Node with the cloned `bin/roadmapctl.mjs`. Preserve the same seven-skill layout and Node.js 20 requirement.
