#!/usr/bin/env bash
# drain.sh — Cowork runs THIS (not wait.sh) to get the next task in this lane.
#
# It NEVER blocks. It prints the next task to work and exits 0, or prints EMPTY
# and exits 1 when there's nothing. Cowork's loop is simply:
#   run drain.sh -> if it prints a task, do it, write outbound -> run drain.sh again
#   -> when it says EMPTY, stop.
#
# RECEIPT DURABILITY (2026-09-05): outbound.md is a single slot, so the next task's
# receipt used to bury the previous one — if you drained the queue before the matching
# VSCode tab checked in, its result vanished from the live file. Now EVERY invocation
# first preserves whatever receipt is sitting in outbound.md into outbox/<TASK_ID>.md,
# where it stays until the VSCode side explicitly consumes it (./relay/receipts.sh).
# outbox/ is the unconsumed-results inbox; archive/ stays the historical record.
#
# Path-relative (works on any mount path — no hardcoded $HOME). Cross-platform sed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="$DIR/inbound.md"; OUT="$DIR/outbound.md"; Q="$DIR/queue"; AR="$DIR/archive"; OB="$DIR/outbox"
mkdir -p "$Q" "$AR" "$OB"

# NOTE (2026-09-06): the `|| true` guards are load-bearing. Under `set -euo pipefail`,
# a grep that finds nothing fails the whole pipeline, so on a file with no TASK_ID/STATUS
# line (an empty outbound.md, for instance) the bare assignment `tid="$(taskid "$OUT")"`
# aborted the entire script — silently, exit 1, before it ever looked at inbound.md. Any
# lane with an empty outbound.md therefore reported EMPTY forever and could never serve a
# task, however much was queued. Lane 3 was wedged exactly this way. Do not remove.
status() { { grep -m1 '^STATUS:' "$1" 2>/dev/null || true; } | sed -E 's/^STATUS:[[:space:]]*//' | tr -d '\r'; }
taskid() { { grep -m1 '^TASK_ID:' "$1" 2>/dev/null || true; } | sed -E 's/^TASK_ID:[[:space:]]*//' | tr -d '\r'; }

# Preserve the receipt currently in outbound.md so the next one can't bury it.
# Runs on EVERY invocation, so it also catches ad-hoc tasks dispatched straight in
# Cowork's chat (no inbound.md), not just queue promotions.
preserve_receipt() {
  [ -f "$OUT" ] || return 0
  local tid; tid="$(taskid "$OUT")"
  [ -n "${tid:-}" ] && [ "$tid" != "none" ] || return 0

  # Already consumed by the VSCode side? Nothing to hold onto.
  case "$(status "$OUT")" in CONSUMED*) return 0 ;; esac

  # Unconsumed: park a copy in outbox/ (idempotent — re-drains don't duplicate).
  if [ ! -f "$OB/${tid}.md" ] || ! cmp -s "$OUT" "$OB/${tid}.md"; then
    cp "$OUT" "$OB/${tid}.md"
  fi
  cp "$OUT" "$AR/${tid}.outbound.md" 2>/dev/null || true   # historical record, unchanged
}

preserve_receipt

# A receipt only counts as "done" when it says so. A BLOCKED or PARTIAL receipt next to a
# READY inbound means the task was sent again (Send it again / a VSCode edit flipped it back
# to READY) and must run again. (2026-09-06) Treating any receipt as done promoted the queue
# straight over a re-queued task and archived it unrun — that's how the FBA removal task
# vanished from lane 2 without ever executing.
receipt_done() {
  [ -f "$1" ] || return 1
  case "$(status "$1")" in COMPLETE*|CONSUMED*) return 0 ;; esac
  return 1
}

# 1) Inbound is READY → that's the task, unless a COMPLETE/CONSUMED receipt already exists.
#    (2026-09-05) drain.sh only skips inbound when Cowork has flipped its STATUS off
#    READY. When that flip is missed, the lane re-serves a finished task forever and
#    never reaches the queue — lane 3 wedged exactly this way on 2026-09-04.
if [ -f "$IN" ] && [ "$(status "$IN")" = "READY" ]; then
  in_id="$(taskid "$IN")"
  if [ -n "${in_id:-}" ] && { receipt_done "$OB/${in_id}.md" || receipt_done "$AR/${in_id}.outbound.md"; }; then
    : # finished — fall through and promote the next task
  else
    cat "$IN"; exit 0
  fi
fi

# 2) Otherwise promote the next queued task into inbound and mark it READY.
#    Order: a task carrying "PRIORITY: high" goes first; otherwise the OLDEST FILE (mtime),
#    which is what "oldest first" always meant. (2026-09-06) The previous `ls | sort` was
#    alphabetical by TASK_ID, so on a same-day queue "amazon-…" jumped ahead of "fba-…"
#    regardless of which was sent first or marked high priority.
next="$(grep -l -E '^PRIORITY:[[:space:]]*(high|HIGH)' "$Q"/*.md 2>/dev/null | head -1 || true)"
[ -n "${next:-}" ] || next="$(ls -tr "$Q"/*.md 2>/dev/null | head -1 || true)"
if [ -n "${next:-}" ]; then
  # Archive whatever inbound holds now (a finished/RUNNING/idle task), for the record.
  if [ -f "$IN" ]; then
    prev="$(taskid "$IN")"; [ -n "${prev:-}" ] && [ "$prev" != "none" ] && cp "$IN" "$AR/${prev}.inbound.md" 2>/dev/null || true
  fi
  # Move the queued file into inbound and flip QUEUED -> READY (portable, no sed -i).
  sed 's/^STATUS:.*/STATUS:    READY/' "$next" > "$IN" && rm -f "$next"
  cat "$IN"; exit 0
fi

pending="$(ls "$OB"/*.md 2>/dev/null | wc -l | tr -d ' ')"
echo "EMPTY — no READY task and no queued tasks in this lane ($DIR). Nothing to do; stop."
[ "${pending:-0}" != "0" ] && echo "(FYI: $pending unconsumed receipt(s) waiting in outbox/ for the VSCode side.)"
exit 1
