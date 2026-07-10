## Permissions & Hooks Template

When generating `.claude/settings.local.json`, use this template and adapt based on the detected tech stack. This file ensures ddd-auto and ddd-develop can execute build/test/lint commands without triggering permission prompts that block the automated loop.

**Why `settings.local.json` and not `settings.json`:** the allowlist below is a convenience for THIS machine's automated runs. Writing it to the committed `settings.json` would silently grant the same broad permissions to every collaborator and every future session of the project — never do that. `settings.local.json` is gitignored by Claude Code by default.

**Defense in depth:** `permissions.allow` covers known command patterns. `hooks.PermissionRequest` catches anything that slips through — but it is **conditional**: it only auto-approves while a ddd-auto loop is actually running (the `.ddd-auto.local.md` state file exists). Outside a loop, normal permission prompts apply and the user stays in control. Both layers are needed because:
- `permissions.allow` is fast (no subprocess overhead) but pattern-based — it cannot cover every possible command
- the conditional `hooks.PermissionRequest` is universal during unattended loops, and inert the rest of the time

> **Deliberately excluded from the allowlist:** `Bash(bash:*)` and `Bash(source:*)` — either one lets any command run as `bash -c "..."`, which nullifies every other prefix rule in the list. If a project genuinely needs them, the user must add them manually and knowingly.

Base template (always included):

```json
{
  "permissions": {
    "allow": [
      "Write",
      "Edit",
      "Read",
      "Glob",
      "Grep",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
      "Bash(rm:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(echo:*)",
      "Bash(find:*)",
      "Bash(sed:*)",
      "Bash(wc:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(sort:*)",
      "Bash(touch:*)",
      "Bash(chmod:*)",
      "Bash(git:*)",
      "Bash(jq:*)",
      "Bash(grep:*)",
      "Bash(curl:*)",
      "Bash(make:*)",
      "Bash(.venv/*)",
      "Bash(node_modules/.bin/*)"
    ]
  },
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "[ -f \"${CLAUDE_PROJECT_DIR:-.}/.ddd-auto.local.md\" ] && printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"allow\"}}}' || true"
          }
        ]
      }
    ]
  }
}
```

> **Important — pattern syntax:** `Bash(X:*)` uses `:*` as a word-boundary suffix equivalent to `Bash(X *)` — it requires `X` followed by a space. To match path prefixes like `.venv/bin/python`, use `Bash(.venv/*)` (no colon) where `*` is a plain glob matching any characters. `Bash(.venv/*)` covers `.venv/bin/python -m pytest`, `.venv/bin/pip install`, etc.

Append tech-stack-specific entries based on tech stack detection from Step 2:

| Detected Stack | Additional Entries |
|----------------|-------------------|
| Python | `Bash(python:*)`, `Bash(python3:*)`, `Bash(pip:*)`, `Bash(pip3:*)` |
| Node.js / TypeScript | `Bash(node:*)`, `Bash(npm:*)`, `Bash(npx:*)`, `Bash(pnpm:*)`, `Bash(yarn:*)`, `Bash(bun:*)` |
| Go | `Bash(go:*)` |
| Java / Kotlin | `Bash(mvn:*)`, `Bash(gradle:*)` |
| Rust | `Bash(cargo:*)` |

Also add `Bash(gh:*)` if GitHub CLI is available.

