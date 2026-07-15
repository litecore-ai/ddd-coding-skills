# Install DDD Coding Skills for Codex

## Prerequisites

- Node.js 20 or newer
- Git
- Codex skill discovery
- A directory such as `$HOME/.local/bin` on `PATH`

## Install

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git "$HOME/.codex/ddd-coding-skills"
mkdir -p "$HOME/.agents/skills" "$HOME/.local/bin"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-roadmap" "$HOME/.agents/skills/ddd-roadmap"
ln -s "$HOME/.codex/ddd-coding-skills/skills/ddd-develop" "$HOME/.agents/skills/ddd-develop"
ln -s "$HOME/.codex/ddd-coding-skills/bin/roadmapctl.mjs" "$HOME/.local/bin/roadmapctl"
```

Restart Codex after installation.

## Verify

```bash
node --version
roadmapctl --root /path/to/project validate
ls "$HOME/.agents/skills/ddd-roadmap/SKILL.md" "$HOME/.agents/skills/ddd-develop/SKILL.md"
```

The validation command requires a canonical `docs/roadmap/roadmap.json`; use `ddd-roadmap` to bootstrap one when absent.

## Update

```bash
git -C "$HOME/.codex/ddd-coding-skills" pull --ff-only
```

The symlinks expose updates immediately. Restart Codex when skill metadata changes.

On Windows, use directory junctions for the two skills and a `roadmapctl.cmd` launcher that invokes Node.js 20 with `bin/roadmapctl.mjs`.
