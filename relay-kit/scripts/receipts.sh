#!/usr/bin/env bash
# receipts.sh — the VSCode side of receipt durability.
#
# outbound.md is one slot, so draining the queue used to bury the previous task's
# result. drain.sh now parks every unconsumed receipt in outbox/<TASK_ID>.md; this
# script is how you see them and clear them.
#
#   ./relay/receipts.sh                 list this lane's unconsumed receipts
#   ./relay/receipts.sh all             list every lane's (which tab is waiting on what)
#   ./relay/receipts.sh show <TASK_ID>  print one receipt in full
#   ./relay/receipts.sh consume <TASK_ID>   mark it CONSUMED and file it into archive/
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/outbound.md"; AR="$DIR/archive"; OB="$DIR/outbox"
mkdir -p "$AR" "$OB"

field() { grep -m1 "^$2:" "$1" 2>/dev/null | sed -E "s/^$2:[[:space:]]*//" | tr -d '\r'; }

# The live outbound.md is a receipt too — sync it in so nothing is invisible.
sync_live_receipt() {
  local lane="${1:-$DIR}" out="${1:-$DIR}/outbound.md" ob="${1:-$DIR}/outbox"
  [ -f "$out" ] || return 0
  local tid; tid="$(field "$out" TASK_ID)"
  [ -n "${tid:-}" ] && [ "$tid" != "none" ] || return 0
  case "$(field "$out" STATUS)" in CONSUMED*) return 0 ;; esac
  mkdir -p "$ob"
  [ -f "$ob/${tid}.md" ] || cp "$out" "$ob/${tid}.md"
}

list_lane() {
  local ob="$1/outbox" n=0
  for f in "$ob"/*.md; do
    [ -e "$f" ] || continue
    n=$((n+1))
    printf '  %-58s %s\n' "$(field "$f" TASK_ID)" "$(field "$f" STATUS | cut -c1-38)"
    printf '      return-to: %s\n' "$(field "$f" RETURN-TO)"
  done
  [ "$n" = "0" ] && printf '  (none waiting)\n'
  return 0
}

case "${1:-list}" in
  list)
    sync_live_receipt "$DIR"
    echo "Unconsumed receipts — $DIR"
    list_lane "$DIR"
    ;;
  all)
    # Sibling lanes are assumed to share this lane's folder-name prefix (e.g.
    # my-relay, my-relay-2, my-relay-3) — no lane count or naming is hardcoded.
    root="$(dirname "$(dirname "$DIR")")"
    self="$(basename "$(dirname "$DIR")")"
    prefix="$(echo "$self" | sed -E 's/-[0-9]+$//')"
    for lane in "$root/$prefix"*/relay; do
      [ -d "$lane" ] || continue
      sync_live_receipt "$lane"
      echo "== $(basename "$(dirname "$lane")") =="
      list_lane "$lane"
    done
    ;;
  show)
    tid="${2:?usage: receipts.sh show <TASK_ID>}"
    cat "$OB/${tid}.md"
    ;;
  consume)
    tid="${2:?usage: receipts.sh consume <TASK_ID>}"
    src="$OB/${tid}.md"
    [ -f "$src" ] || { echo "No unconsumed receipt for $tid in $OB"; exit 1; }
    mkdir -p "$AR/$tid"
    sed "s/^STATUS:.*/&  [CONSUMED $(date -u +%Y-%m-%dT%H:%M:%SZ)]/" "$src" > "$AR/$tid/outbound.md"
    rm -f "$src"
    # If it's still the live receipt, stamp that copy too so it can't come back.
    if [ -f "$OUT" ] && [ "$(field "$OUT" TASK_ID)" = "$tid" ]; then
      sed "s/^STATUS:.*/&  [CONSUMED $(date -u +%Y-%m-%dT%H:%M:%SZ)]/" "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
    fi
    echo "consumed $tid -> $AR/$tid/outbound.md"
    ;;
  *)
    echo "usage: receipts.sh [list|all|show <TASK_ID>|consume <TASK_ID>]"; exit 2 ;;
esac
