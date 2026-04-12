# Installing DDD Coding Skills for Codex

Enable DDD coding skills in Codex via native skill discovery. Clone and symlink.

## Prerequisites

- Git
- OpenAI Codex CLI
- `jq` (required by ddd-auto's Stop hook for JSON handling)

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/litecore-ai/ddd-coding-skills.git ~/.codex/ddd-coding-skills
   ```

2. **Create the skills symlink:**
   ```bash
   mkdir -p ~/.agents/skills
   ln -s ~/.codex/ddd-coding-skills/skills ~/.agents/skills/ddd-coding-skills
   ```

   **Windows (PowerShell):**
   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills"
   cmd /c mklink /J "$env:USERPROFILE\.agents\skills\ddd-coding-skills" "$env:USERPROFILE\.codex\ddd-coding-skills\skills"
   ```

3. **Enable multi-agent support** (required for ddd-develop subagent orchestration):

   Add to `~/.codex/config.toml`:
   ```toml
   [features]
   multi_agent = true
   ```

4. **Restart Codex** to discover the skills.

> **Note:** The `ddd-auto` skill uses a Stop hook (`hooks/stop-hook.sh`) and slash commands (`commands/`) for reliable looping. These are automatically available when using the plugin via Claude Code's plugin system. In Codex CLI, the Stop hook mechanism is not supported — `ddd-auto` will fall back to skill-level instructions for looping, which may be less reliable.

## Verify

```bash
ls -la ~/.agents/skills/ddd-coding-skills
```

You should see a symlink pointing to your ddd-coding-skills/skills directory. Verify all five skills are present:

```bash
ls ~/.agents/skills/ddd-coding-skills/
# Expected: ddd-init  ddd-roadmap  ddd-develop  ddd-audit  ddd-auto
```

## Updating

```bash
cd ~/.codex/ddd-coding-skills && git pull
```

Skills update instantly through the symlink.

## Uninstalling

```bash
rm ~/.agents/skills/ddd-coding-skills
```

Optionally delete the clone: `rm -rf ~/.codex/ddd-coding-skills`.

**Windows (PowerShell):**
```powershell
Remove-Item "$env:USERPROFILE\.agents\skills\ddd-coding-skills"
Remove-Item -Recurse -Force "$env:USERPROFILE\.codex\ddd-coding-skills"  # optional
```
