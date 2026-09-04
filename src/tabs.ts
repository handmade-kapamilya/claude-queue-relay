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

// VS Code has no API to reorder or pin a tab that isn't active, so every
// reorder briefly activates the target and then restores whatever was active.
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
    // command is optional; only exists while the Claude Code extension is loaded
  }
}

export interface PinOptions {
  markUnread: boolean;
  log: (msg: string) => void;
}

export async function pinToFront(tab: vscode.Tab, opts: PinOptions): Promise<boolean> {
  const prev = vscode.window.tabGroups.activeTabGroup.activeTab;
  const wasActive = prev === tab;
  if (!wasActive && !(await activate(tab))) return false;
  try {
    if (!tab.isPinned) await run('workbench.action.pinEditor');
    await run('moveActiveEditor', { to: 'first', by: 'tab' });
    if (opts.markUnread && !wasActive) {
      try {
        await run('claude-vscode.markSessionUnread');
      } catch (err) {
        opts.log(`markSessionUnread failed: ${err}`);
      }
    }
  } finally {
    if (!wasActive && prev) {
      await activate(prev);
      if (isClaudeTab(prev)) await focusClaudeInput();
    }
  }
  return true;
}

export function activeClaudeTab(): vscode.Tab | undefined {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  return isClaudeTab(active) ? active : undefined;
}

// Keyed by label rather than Tab identity: VS Code may hand out a new Tab
// object after a pin/move, but the label survives.
export async function unpinActive(label: string): Promise<boolean> {
  const active = activeClaudeTab();
  if (!active || active.label !== label) return false;
  if (active.isPinned) await run('workbench.action.unpinEditor');
  return true;
}
