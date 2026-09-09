#!/usr/bin/env bash
# setup.sh — scaffold N relay lane folders for Claude Queue Relay + Claude Cowork.
#
# Usage:
#   ./setup.sh <base-path-prefix> [lane-count]
#
# Example:
#   ./setup.sh ~/Documents/my-relay 3
#   -> creates ~/Documents/my-relay, ~/Documents/my-relay-2, ~/Documents/my-relay-3
#
# Each lane folder gets: relay/{queue,archive,outbox,data}, empty inbound.md /
# outbound.md, the drain.sh / send.sh / receipts.sh scripts, and a CLAUDE.md
# contract Claude Cowork reads on open. Safe to re-run — it never overwrites an
# existing inbound.md/outbound.md/CLAUDE.md, only fills in what's missing.
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${1:?usage: setup.sh <base-path-prefix> [lane-count]}"
COUNT="${2:-3}"
PREFIX="${PREFIX%/}"

EMPTY_INBOUND='=== TASK HANDOVER -> Cowork ===
TASK_ID:   none
STATUS:    EMPTY
=== END ===
'
EMPTY_OUTBOUND='=== RESULTS HANDOVER -> VS Code ===
TASK_ID:   none
STATUS:    EMPTY
=== END ===
'

lanes=()
for n in $(seq 1 "$COUNT"); do
  dir="$PREFIX"; [ "$n" != "1" ] && dir="${PREFIX}-${n}"
  lanes+=("$dir")
done

for i in "${!lanes[@]}"; do
  n=$((i + 1))
  dir="${lanes[$i]}"
  relay="$dir/relay"
  mkdir -p "$relay/queue" "$relay/archive" "$relay/outbox" "$relay/data"
  [ -f "$relay/inbound.md" ] || printf '%s' "$EMPTY_INBOUND" > "$relay/inbound.md"
  [ -f "$relay/outbound.md" ] || printf '%s' "$EMPTY_OUTBOUND" > "$relay/outbound.md"
  cp "$KIT/scripts/drain.sh" "$KIT/scripts/send.sh" "$KIT/scripts/receipts.sh" "$relay/"
  chmod +x "$relay"/*.sh

  if [ "$COUNT" -gt 1 ]; then
    table=$'\n\n| Lane | Folder |\n|---|---|\n'
    for j in "${!lanes[@]}"; do
      table+="| ${lanes[$j]} | \`${lanes[$j]}\` |"$'\n'
    done
    note=" A second, independent lane runs in parallel at \`${lanes[1]}\` (and more, see the table below). Each Cowork session binds to ONE lane and runs that lane's own \`drain.sh\`."
  else
    table=""
    note=""
  fi

  if [ ! -f "$dir/CLAUDE.md" ]; then
    # Plain bash substitution, not sed -e, because $dir/$note/$table can contain
    # '/' and '|' — either would break sed's delimiter no matter which char is picked.
    tpl="$(cat "$KIT/CLAUDE.md.template")"
    tpl="${tpl//\{\{LANE_N\}\}/$n}"
    tpl="${tpl//\{\{LANE_DIR\}\}/$dir}"
    tpl="${tpl//\{\{OTHER_LANES_NOTE\}\}/$note}"
    tpl="${tpl//\{\{LANES_TABLE\}\}/$table}"
    printf '%s' "$tpl" > "$dir/CLAUDE.md"
  fi
  echo "✅ lane $n ready: $dir"
done

echo
echo "Paste this into your VS Code settings.json (or Settings UI, search \"Claude Queue Relay\"):"
echo
printf '  "claudeQueueRelay.relayLanes": ['
for i in "${!lanes[@]}"; do
  [ "$i" != "0" ] && printf ','
  printf '\n    "%s"' "${lanes[$i]}"
done
printf '\n  ]\n\n'
echo "Next: open each lane folder as a Claude Cowork window (File > Open Folder), one Cowork"
echo "session per lane. Cowork reads that folder's CLAUDE.md automatically. See relay-kit/README.md"
echo "for the day-to-day send / check / receive loop."
