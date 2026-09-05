# Claude Tab Queue

A queue for running many Claude Code tabs at once. One board, in the sidebar or popped
out into its own window, that answers "what needs me?" at a glance.

## What it does

- **Pings and pins.** When a session finishes or needs input it plays a sound, posts a
  macOS notification and an in-window toast, and pins that tab to the front. If you are
  already looking at the tab, it stays silent and just moves into Ready.
- **Next / Jump.** `⌃⌘U` goes straight to the most important tab (money gate > waiting >
  failed > BLOCKED lane > landed lane > file > ready, oldest first). `⌃⌘J` opens a picker
  of every tab and lane. The status bar shows only the Next item.
- **Quiet for an hour.** `⇧⌥⌘J` (or the board button, or `touch ~/.claude-tab-queue/quiet`)
  holds all pings for 60 minutes; money / failed / BLOCKED lanes still break through; one
  digest when it ends.
- **Relay lanes.** Watches `~/Documents/hk-relay{,-2,-3}`. A tab that sends a task to a lane
  gets that lane's number as its icon, is renamed `N️⃣ <task name>`, and appears under the
  lane. Lanes show READY → RUNNING → COMPLETE | PARTIAL | BLOCKED (BLOCKED = caution, and it
  moves into "Waiting on you"), expand to Result / Now / Queued items, and clicking a lane
  opens its Cowork session.
- **Usage rings.** 5-hour, 7-day and per-model limits with reset countdowns, from the same
  call `/usage` makes, plus credits used.
- **Age colors.** Waiting rows turn amber after 20 minutes and red after 60; a running tab
  with no activity for 20 minutes is flagged.
- **Pop out.** The "Pop out" button opens the board as an editor and moves it into its own
  window; drag it to a second screen and use View: Toggle Full Screen.

The last lines of each reply are read for the hk-ops status footer (🤙 ⚠️ 💸 ⏳ 1️⃣2️⃣3️⃣ 📂 ❌)
and the bolded ask on a ⚠️ / 💸 / 📂 line becomes the row text.

## How it works

1. `Claude Tab Queue: Install Claude Code Hooks` writes `~/.claude-tab-queue/emit.sh` and
   registers it in `~/.claude/settings.json` for `Stop`, `UserPromptSubmit`,
   `PermissionRequest`, `PreToolUse` (AskUserQuestion / ExitPlanMode), `PostToolUse`,
   `Notification`, `SessionStart/End`. The script spools each hook's JSON into
   `~/.claude-tab-queue/events/` and prints nothing, so Claude's behavior never changes.
2. Every VS Code window reads the spool and keeps the sessions whose `cwd` is inside its
   workspace folders (worktrees under the repo count).
3. A session is matched to its tab by the tab that was active when the prompt was
   submitted, else by title (`ai-title` / `custom-title` lines in the transcript; Claude
   Code truncates labels to ~24 chars, so matching is prefix-based).
4. A session that writes a lane's `inbound.md` / `queue/*.md` is the one waiting on that
   lane; reading the lane's `outbound.md` releases it.
5. VS Code cannot reorder, rename, or pin an inactive tab, so those actions briefly activate
   the tab and restore yours. Renaming goes through Claude Code's own rename box via the
   clipboard.

## Build and install

```sh
npm install
npm run compile
npm run package            # claude-tab-queue-<version>.vsix
code --install-extension claude-tab-queue-*.vsix --force
npm run install-hooks      # or the command palette entry
```

New windows pick it up immediately; already-open windows need `Developer: Reload Window`.
Log: `Claude Tab Queue: Open Log`, or `~/.claude-tab-queue/log.txt`.

## Settings

`claudeTabQueue.pinMode` (immediate | onNextSwitch | off), `sound`, `macNotification`,
`toast`, `markUnread`, `pinnedRow`, `relayLanes`, `extraRoots`. Quiet is a mode, not a setting.
