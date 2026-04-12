---
description: "Auto-execute ddd-develop through a roadmap scope, then run ddd-audit"
argument-hint: "[SCOPE] [--policy <text|preset>] [--max-iterations <N>]"
---

# ddd-auto

Invoke the ddd-auto skill to automatically execute all roadmap items in the specified scope, then run a full-project audit.

**Scope syntax:**
- Single item: `/ddd-auto P0.1.1`
- Range: `/ddd-auto P0.1.1 - P1.3.1`
- Mixed: `/ddd-auto P0.1.1 - P1.3.1, P2.1.1`
- Phase: `/ddd-auto P0`
- All: `/ddd-auto` (no args = all incomplete items)

**Options:**
- `--policy <text|preset>` — Decision policy for autonomous choices. Presets: `pragmatic` (default), `strict-ddd`, `fast`. Or free text: `--policy "prefer simple implementations"`
- `--max-iterations <N>` — Safety cap (default: 50)

Use the ddd-auto skill with these arguments: $ARGUMENTS
