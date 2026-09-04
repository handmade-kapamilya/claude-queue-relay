import * as vscode from 'vscode';
import * as path from 'path';
import { Session, SessionRegistry } from './sessions';
import { Lane, LaneTask, RelayWatcher, laneLook, laneTaskLabel, taskLook } from './relay';
import * as tabs from './tabs';

export interface Row {
  key: string;
  label: string;
  tab?: vscode.Tab;
  session?: Session;
  lanes: number[];
}

type Node =
  | { kind: 'section'; key: string; label: string; children: Node[] }
  | { kind: 'row'; key: string; row: Row }
  | { kind: 'lane'; lane: Lane }
  | { kind: 'task'; lane: Lane; task: LaneTask };

const LANE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

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

function themed(icon: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
}

function stateIcon(s: Session | undefined): vscode.ThemeIcon {
  if (!s) return themed('circle-outline');
  if (s.state === 'waiting') return themed('warning', 'charts.yellow');
  if (s.state === 'ready') {
    if (s.seenAt) return themed('check');
    switch (s.signal?.kind) {
      case 'failed':
        return themed('error', 'charts.red');
      case 'money':
        return themed('credit-card', 'charts.orange');
      case 'needs-you':
      case 'file':
        return themed('warning', 'charts.orange');
      case 'background':
        return themed('watch', 'charts.blue');
      default:
        return themed('check', 'charts.green');
    }
  }
  if (s.state === 'running') return themed('sync~spin');
  return themed('circle-outline');
}

export class QueueView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly relay: RelayWatcher,
    private readonly mediaDir: vscode.Uri,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots();
    if (node.kind === 'section') return node.children;
    if (node.kind === 'lane') return this.laneChildren(node.lane);
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.key}`;
        item.contextValue = 'section';
        return item;
      }
      case 'lane':
        return this.laneItem(node.lane);
      case 'task':
        return this.taskItem(node.lane, node.task);
      default:
        return this.rowItem(node.key, node.row);
    }
  }

  // Every open Claude tab in tab-bar order, each joined to its session when one is known,
  // followed by sessions that have no tab in this window (terminal sessions etc.).
  rows(): Row[] {
    const sessions = [...this.registry.sessions.values()].filter((s) => s.state !== 'ended');
    const used = new Set<Session>();
    const rows: Row[] = [];
    tabs.claudeTabs().forEach((tab, i) => {
      const session =
        sessions.find((s) => !used.has(s) && s.tab === tab) ??
        sessions.find((s) => !used.has(s) && !!s.title && tabs.labelMatches(tab.label, s.title)) ??
        sessions.find((s) => !used.has(s) && !s.title && s.tabLabel === tab.label);
      if (session) used.add(session);
      const label = session?.title ?? tab.label;
      rows.push({ key: session ? `s:${session.id}` : `t:${i}:${tab.label}`, label, tab, session, lanes: this.lanesFor(session, label, tab.label) });
    });
    for (const s of sessions) {
      if (used.has(s)) continue;
      rows.push({ key: `s:${s.id}`, label: sessionLabel(s), session: s, lanes: this.lanesFor(s, s.title, s.tabLabel) });
    }
    return rows;
  }

  private lanesFor(session: Session | undefined, ...labels: Array<string | undefined>): number[] {
    const lanes = new Set<number>(session?.lanes ?? []);
    for (const n of this.relay.lanesFor(labels)) lanes.add(n);
    return [...lanes].sort();
  }

  private roots(): Node[] {
    const rows = this.rows();
    const bySince = (a: Row, b: Row) => (b.session?.since ?? 0) - (a.session?.since ?? 0);
    const waiting = rows.filter((r) => r.session?.state === 'waiting').sort(bySince);
    const ready = rows.filter((r) => r.session?.state === 'ready' && !r.session.seenAt).sort(bySince);
    const mk = (section: string, list: Row[]): Node[] => list.map((row) => ({ kind: 'row', key: `${section}:${row.key}`, row }) as Node);
    return [
      { kind: 'section', key: 'waiting', label: `Waiting on you (${waiting.length})`, children: mk('waiting', waiting) },
      { kind: 'section', key: 'ready', label: `Ready (${ready.length})`, children: mk('ready', ready) },
      { kind: 'section', key: 'tabs', label: `Tabs (${rows.length})`, children: mk('tabs', rows) },
      { kind: 'section', key: 'relay', label: 'Relay lanes', children: this.relay.lanes.map((lane) => ({ kind: 'lane', lane }) as Node) },
    ];
  }

  private laneChildren(lane: Lane): Node[] {
    const out: Node[] = [];
    if (lane.result) out.push({ kind: 'task', lane, task: lane.result });
    if (lane.current) out.push({ kind: 'task', lane, task: lane.current });
    for (const task of lane.queue) out.push({ kind: 'task', lane, task });
    return out;
  }

  private laneIcon(n: number): vscode.TreeItem['iconPath'] {
    if (n < 1 || n > 5) return themed('symbol-number', 'charts.blue');
    return {
      light: vscode.Uri.joinPath(this.mediaDir, `lane-${n}-light.svg`),
      dark: vscode.Uri.joinPath(this.mediaDir, `lane-${n}-dark.svg`),
    };
  }

  private rowItem(key: string, row: Row): vscode.TreeItem {
    const s = row.session;
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = `row:${key}`;
    const laneTag = row.lanes.map((n) => LANE_EMOJI[n - 1] ?? `#${n}`).join('');
    const prefix = laneTag ? `${laneTag} ` : '';
    if (s) {
      const signal = s.signal && s.signal.kind !== 'lane' ? `${s.signal.emoji} ` : '';
      item.description = `${prefix}${signal}${s.reason ?? s.state} · ${ago(s.since)}${row.tab ? '' : ' · no tab here'}`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${row.label}**\n\n${s.reason ?? s.state}${row.lanes.length ? ` · relay lane ${row.lanes.join(', ')}` : ''}\n\n`);
      if (s.lastMessage) md.appendCodeblock(tail(s.lastMessage, 600), 'text');
      md.appendMarkdown(`\n\n${s.cwd}`);
      item.tooltip = md;
      item.command = { command: 'claudeTabQueue.goToSession', title: 'Go to session', arguments: [s.id] };
    } else {
      item.description = `${prefix}no activity yet`;
      item.tooltip = row.label;
      item.command = { command: 'claudeTabQueue.goToTab', title: 'Go to tab', arguments: [row.tab?.label ?? row.label] };
    }
    if (s?.state === 'waiting') item.iconPath = stateIcon(s);
    else if (row.lanes.length) item.iconPath = this.laneIcon(row.lanes[0]);
    else item.iconPath = stateIcon(s);
    item.contextValue = s ? 'session' : 'tab';
    return item;
  }

  private laneItem(lane: Lane): vscode.TreeItem {
    const children = this.laneChildren(lane);
    const item = new vscode.TreeItem(
      `Lane ${lane.n}`,
      children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `lane:${lane.n}`;
    const look = laneLook(lane);
    item.description = look.description;
    item.tooltip = `${lane.dir}\n${look.description}`;
    item.iconPath = themed(look.icon, look.color);
    item.contextValue = 'lane';
    return item;
  }

  private taskItem(lane: Lane, task: LaneTask): vscode.TreeItem {
    const prefix = task.role === 'result' ? 'Result' : task.role === 'current' ? 'Now' : `Queued #${task.position}`;
    const item = new vscode.TreeItem(`${prefix}: ${laneTaskLabel(task)}`, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${lane.n}:${task.role}:${task.file}`;
    const look = taskLook(task);
    item.description = look.description;
    item.tooltip = `${task.file}\n${task.taskId ?? ''}\n${look.description}`;
    item.iconPath = themed(look.icon, look.color);
    item.command = { command: 'claudeTabQueue.openLaneFile', title: 'Open', arguments: [lane.n, task.file] };
    item.contextValue = 'task';
    return item;
  }
}
