#!/usr/bin/env bash
set -u

IFS= read -r -t 0 _line || true

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" || -z "${CLAUDE_PROJECT_DIR:-}" ]]; then
  exit 0
fi

controller="${CLAUDE_PLUGIN_ROOT}/bin/roadmapctl.mjs"
if [[ ! -f "$controller" ]]; then
  exit 0
fi

result="$(node "$controller" --root "$CLAUDE_PROJECT_DIR" resume --active 2>/dev/null)" || exit 0
run_id="$(node -e '
try {
  const value = JSON.parse(process.argv[1]);
  const actions = new Set(["next", "record", "finish", "close"]);
  if (value.status === "active" && actions.has(value.action) && typeof value.runId === "string") {
    process.stdout.write(value.runId);
  }
} catch {}
' "$result" 2>/dev/null)" || exit 0

if [[ ! "$run_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  exit 0
fi

printf '{"decision":"block","reason":"Resume DDD run %s with ddd-develop; obtain item data from compact roadmapctl output."}\n' "$run_id"
