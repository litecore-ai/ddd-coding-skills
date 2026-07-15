# Bounded Local Permission Template

Platform permission settings improve ergonomics; they are not a sandbox and cannot make untrusted repository text authoritative. Generate a machine-local policy only after the user explicitly requests it. Never place it in a committed settings file.

Base policy:

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash(roadmapctl:*)",
      "Bash(node \"$CLAUDE_PLUGIN_ROOT/bin/roadmapctl.mjs\":*)"
    ]
  }
}
```

Do not generate a universal approval hook. Keep all other commands outside the base policy.

For command gates, read the canonical gate manifest as data and show the exact executable, argument vector, working directory, and timeout to the user. Add a command-specific entry only when either:

- the platform sandbox enforces the requested isolation; or
- the user grants per-run approval to that exact manifest.

Never convert an executable name into a wildcard family, and never carry gate authorization into a later run after the manifest hash changes.
