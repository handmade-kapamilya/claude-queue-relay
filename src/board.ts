import * as vscode from 'vscode';

export interface Age {
  text: string;
  tier: 'fresh' | 'stale' | 'old';
}

export interface Row {
  key: string;
  label: string;
  sessionId?: string;
  tabLabel?: string;
  state: 'idle' | 'running' | 'ready' | 'waiting';
  emoji?: string;
  text: string;
  age?: Age;
  lanes: number[];
  seen: boolean;
  hasTab: boolean;
}

export interface TaskRow {
  role: 'result' | 'current' | 'queued';
  label: string;
  status: string;
  returnTo?: string;
  file: string;
  position?: number;
}

export interface LaneRow {
  n: number;
  stage: string;
  text: string;
  age?: Age;
  seen: boolean;
  tasks: TaskRow[];
  tabs: Array<{ label: string; sessionId?: string; tabLabel?: string }>;
}

export interface MeterRow {
  label: string;
  percent: number;
  resetsIn?: string;
}

export interface Snapshot {
  quiet?: { until: number; held: number };
  usage?: { meters: MeterRow[]; spend?: string; error?: string };
  next?: { label: string; text: string };
  blockedLanes: LaneRow[];
  waiting: Row[];
  ready: Row[];
  tabs: Row[];
  lanes: LaneRow[];
}

export type BoardMessage =
  | { type: 'goToSession'; id: string }
  | { type: 'goToTab'; label: string }
  | { type: 'openCowork'; n: number }
  | { type: 'openLaneFile'; n: number; file?: string }
  | { type: 'popOut' }
  | { type: 'toggleQuiet' }
  | { type: 'next' }
  | { type: 'ready' };

// One HTML board, shown in the sidebar and, popped out, as an editor that can float on a sidecar.
export class Board implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private last?: Snapshot;

  constructor(private readonly onMessage: (m: BoardMessage) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.wire(view.webview, view.onDidDispose);
    view.onDidDispose(() => (this.view = undefined));
  }

  // Returns true when the panel was just created (and still needs moving to its own window).
  popOut(): boolean {
    if (this.panel) {
      this.panel.reveal();
      return false;
    }
    const panel = vscode.window.createWebviewPanel('claudeTabQueue.board', 'Claude Queue', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    this.wire(panel.webview, panel.onDidDispose);
    panel.onDidDispose(() => (this.panel = undefined));
    return true;
  }

  show(snapshot: Snapshot): void {
    this.last = snapshot;
    for (const webview of [this.view?.webview, this.panel?.webview]) void webview?.postMessage({ type: 'snapshot', snapshot });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private wire(webview: vscode.Webview, onDidDispose: vscode.Event<void>): void {
    webview.options = { enableScripts: true };
    webview.html = html();
    const sub = webview.onDidReceiveMessage((m: BoardMessage) => {
      if (m.type !== 'ready') return this.onMessage(m);
      if (this.last) void webview.postMessage({ type: 'snapshot', snapshot: this.last });
    });
    onDidDispose(() => sub.dispose());
  }
}

const CSS = `
body { margin: 0; padding: 8px 10px 20px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
.header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.rings { width: 84px; height: 84px; flex: none; }
.rings circle { fill: none; stroke-width: 6; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; }
.track { stroke: var(--vscode-widget-border, rgba(128,128,128,.3)); }
.legend { font-size: 12px; line-height: 1.55; color: var(--vscode-descriptionForeground); min-width: 0; }
.legend b { color: var(--vscode-foreground); }
.toolbar { display: flex; gap: 6px; margin-left: auto; }
button { font: inherit; font-size: 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 3px 9px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.on { background: var(--vscode-charts-yellow); color: #1b1b1b; }
.nextcard { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-focusBorder); cursor: pointer; margin: 6px 0 4px; }
.nextcard:hover { background: var(--vscode-list-hoverBackground); }
.k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.nextcard .label { font-weight: 600; margin: 2px 0; }
h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 14px 0 3px; font-weight: 600; }
.row { display: flex; gap: 8px; align-items: center; padding: 5px 6px; border-radius: 5px; cursor: pointer; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.icon { width: 18px; height: 18px; flex: none; display: grid; place-items: center; font-size: 13px; }
.body { min-width: 0; flex: 1; }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { font-size: 11.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stale .meta { color: var(--vscode-charts-orange); }
.old .meta { color: var(--vscode-charts-red); }
.stale .label, .old .label { font-weight: 600; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-charts-blue); }
.pulse { animation: pulse 2.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.hollow { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--vscode-descriptionForeground); }
details { margin: 1px 0; }
summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 5px; }
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--vscode-list-hoverBackground); }
.chev { width: 12px; font-size: 10px; color: var(--vscode-descriptionForeground); cursor: pointer; transition: transform .15s; }
details[open] .chev { transform: rotate(90deg); }
.title { cursor: pointer; font-weight: 600; white-space: nowrap; }
.title:hover { text-decoration: underline; }
.children { margin-left: 20px; }
.empty { color: var(--vscode-descriptionForeground); padding: 3px 6px; font-style: italic; font-size: 12px; }
.y { color: var(--vscode-charts-yellow); } .o { color: var(--vscode-charts-orange); } .r { color: var(--vscode-charts-red); }
.g { color: var(--vscode-charts-green); } .b { color: var(--vscode-charts-blue); } .dim { opacity: .6; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const state = vscode.getState() || { open: {} };
const root = document.getElementById('root');
const LANE = ['1\\uFE0F\\u20E3', '2\\uFE0F\\u20E3', '3\\uFE0F\\u20E3', '4\\uFE0F\\u20E3', '5\\uFE0F\\u20E3'];
window.addEventListener('message', function (e) { if (e.data && e.data.type === 'snapshot') render(e.data.snapshot); });
vscode.postMessage({ type: 'ready' });

function send(msg) { vscode.postMessage(msg); }
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function svg(markup) { const w = document.createElement('div'); w.innerHTML = markup; return w.firstElementChild; }
function laneMark(n) { return LANE[n - 1] || ('#' + n); }
function numIcon(n) {
  return svg('<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="1.5"/><text x="8" y="8.7" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="700" font-family="inherit" fill="var(--vscode-charts-blue)">' + n + '</text></svg>');
}
function rowIcon(r) {
  if (r.state === 'waiting') return el('span', 'y', '\\u26A0');
  if (r.lanes.length) return numIcon(r.lanes[0]);
  if (r.state === 'ready') return el('span', r.seen ? 'dim' : 'g', r.emoji || '\\u2713');
  if (r.state === 'running') return el('span', 'dot pulse');
  return el('span', 'hollow');
}
function row(r) {
  const d = el('div', 'row ' + (r.age ? r.age.tier : 'fresh'));
  const icon = el('span', 'icon'); icon.appendChild(rowIcon(r)); d.appendChild(icon);
  const body = el('div', 'body');
  body.appendChild(el('div', 'label', r.label));
  const lanes = r.lanes.map(laneMark).join('');
  const emoji = r.emoji && r.state !== 'ready' ? r.emoji + ' ' : '';
  body.appendChild(el('div', 'meta', (lanes ? lanes + ' ' : '') + emoji + r.text + (r.hasTab ? '' : ' \\u00b7 no tab here')));
  d.appendChild(body);
  d.title = r.label + '\\n' + r.text;
  d.onclick = function () { send(r.sessionId ? { type: 'goToSession', id: r.sessionId } : { type: 'goToTab', label: r.tabLabel || r.label }); };
  return d;
}
function blockedRow(l) {
  const d = el('div', 'row old');
  const icon = el('span', 'icon'); icon.appendChild(el('span', 'y', '\\u26A0')); d.appendChild(icon);
  const body = el('div', 'body');
  body.appendChild(el('div', 'label', laneMark(l.n) + ' Relay lane ' + l.n + ' is BLOCKED'));
  body.appendChild(el('div', 'meta', l.text));
  d.appendChild(body);
  d.onclick = function () { send({ type: 'openLaneFile', n: l.n }); };
  return d;
}
function section(title, nodes, emptyText) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('h2', null, title + ' (' + nodes.length + ')'));
  if (!nodes.length) frag.appendChild(el('div', 'empty', emptyText));
  nodes.forEach(function (n) { frag.appendChild(n); });
  return frag;
}
function stageIcon(l) {
  const looks = { running: ['dot pulse', ''], ready: ['b', '\\u25D4'], complete: [l.seen ? 'dim' : 'g', '\\u2713'], partial: ['o', '\\u26A0'], blocked: ['y', '\\u26A0'], abandoned: ['r', '\\u2715'], queued: ['dim', '\\u25D4'], empty: ['hollow', ''] };
  const look = looks[l.stage] || ['', ''];
  return el('span', look[0], look[1]);
}
function taskGlyph(t) {
  if (t.role === 'queued') return ['dim', '\\u25D4'];
  if (t.role === 'current') return ['b', t.status === 'RUNNING' ? '\\u25CF' : '\\u25D4'];
  if (t.status === 'COMPLETE') return ['g', '\\u2713'];
  if (t.status === 'PARTIAL') return ['o', '\\u26A0'];
  if (t.status === 'BLOCKED') return ['y', '\\u26A0'];
  return ['r', '\\u2715'];
}
function child(iconNode, label, meta, onclick) {
  const r = el('div', 'row');
  const i = el('span', 'icon'); i.appendChild(iconNode); r.appendChild(i);
  const b = el('div', 'body'); b.appendChild(el('div', 'label', label)); b.appendChild(el('div', 'meta', meta)); r.appendChild(b);
  r.onclick = onclick;
  return r;
}
function lane(l) {
  const d = document.createElement('details');
  d.open = !!state.open[l.n];
  d.addEventListener('toggle', function () { state.open[l.n] = d.open; vscode.setState(state); });
  const s = el('summary');
  s.appendChild(el('span', 'chev', '\\u25B6'));
  const icon = el('span', 'icon'); icon.appendChild(stageIcon(l)); s.appendChild(icon);
  const t = el('span', 'title', 'Lane ' + l.n);
  t.title = 'Open this lane in Cowork';
  t.onclick = function (e) { e.preventDefault(); e.stopPropagation(); send({ type: 'openCowork', n: l.n }); };
  s.appendChild(t);
  const meta = el('span', 'meta ' + (l.age ? l.age.tier : ''), l.text);
  meta.title = l.text;
  s.appendChild(meta);
  d.appendChild(s);
  const kids = el('div', 'children');
  l.tasks.forEach(function (task) {
    const g = taskGlyph(task);
    const prefix = task.role === 'result' ? 'Result' : task.role === 'current' ? 'Now' : 'Queued #' + task.position;
    kids.appendChild(child(el('span', g[0], g[1]), prefix + ': ' + task.label, task.status + (task.returnTo ? ' \\u2192 \\u00ab' + task.returnTo + '\\u00bb' : ''), function () { send({ type: 'openLaneFile', n: l.n, file: task.file }); }));
  });
  l.tabs.forEach(function (tab) {
    kids.appendChild(child(numIcon(l.n), 'Tab: \\u00ab' + tab.label + '\\u00bb', 'waiting on this lane', function () { send(tab.sessionId ? { type: 'goToSession', id: tab.sessionId } : { type: 'goToTab', label: tab.tabLabel || tab.label }); }));
  });
  if (!l.tasks.length && !l.tabs.length) kids.appendChild(el('div', 'empty', 'nothing queued'));
  d.appendChild(kids);
  return d;
}
function header(s) {
  const wrap = el('div', 'header');
  const meters = s.usage && s.usage.meters ? s.usage.meters.slice(0, 3) : [];
  const radii = [26, 20, 14];
  let circles = '';
  meters.forEach(function (m, i) {
    const r = radii[i], c = 2 * Math.PI * r, off = c * (1 - Math.min(100, m.percent) / 100);
    const col = m.percent >= 90 ? 'var(--vscode-charts-red)' : m.percent >= 70 ? 'var(--vscode-charts-orange)' : 'var(--vscode-charts-blue)';
    circles += '<circle class="track" cx="30" cy="30" r="' + r + '"/><circle cx="30" cy="30" r="' + r + '" stroke="' + col + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/>';
  });
  const center = meters[0] ? Math.round(meters[0].percent) + '%' : '\\u2013';
  wrap.appendChild(svg('<svg class="rings" viewBox="0 0 60 60">' + circles + '<text x="30" y="31" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="700" font-family="inherit" fill="currentColor">' + center + '</text></svg>'));
  const legend = el('div', 'legend');
  if (meters.length) {
    meters.forEach(function (m) {
      const line = el('div');
      line.appendChild(el('b', null, m.label + ' ' + Math.round(m.percent) + '%'));
      if (m.resetsIn) line.appendChild(document.createTextNode(' \\u00b7 resets in ' + m.resetsIn));
      legend.appendChild(line);
    });
    if (s.usage.spend) legend.appendChild(el('div', null, s.usage.spend));
  } else {
    legend.appendChild(el('div', null, s.usage && s.usage.error ? 'usage: ' + s.usage.error : 'usage: loading\\u2026'));
  }
  wrap.appendChild(legend);
  const tools = el('div', 'toolbar');
  const q = el('button', s.quiet ? 'on' : '', s.quiet ? 'Quiet \\u00b7 ' + s.quiet.held + ' held' : 'Quiet 1h');
  q.title = s.quiet ? 'Click to end quiet hour now' : 'Hold all pings for an hour; money / failed / BLOCKED still break through';
  q.onclick = function () { send({ type: 'toggleQuiet' }); };
  tools.appendChild(q);
  const p = el('button', '', 'Pop out');
  p.title = 'Open this board as its own window (drag it to your sidecar, then View: Toggle Full Screen)';
  p.onclick = function () { send({ type: 'popOut' }); };
  tools.appendChild(p);
  wrap.appendChild(tools);
  return wrap;
}
function render(s) {
  const frag = document.createDocumentFragment();
  frag.appendChild(header(s));
  if (s.next) {
    const n = el('div', 'nextcard');
    n.appendChild(el('div', 'k', 'Next \\u00b7 \\u2303\\u2318U'));
    n.appendChild(el('div', 'label', s.next.label));
    n.appendChild(el('div', 'meta', s.next.text));
    n.onclick = function () { send({ type: 'next' }); };
    frag.appendChild(n);
  }
  frag.appendChild(section('Waiting on you', s.blockedLanes.map(blockedRow).concat(s.waiting.map(row)), 'nothing needs you'));
  frag.appendChild(section('Ready', s.ready.map(row), 'nothing new'));
  frag.appendChild(section('Tabs', s.tabs.map(row), 'no Claude tabs open here'));
  frag.appendChild(el('h2', null, 'Relay lanes'));
  s.lanes.forEach(function (l) { frag.appendChild(lane(l)); });
  root.replaceChildren(frag);
}
`;

function html(): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body><div id="root"></div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
