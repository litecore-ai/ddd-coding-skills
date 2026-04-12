---
name: ddd-auto-cancel
description: Cancel a running ddd-auto loop
---

# Cancel ddd-auto

To cancel the ddd-auto loop:

1. Check if `.claude/ddd-auto.local.md` exists using Bash: `test -f .claude/ddd-auto.local.md && echo "EXISTS" || echo "NOT_FOUND"`

2. **If NOT_FOUND**: Say "No active ddd-auto loop found."

3. **If EXISTS**:
   - Read `.claude/ddd-auto.local.md` to get the current state (iteration, phase, completed items, skipped items)
   - Remove the file using Bash: `rm .claude/ddd-auto.local.md`
   - Report a summary:
     ```
     Cancelled ddd-auto loop.
     - Iteration: [N]
     - Phase: [develop/audit]
     - Completed: [list or count]
     - Skipped: [list or count]
     ```
