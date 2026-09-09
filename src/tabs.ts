import * as vscode from 'vscode';

// Webview id registered by the official Claude Code extension (anthropic.claude-code).
export const CLAUDE_VIEW_TYPE = 'claudeVSCodePanel';

export interface TabLocation {
  tab: vscode.Tab;
  group: vscode.TabGroup;
  index: number;
}

export function isClaudeTab(tab: vscode.Tab | undefined): tab is vscode.Tab {
  return !!tab && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_VIEW_TYPE);
}

export function claudeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudeTab);
}

export function activeClaudeTab(): vscode.Tab | undefined {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  return isClaudeTab(active) ? active : undefined;
}

// Alex is looking at this tab: it is the active editor of a VS Code window that has OS focus.
// Alex is typing or clicking in this window right now; nothing may steal focus or keystrokes.
export function userBusy(): boolean {
  return vscode.window.state.focused && vscode.window.state.active;
}

export function looking(tab: vscode.Tab): boolean {
  return vscode.window.state.focused && activeClaudeTab()?.label === tab.label;
}

export function locate(tab: vscode.Tab): TabLocation | undefined {
  for (const group of vscode.window.tabGroups.all) {
    const index = group.tabs.indexOf(tab);
    if (index >= 0) return { tab, group, index };
  }
  return undefined;
}

// Claude Code shortens long titles to about 24 characters plus an ellipsis.
export function labelMatches(label: string, title: string): boolean {
  if (label === title) return true;
  const stem = label.endsWith('…') ? label.slice(0, -1) : label.endsWith('...') ? label.slice(0, -3) : undefined;
  return stem !== undefined && stem.length > 0 && title.startsWith(stem);
}

export function findByLabel(title: string, exclude?: Set<vscode.Tab>): vscode.Tab | undefined {
  const candidates = claudeTabs().filter((t) => !exclude?.has(t));
  return candidates.find((t) => t.label === title) ?? candidates.find((t) => labelMatches(t.label, title));
}

const GROUP_FOCUS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map(
  (n) => `workbench.action.focus${n}EditorGroup`,
);

async function run(cmd: string, ...args: unknown[]): Promise<void> {
  await vscode.commands.executeCommand(cmd, ...args);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// VS Code has no API to reorder, pin, or rename a tab that isn't active, so every
// such action briefly activates the target and then restores whatever was active.
export async function activate(tab: vscode.Tab): Promise<boolean> {
  const loc = locate(tab);
  if (!loc) return false;
  const focus = GROUP_FOCUS[loc.group.viewColumn - 1];
  if (!focus) return false;
  await run(focus);
  await run('workbench.action.openEditorAtIndex', loc.index);
  return true;
}

export async function focusClaudeInput(): Promise<void> {
  try {
    await run('claude-vscode.focus');
  } catch {
    // only exists while the Claude Code extension is loaded
  }
}

// The session has no tab in THIS window — it may be closed, or it may simply
// live in another VS Code window (there is no API to see other windows' tabs).
// Ask the Claude Code extension to resume it by id, which opens a fresh tab
// here regardless of where else it's open, then wait for that tab to appear.
export async function resumeSession(sessionId: string, timeoutMs = 5000): Promise<vscode.Tab | undefined> {
  const before = new Set(claudeTabs());
  await run('claude-vscode.editor.open', sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = claudeTabs().find((t) => !before.has(t));
    if (fresh) return fresh;
    await pause(150);
  }
  return activeClaudeTab();
}

async function whileActive<T>(tab: vscode.Tab, work: () => Promise<T>): Promise<T | undefined> {
  const prev = vscode.window.tabGroups.activeTabGroup.activeTab;
  const wasActive = prev === tab;
  if (!wasActive && !(await activate(tab))) return undefined;
  try {
    return await work();
  } finally {
    if (!wasActive && prev) {
      await activate(prev);
      if (isClaudeTab(prev)) await focusClaudeInput();
    }
  }
}

export interface PinOptions {
  markUnread: boolean;
  log: (msg: string) => void;
}

export async function pinToFront(tab: vscode.Tab, opts: PinOptions): Promise<boolean> {
  const wasActive = vscode.window.tabGroups.activeTabGroup.activeTab === tab;
  const done = await whileActive(tab, async () => {
    if (!tab.isPinned) await run('workbench.action.pinEditor');
    await run('moveActiveEditor', { to: 'first', by: 'tab' });
    if (!opts.markUnread || wasActive) return true;
    try {
      await run('claude-vscode.markSessionUnread');
    } catch (err) {
      opts.log(`markSessionUnread failed: ${err}`);
    }
    return true;
  });
  return done === true;
}

// Keyed by label rather than Tab identity: VS Code may hand out a new Tab
// object after a pin/move, but the label survives.
export function closeTab(tab: vscode.Tab): Thenable<boolean> {
  return vscode.window.tabGroups.close(tab, true);
}

export async function unpin(tab: vscode.Tab): Promise<boolean> {
  if (!tab.isPinned) return true;
  const done = await whileActive(tab, async () => {
    await run('workbench.action.unpinEditor');
    return true;
  });
  return done === true;
}

export async function unpinActive(label: string): Promise<boolean> {
  const active = activeClaudeTab();
  if (!active || active.label !== label) return false;
  if (active.isPinned) await run('workbench.action.unpinEditor');
  return true;
}

// Claude Code's rename command only offers an input box, so we feed it through the clipboard:
// the box opens with the current title selected, paste replaces it, Enter accepts.
export async function renameTab(tab: vscode.Tab, name: string): Promise<boolean> {
  const done = await whileActive(tab, async () => {
    const clipboard = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(name);
    try {
      const rename = vscode.commands.executeCommand('claude-vscode.renameSessionTab');
      await pause(200);
      await run('editor.action.clipboardPasteAction');
      await pause(80);
      await run('workbench.action.acceptSelectedQuickOpenItem');
      const outcome = await Promise.race([rename.then(() => 'renamed'), pause(3000).then(() => 'timeout')]);
      if (outcome === 'timeout') await run('workbench.action.closeQuickOpen');
      return outcome === 'renamed';
    } finally {
      await vscode.env.clipboard.writeText(clipboard);
    }
  });
  return done === true;
}
