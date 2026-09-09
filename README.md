# Claude Queue Relay

A queue for running many Claude Code tabs at once. One board, in the sidebar or popped
out into its own window, that answers "what needs me?" at a glance.

## What it does

- **Pings and pins.** When a session finishes or needs input it plays a sound, posts a
  macOS notification and an in-window toast, and, if `pinMode` is on, pins that tab to the front (off by default: every Claude tab stays a regular tab). If you are
  already looking at the tab, it stays silent and just moves into Ready.
- **One list, icons tell the story.** Needs-you (⚠ / footer emoji) at the top, running (pulsing dot),
  seen, then idle tabs at the bottom — that's the starting order. Drag any row to put it wherever
  you want; the board remembers your order from then on. `⌃⌘U` goes straight to the most important
  tab (money > waiting > failed > BLOCKED lane > landed lane > file > ready, oldest first); `⌃⌘J`
  opens a picker of every tab and lane.
- **Tab groups.** The folder icon above the list makes a new group; drag rows onto its header to
  add them, drag the header itself to reorder past other rows and groups. Click the name to
  rename it in place, the dot to pick one of 8 muted colors, the chevron to collapse it. The ✕ on
  a group's header ungroups its tabs (they stay open) without closing anything.
- **Parked.** A fixed shelf pinned above the relay lanes, not a tab group — click it to slide it
  open, drag any row onto it (open or closed) to park that tab, drag a parked row back into the
  list to unpark it. Sidebar and a popped-out board share the same groups/order/Parked state, so
  popping the board out never starts you over.
- **The focused tab stands out.** Whichever tab is active gets a gold-tinted row with a left
  accent bar, bold brighter text, and its close ✕ stays visible without a hover — not just the
  tab under your mouse.
- **Mute.** `⇧⌥⌘J` (or the speaker icon, or `touch ~/.claude-queue-relay/quiet`) holds all
  pings until you unmute; money / failed / BLOCKED lanes still break through; one digest of
  what landed when you unmute.
- **Relay lanes (optional, off by default).** Point `claudeQueueRelay.relayLanes` at any
  folders you like — `relay-kit/` has a one-command setup and the full how-it-works. A tab that
  sends a task to a lane gets that lane's number as its icon and appears under the lane; its title becomes
  `<status>N️⃣ <task name>` where ▶️ = in flight, ⏭️ = next up, ⏳ = queued behind, ✅ = landed,
  ⚠️ = blocked, re-synced as the queue moves. Lanes show READY → RUNNING → COMPLETE | PARTIAL | BLOCKED (BLOCKED = caution, and it
  moves into "Waiting on you"), expand to Result / Now / Queued items, and clicking a lane
  opens its Cowork session.
- **Usage meters.** A 5-hour line meter plus 7-day and per-model rings (used part solid gold,
  unused part dotted) with reset countdowns, from the same call `/usage` makes; credits on hover.
- **Closed is gone.** ⌘W a Claude tab and its row leaves the board at once; ⌘⇧T brings it back.
  Hover a row and a gold ✕ appears at its right edge (it lingers at half strength for a second
  after you leave); clicking it closes that tab too.
- **Focus-safe.** Pins and renames switch tabs for a moment, so they wait until you stop typing
  (log says `deferred …`) and give up after 10 minutes. Nothing steals a keystroke.
- **Peek.** `⌃⌘.` lists what every finished tab said (its first line), newest first; Enter jumps
  there. Ready rows show that line as their text too.
- **Sweep 🤙.** `⌃⌘⌫` (or the broom icon) lists your tabs with the 🤙-done ones pre-checked and
  closes the ones you confirm; `⌘⇧T` reopens.
- **Snooze.** Hover a finished or waiting row and click 💤: 30 minutes, 2 hours, or until a lane
  lands. The row drops to the bottom and pings again when it's time. Survives a reload.
- **Every lane read-out ends in a button.** Under a lane's tasks: the state in bold gold, what
  the result said, then NEXT and the buttons that do it. **Clear it** files the whole job in
  `relay/archive/` (inbox copy, result, any queue duplicate and the unconsumed receipt, all
  keyed by TASK_ID) and empties the lane. **Send it again** flips the inbox copy back to READY
  and kicks Cowork. Nothing needs a hover to be found.
- **Lane check-up.** The pulse icon next to ⇄ carries a gold count, and any lane number whose
  lane needs a look breathes a gold outline, when a lane has something that
  won't fix itself: a task whose tab is gone (orphan), one waiting more than 7 days (stale), a
  RUNNING task with no output for 2 hours (stuck), a BLOCKED result, a task **wedged** in the
  inbox with a status drain.sh skips, a result **lingering** half an hour after you took it, a
  READY lane with no Cowork session, or VS Code missing Accessibility. Each comes with its buttons: Dismiss
  (archives it as CANCELLED / CONSUMED and empties the slot), Attach to tab…, Start, Re-kick
  Cowork, Reset to READY, Open Cowork, Receive. Hover any task in a lane drawer for ✕ = Dismiss.
- **Age colors.** Waiting rows turn amber after 20 minutes and red after 60; a running tab
  with no activity for 20 minutes is flagged.
- **Receive.** In a lane's drawer, Receive puts the landed result in front of the tab that asked
  for it: it focuses that tab and types `check relay N` + Enter (needs Accessibility for VS Code).
- **Even out the lanes.** The ⇄ button moves queued tasks from the fullest lane to the emptiest
  (never the task in flight, never chained tasks) and re-tags the sending tab to its new lane.
- **Shortcuts.** The keycap icon slides up a sheet listing every hotkey and board gesture.
- **Pop out.** The "Pop out" button opens the board as an editor and moves it into its own
  window; drag it to a second screen and use View: Toggle Full Screen.

### Status footer

The last few lines of each reply are scanned for a status-footer convention:
🤙 done · ⚠️ needs you · 💸 money gate · ⏳ background · 1️⃣2️⃣3️⃣ awaiting a relay lane ·
📂 file waiting · ❌ failed — the bolded ask on a ⚠️ / 💸 / 📂 line becomes the row's text.
Don't use that convention? Rows just fall back to a generic "seen" state — nothing breaks,
you just don't get the emoji-driven row text. To match your own vocabulary, edit the
`GATES` / `REST` tables in `src/footer.ts` and rebuild.

## How it works

1. `Claude Queue Relay: Install Claude Code Hooks` writes `~/.claude-queue-relay/emit.sh` and
   registers it in `~/.claude/settings.json` for `Stop`, `UserPromptSubmit`,
   `PermissionRequest`, `PreToolUse` (AskUserQuestion / ExitPlanMode), `PostToolUse`,
   `Notification`, `SessionStart/End`. The script spools each hook's JSON into
   `~/.claude-queue-relay/events/` and prints nothing, so Claude's behavior never changes.
2. Every VS Code window reads the spool and keeps the sessions whose `cwd` is inside its
   workspace folders (worktrees under the repo count).
3. A session is matched to its tab by the tab that was active when the prompt was
   submitted, else by title (`ai-title` / `custom-title` lines in the transcript; a custom
   title wins however old it is, like Claude's own tab; Claude Code truncates labels to
   ~24 chars, so matching is prefix-based). Lane prefixes are always put on the AI title,
   so a tab gets its own name back when its task is done; a name you gave a tab yourself
   is never touched.
4. A session that writes a lane's `inbound.md` / `queue/*.md` is the one waiting on that
   lane; reading the lane's `outbound.md` releases it.
5. VS Code cannot reorder, rename, or pin an inactive tab, so those actions briefly activate
   the tab and restore yours. Renaming goes through Claude Code's own rename box via the
   clipboard.

## Build and install

```sh
npm install
npm run compile
npm run package            # claude-queue-relay-<version>.vsix
code --install-extension claude-queue-relay-*.vsix --force
npm run install-hooks      # or the command palette entry
```

New windows pick it up immediately; already-open windows need `Developer: Reload Window`.
Log: `Claude Queue Relay: Open Log`, or `~/.claude-queue-relay/log.txt`.

## Settings

`claudeQueueRelay.pinMode` (immediate | onNextSwitch | off, default off), `sound`, `macNotification`,
`toast`, `markUnread`, `pinnedRow`, `relayLanes` (default `[]`), `extraRoots`. Mute is a mode, not a setting.

## Relay lanes

Optional, off by default. `Claude Queue Relay: Set Up Relay Lanes` (command palette) scaffolds
folders and wires the setting for you; see `relay-kit/README.md` for the full setup, prerequisites,
and the day-to-day send / drain / receive loop.

## License

MIT — see `LICENSE`.
