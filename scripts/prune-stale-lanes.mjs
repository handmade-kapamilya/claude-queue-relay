#!/usr/bin/env node
// Prunes stale entries from ~/.claude-tab-queue/lanes.json.
//
// lanes.json maps a relay TASK_ID to the tab/session it's tied to
// (sessionId, title, n, at). Entries are supposed to get cleared when a
// lane result is collected or a task is dismissed, but nothing expires
// them on its own, so a task whose tab you closed weeks ago just sits
// there forever -- harmless to the extension's correctness, but it's
// exactly the kind of stale registry entry that makes the board's state
// look out of sync with reality.
//
// Safety:
// - Only removes entries older than STALE_DAYS. Never touches anything
//   recent, so a task genuinely in flight is never at risk.
// - Skips the whole run if the file was modified in the last SKIP_IF_RECENT_MS
//   -- the extension may be mid-write, and this avoids racing it.
// - Atomic write (temp file + rename), so a crash mid-write can't corrupt
//   the file the extension reads on every snapshot.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LANES_PATH = path.join(os.homedir(), ".claude-tab-queue", "lanes.json");
const STALE_DAYS = 7;
const SKIP_IF_RECENT_MS = 2 * 60 * 1000;
const LOG_PATH = path.join(os.homedir(), ".claude-tab-queue", "prune-lanes.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
}

function main() {
  if (!fs.existsSync(LANES_PATH)) {
    log("lanes.json does not exist, nothing to do");
    return;
  }

  const stat = fs.statSync(LANES_PATH);
  if (Date.now() - stat.mtimeMs < SKIP_IF_RECENT_MS) {
    log("lanes.json modified too recently, skipping this run to avoid racing the extension");
    return;
  }

  let lanes;
  try {
    lanes = JSON.parse(fs.readFileSync(LANES_PATH, "utf8"));
  } catch (e) {
    log(`failed to parse lanes.json, leaving it alone: ${e.message}`);
    return;
  }

  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const kept = {};
  const pruned = [];

  for (const [taskId, entry] of Object.entries(lanes)) {
    const at = typeof entry?.at === "number" ? entry.at : 0;
    if (at && at < cutoff) {
      pruned.push({ taskId, title: entry.title, ageDays: Math.round((Date.now() - at) / 86400000) });
    } else {
      kept[taskId] = entry;
    }
  }

  if (pruned.length === 0) {
    log("no entries older than " + STALE_DAYS + "d, nothing pruned");
    return;
  }

  const tmpPath = LANES_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(kept, null, 1));
  fs.renameSync(tmpPath, LANES_PATH);

  for (const p of pruned) {
    log(`pruned "${p.title}" (task ${p.taskId}, ${p.ageDays}d old)`);
  }
  log(`done: pruned ${pruned.length}, kept ${Object.keys(kept).length}`);
}

main();
