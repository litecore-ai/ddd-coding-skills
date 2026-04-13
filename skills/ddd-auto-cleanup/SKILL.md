---
name: ddd-auto-cleanup
description: Clean up after interrupting a ddd-auto loop — removes state file and reports progress summary. Use after pressing Escape to stop ddd-auto.
---

# ddd-auto cleanup

Clean up ddd-auto state and report progress after the loop has been interrupted.

1. Check if `.ddd-auto.local.md` exists using Bash: `test -f .ddd-auto.local.md && echo "EXISTS" || echo "NOT_FOUND"`

2. **If NOT_FOUND**: Say "No ddd-auto state file found. Nothing to clean up."

3. **If EXISTS**:
   - Read `.ddd-auto.local.md` to get the current state (iteration, phase, completed items, skipped items)
   - Remove the file using Bash: `rm .ddd-auto.local.md`
   - Report a summary:
     ```
     ddd-auto cleanup complete.
     - Iteration: [N]
     - Phase: [develop/audit]
     - Completed: [list or count]
     - Skipped: [list or count]
     - Remaining: [list or count]
     ```
