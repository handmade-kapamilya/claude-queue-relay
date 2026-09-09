#!/usr/bin/env bash
# send.sh — queue a new relay task for Cowork in ONE command.
# Mints a unique TASK_ID, archives the previous inbound, writes a clean READY
# handover, and opens it so you can add detail. Cowork (running ./relay/wait.sh
# inbound) then picks it up automatically.
#
# Usage:
#   ./relay/send.sh "Goal text"  ["RETURN-TO thread name"]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INBOUND="$DIR/inbound.md"
ARCHIVE="$DIR/archive"
GOAL="${1:-}"
RETURN_TO="${2:-«VSCode»}"

if [ -z "$GOAL" ]; then
  echo "usage: send.sh \"goal text\" [\"return-to thread\"]" >&2
  exit 2
fi

# Don't clobber a task that's still in flight.
if [ -f "$INBOUND" ]; then
  st="$(grep -m1 '^STATUS:' "$INBOUND" 2>/dev/null | sed -E 's/^STATUS:[[:space:]]*//' | tr -d '\r' || true)"
  if [ "${st:-}" = "RUNNING" ]; then
    echo "⛔ inbound.md holds a RUNNING task — wait for it to finish (or archive it) before sending a new one." >&2
    exit 1
  fi
  # Archive the previous (consumed/idle) inbound for the record.
  prev="$(grep -m1 '^TASK_ID:' "$INBOUND" 2>/dev/null | sed -E 's/^TASK_ID:[[:space:]]*//' | tr -d '\r' || true)"
  if [ -n "${prev:-}" ] && [ "$prev" != "none" ]; then
    mkdir -p "$ARCHIVE"
    cp "$INBOUND" "$ARCHIVE/${prev}.inbound.md" 2>/dev/null || true
  fi
fi

# Unique TASK_ID = date + slug(goal) + short random suffix.
slug="$(echo "$GOAL" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-32 | sed -E 's/^-+|-+$//g')"
TASK_ID="$(date +%Y-%m-%d)-${slug:-task}-$(printf '%04x' "$((RANDOM))")"

cat > "$INBOUND" <<EOF
=== TASK HANDOVER -> Cowork ===
TASK_ID:   ${TASK_ID}
STATUS:    READY
RETURN-TO: ${RETURN_TO}
GOAL:      ${GOAL}

TARGET:    (optional — infer from GOAL if blank: url(s) / account / app)
CAPTURE:   (optional — exact data + columns to grab)
OUTPUT:    (optional — Supabase table(s) and/or relay/data/${TASK_ID}/...)
SUCCESS:   (optional — done-ness check)
SAFETY:    READ-ONLY unless stated. Ask before any side-effecting action.
=== END ===
EOF

echo "✅ Queued ${TASK_ID}"
echo "   → ${INBOUND}"
echo "   Cowork will pick it up on its next wait.sh inbound pass."
# Open it for quick editing (VSCode if available, else default app).
command -v code >/dev/null 2>&1 && code "$INBOUND" >/dev/null 2>&1 || open "$INBOUND" >/dev/null 2>&1 || true
