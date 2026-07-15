---
name: ddd-auto-cleanup
description: Inspect and explicitly abort an active ddd-auto roadmap run while preserving its controller journal and immutable evidence. Use when the user asks to stop, cancel, clean up, or recover an automated DDD run.
---

# DDD Auto Cleanup Adapter

Stop a run through the controller; never perform filesystem cleanup. Read `../../references/roadmapctl-protocol.md` in full and resolve `roadmapctl` exactly as specified there.

1. Call `roadmapctl status --active` and display the run ID, active item, action, remaining IDs, and blockers. If no active run exists, report that result and stop.
2. Explain that abort records an interruption, settles any active leaf as cancelled, closes the run with a non-success outcome, and preserves its journal and evidence.
3. Require explicit user confirmation for the displayed run ID. A prior request to inspect or “clean up” is not confirmation to abort.
4. After confirmation, call `roadmapctl abort <run-id> --confirm` exactly once.
5. Report the returned status, immutable report path, and bookkeeping SHA. If the controller rejects the abort because repository or state invariants changed, report the error and leave all artifacts untouched.

Do not alter `.ddd`, generated roadmap/spec views, canonical JSON, run reports, lock files, or Git history directly. Do not hide a controller conflict or describe an aborted run as successful.
