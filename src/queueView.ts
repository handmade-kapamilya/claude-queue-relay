import * as vscode from 'vscode';
import * as path from 'path';
import { Session, SessionRegistry } from './sessions';
import { Lane, RelayWatcher, laneSummary } from './relay';

type Node =
  | { kind: 'section'; key: string; label: string; children: Node[] }
  | { kind: 'session'; session: Session }
  | { kind: 'lane'; lane: Lane };

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function sessionLabel(s: Session): string {
  return s.title ?? s.tabLabel ?? `${path.basename(s.cwd)} · ${s.id.slice(0, 8)}`;
}

function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function iconFor(s: Session): vscode.ThemeIcon {
  const color = (c: string) => new vscode.ThemeColor(c);
  if (s.state === 'waiting') return new vscode.ThemeIcon('warning', color('charts.yellow'));
  if (s.state === 'ready') {
    if (s.seenAt) return new vscode.ThemeIcon('check');
    switch (s.signal?.kind) {
      case 'failed':
        return new vscode.ThemeIcon('error', color('charts.red'));
      case 'money':
        return new vscode.ThemeIcon('credit-card', color('charts.orange'));
      case 'needs-you':
      case 'file':
        return new vscode.ThemeIcon('warning', color('charts.orange'));
      case 'lane':
        return new vscode.ThemeIcon('arrow-swap', color('charts.blue'));
      case 'background':
        return new vscode.ThemeIcon('watch', color('charts.blue'));
      default:
        return new vscode.ThemeIcon('check', color('charts.green'));
    }
  }
  if (s.state === 'running') return new vscode.ThemeIcon('sync~spin');
  return new vscode.ThemeIcon('circle-outline');
}

export class QueueView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly relay: RelayWatcher,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots();
    return node.kind === 'section' ? node.children : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `section:${node.key}`;
      item.contextValue = 'section';
      return item;
    }
    if (node.kind === 'lane') {
      const { lane } = node;
      const sum = laneSummary(lane);
      const item = new vscode.TreeItem(`Lane ${lane.n}`, vscode.TreeItemCollapsibleState.None);
      item.id = `lane:${lane.n}`;
      item.description = sum.description;
      item.tooltip = sum.tooltip;
      item.iconPath = new vscode.ThemeIcon(sum.icon, sum.color ? new vscode.ThemeColor(sum.color) : undefined);
      item.command = { command: 'claudeTabQueue.openLane', title: 'Open lane', arguments: [lane.n] };
      item.contextValue = 'lane';
      return item;
    }
    const s = node.session;
    const item = new vscode.TreeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None);
    item.id = `session:${s.id}`;
    const stateText = s.reason ?? s.state;
    item.description = `${s.signal ? `${s.signal.emoji} ` : ''}${stateText} · ${ago(s.since)}${s.tab ? '' : ' · no tab here'}`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${sessionLabel(s)}**\n\n${stateText}\n\n`);
    if (s.lastMessage) md.appendCodeblock(tail(s.lastMessage, 600), 'text');
    md.appendMarkdown(`\n\n${s.cwd}`);
    item.tooltip = md;
    item.iconPath = iconFor(s);
    item.command = { command: 'claudeTabQueue.goToSession', title: 'Go to session', arguments: [s.id] };
    item.contextValue = 'session';
    return item;
  }

  private roots(): Node[] {
    const all = [...this.registry.sessions.values()].filter((s) => s.state !== 'ended');
    const pick = (pred: (s: Session) => boolean): Node[] =>
      all
        .filter(pred)
        .sort((a, b) => b.since - a.since)
        .map((session) => ({ kind: 'session', session }) as Node);
    const waiting = pick((s) => s.state === 'waiting');
    const ready = pick((s) => s.state === 'ready' && !s.seenAt);
    const rest = pick((s) => s.state === 'running' || s.state === 'idle' || (s.state === 'ready' && !!s.seenAt));
    return [
      { kind: 'section', key: 'waiting', label: `Waiting on you (${waiting.length})`, children: waiting },
      { kind: 'section', key: 'ready', label: `Ready (${ready.length})`, children: ready },
      { kind: 'section', key: 'running', label: `Running / idle (${rest.length})`, children: rest },
      {
        kind: 'section',
        key: 'relay',
        label: 'Relay lanes',
        children: this.relay.lanes.map((lane) => ({ kind: 'lane', lane }) as Node),
      },
    ];
  }
}
