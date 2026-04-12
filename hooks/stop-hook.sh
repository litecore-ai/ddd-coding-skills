#!/bin/bash
# ddd-auto Stop Hook
# Lightweight loop engine: reads state file scalar fields, blocks exit when loop is active.
# Claude (via SKILL.md) handles all complex logic: scope parsing, progress tracking, phase transitions.

set -euo pipefail

STATE_FILE=".ddd-auto.local.md"

# 0. Require jq for JSON handling
if ! command -v jq &>/dev/null; then
  echo "ddd-auto: jq not found — Stop hook skipped, loop will not continue. Install jq to use ddd-auto." >&2
  exit 0
fi

# 1. No state file → allow exit
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# 2. Parse YAML frontmatter (first block between --- delimiters only)
FRONTMATTER=$(awk '/^---$/{if(++c==2) exit; next} c==1' "$STATE_FILE")

trim() { sed 's/^[[:space:]]*//;s/[[:space:]]*$//' ; }
active=$(echo "$FRONTMATTER" | grep '^active:' | sed 's/active: *//' | head -1 | trim || true)
session_id=$(echo "$FRONTMATTER" | grep '^session_id:' | sed 's/session_id: *//' | sed 's/^"\(.*\)"$/\1/' | head -1 | trim || true)
iteration=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//' | head -1 | trim || true)
max_iterations=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//' | head -1 | trim || true)
phase=$(echo "$FRONTMATTER" | grep '^phase:' | sed 's/phase: *//' | sed 's/^"\(.*\)"$/\1/' | head -1 | trim || true)
policy=$(echo "$FRONTMATTER" | grep '^policy:' | sed 's/policy: *//' | sed 's/^"\(.*\)"$/\1/' | head -1 | trim || true)
policy_preset=$(echo "$FRONTMATTER" | grep '^policy_preset:' | sed 's/policy_preset: *//' | sed 's/^"\(.*\)"$/\1/' | head -1 | trim || true)

# 3. Read hook input from stdin (JSON with session_id, transcript_path)
HOOK_INPUT=$(cat)
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# 4. Not active → allow exit
if [[ "$active" != "true" ]]; then
  exit 0
fi

# 5. Session mismatch → allow exit (don't trap other sessions)
if [[ -n "$HOOK_SESSION" ]] && [[ -n "$session_id" ]] && [[ "$session_id" != "$HOOK_SESSION" ]]; then
  exit 0
fi

# 6. Validate numeric fields
if [[ ! "$iteration" =~ ^[0-9]+$ ]]; then
  echo "ddd-auto: State file corrupted (iteration: '$iteration'). Stopping loop." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

if [[ ! "$max_iterations" =~ ^[0-9]+$ ]]; then
  echo "ddd-auto: State file corrupted (max_iterations: '$max_iterations'). Stopping loop." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

# 7. Safety cap reached → cleanup, allow exit
if [[ $max_iterations -gt 0 ]] && [[ $iteration -ge $max_iterations ]]; then
  echo "ddd-auto: Max iterations ($max_iterations) reached. Stopping loop." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

# 8. Phase done → cleanup, allow exit
if [[ "$phase" == "done" ]]; then
  rm -f "$STATE_FILE"
  exit 0
fi

# 9. Build policy hint for injection
POLICY_HINT=""
if [[ -n "$policy" ]]; then
  POLICY_HINT="Decision policy: $policy."
elif [[ -n "$policy_preset" ]]; then
  POLICY_HINT="Decision policy preset: $policy_preset."
fi

# 10. Increment iteration in state file (frontmatter only)
NEXT_ITERATION=$((iteration + 1))
TEMP_FILE="${STATE_FILE}.tmp.$$"
trap 'rm -f "$TEMP_FILE"' EXIT
awk -v new_val="$NEXT_ITERATION" '
  /^---$/ { delim++; print; next }
  delim == 1 && /^iteration:/ { print "iteration: " new_val; next }
  { print }
' "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# 11. Phase develop → block exit, inject develop prompt
if [[ "$phase" == "develop" ]]; then
  SYSTEM_MSG="ddd-auto iteration $NEXT_ITERATION/$max_iterations | phase: develop | /ddd-auto-cancel to stop"

  jq -n \
    --arg reason "Continue ddd-auto: Read .ddd-auto.local.md to find the 'current' scope item. Execute /ddd-develop for that specific roadmap item. $POLICY_HINT After ddd-develop completes, update the state file: add completed item to 'completed' list (or 'skipped' if BLOCKED), advance 'current' to next incomplete scope item. If no scope items remain incomplete, set phase to 'audit'. Do NOT ask the user for confirmation — proceed automatically." \
    --arg msg "$SYSTEM_MSG" \
    '{"decision": "block", "reason": $reason, "systemMessage": $msg}'
  exit 0
fi

# 12. Phase audit → block exit, inject audit prompt
if [[ "$phase" == "audit" ]]; then
  SYSTEM_MSG="ddd-auto iteration $NEXT_ITERATION | phase: audit | /ddd-auto-cancel to stop"

  jq -n \
    --arg reason "Continue ddd-auto: Execute /ddd-audit (full project audit). After audit completes, update .ddd-auto.local.md: set phase to 'done'. Then generate the final ddd-auto execution report summarizing all completed items, skipped items, key decisions, and audit results." \
    --arg msg "$SYSTEM_MSG" \
    '{"decision": "block", "reason": $reason, "systemMessage": $msg}'
  exit 0
fi

# Fallback: unknown phase → allow exit
echo "ddd-auto: Unknown phase '$phase'. Stopping loop." >&2
rm -f "$STATE_FILE"
exit 0
