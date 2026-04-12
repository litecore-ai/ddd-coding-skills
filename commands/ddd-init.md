---
description: "Initialize or refactor a project into DDD architecture"
argument-hint: "[--template <name>] [--ref <path>]"
---

# ddd-init

Invoke the ddd-init skill to initialize a new project with DDD architecture or generate a refactoring plan for an existing project.

**Usage:**
- `/ddd-init` — auto-detect project state, recommend template
- `/ddd-init --template fastlayer` — use built-in fastlayer template (TypeScript/Next.js)
- `/ddd-init --ref ~/path/to/reference-project` — use a custom reference architecture

**Options:**
- `--template <name>` — Built-in template. Currently: `fastlayer`
- `--ref <path>` — Path to a reference DDD project (scans its directory tree)

`--template` and `--ref` are mutually exclusive. `--ref` takes precedence if both are provided.

Use the ddd-init skill with these arguments: $ARGUMENTS
