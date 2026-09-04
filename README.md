# Claude Tab Queue

VS Code extension for running many Claude Code tabs at once. When a session finishes
or needs input it pings you (sound + macOS notification + in-window toast), pins that
tab to the front of the tab bar (its own row), and lists it in a Queue sidebar. It also
watches the hk-relay lanes and pings when a Cowork result lands, pinning the tab named
in the result's `RETURN-TO` line.

## How it works

1. `Install Claude Code Hooks` writes `~/.claude-tab-queue/emit.sh` and registers it in
   `~/.claude/settings.json` for `Stop`, `UserPromptSubmit`, `PermissionRequest`,
   `PreToolUse` (AskUserQuestion / ExitPlanMode), `PostToolUse`, `Notification`,
   `SessionStart/End`. The script just spools the hook's JSON into
   `~/.claude-tab-queue/events/`. It prints nothing, so it never alters Claude's behavior.
2. Every VS Code window watches that spool and keeps the sessions whose `cwd` is inside
   its workspace folders (worktrees under the repo count).
3. A session is matched to its tab by the tab that was active when the prompt was
   submitted, or by title: the CLI writes `{"type":"ai-title"}` / `custom-title` lines
   into the transcript and the Claude Code extension uses that as the tab label.
4. Finished or waiting sessions get pinned to the front. VS Code can't reorder an
   inactive tab, so the extension briefly activates the tab, pins it, moves it first,
   and restores your previous tab. Pins clear when you come back to the tab or submit
   the next prompt.

The last lines of each Claude reply are scanned for the hk-ops status footer
(🤙 ⚠️ 💸 ⏳ 1️⃣2️⃣3️⃣ 📂 ❌) and the emoji is shown in the queue and notifications.

## Build and install

```sh
npm install
npm run compile
npm run package            # writes claude-tab-queue-<version>.vsix
code --install-extension claude-tab-queue-*.vsix
npm run install-hooks      # or the command palette: Claude Tab Queue: Install Claude Code Hooks
```

New windows pick the extension up immediately; already-open windows need
`Developer: Reload Window`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `claudeTabQueue.pinMode` | `immediate` | `immediate`, `onNextSwitch`, or `off` |
| `claudeTabQueue.pinnedRow` | `true` | turn on `workbench.editor.pinnedTabsOnSeparateRow` once |
| `claudeTabQueue.sound` | `true` | system sound per event |
| `claudeTabQueue.macNotification` | `true` | macOS notification via osascript |
| `claudeTabQueue.toast` | `true` | in-window toast with a Go to tab button |
| `claudeTabQueue.markUnread` | `true` | also mark the tab unread with Claude Code's own command |
| `claudeTabQueue.relayLanes` | the 3 hk-relay folders | lanes to watch |
| `claudeTabQueue.extraRoots` | `[]` | extra folders this window should own |

Log: `Claude Tab Queue: Open Log`, or `~/.claude-tab-queue/log.txt`.
