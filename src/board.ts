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
  quiet?: { held: number };
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
    this.wire(view.webview, view.onDidDispose, 'sidebar');
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
    this.wire(panel.webview, panel.onDidDispose, 'panel');
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

  private wire(webview: vscode.Webview, onDidDispose: vscode.Event<void>, surface: 'sidebar' | 'panel'): void {
    webview.options = { enableScripts: true };
    webview.html = html(surface);
    const sub = webview.onDidReceiveMessage((m: BoardMessage) => {
      if (m.type !== 'ready') return this.onMessage(m);
      if (this.last) void webview.postMessage({ type: 'snapshot', snapshot: this.last });
    });
    onDidDispose(() => sub.dispose());
  }
}

const CSS = `
body { margin: 0; padding: 8px 10px 132px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
.k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.nextcard { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-focusBorder); cursor: pointer; margin: 2px 0 4px; }
.nextcard:hover { background: var(--vscode-list-hoverBackground); }
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
.empty { color: var(--vscode-descriptionForeground); padding: 3px 6px; font-style: italic; font-size: 12px; }
.y { color: var(--vscode-charts-yellow); } .o { color: var(--vscode-charts-orange); } .r { color: var(--vscode-charts-red); }
.g { color: var(--vscode-charts-green); } .b { color: var(--vscode-charts-blue); } .dim { opacity: .6; }
/* Meter strip: frozen at the bottom while the list scrolls. */
.footer { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); background: var(--vscode-sideBar-background); }
.strip { display: flex; align-items: center; gap: 10px; padding: 7px 10px 0; }
.lanes { display: flex; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
.seg { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 6px 0; cursor: pointer; color: #b79d70; font-weight: 700; font-size: 13px; border-left: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
.seg:first-child { border-left: 0; }
.seg:hover { background: var(--vscode-list-hoverBackground); }
.seg.open { background: #b79d70; color: #1b1b1b; }
.sd { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.drawer { max-height: 0; opacity: 0; overflow: hidden; margin: 0 6px; border-radius: 10px 10px 0 0; transition: max-height .26s ease, opacity .2s ease; }
.drawer.open { max-height: 320px; opacity: 1; overflow: auto; border: 4px solid #b79d70; border-bottom: 0; background: rgba(183,157,112,.12); box-shadow: 0 -8px 22px rgba(0,0,0,.35); }
.drawer .inner { padding: 8px 6px 8px 8px; }
.dh { display: flex; align-items: center; gap: 8px; margin: 0 0 6px 4px; }
.dh b { background: #b79d70; color: #1b1b1b; padding: 1px 9px; border-radius: 999px; font-weight: 700; }
.dh .meta { flex: 1; }
.cw { font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #b79d70; color: #b79d70; cursor: pointer; white-space: nowrap; }
.cw:hover { background: rgba(183,157,112,.18); }
body.panel .footer { background: var(--vscode-editor-background); }
.rings { width: 42px; height: 42px; flex: none; }
.rings circle { fill: none; stroke-width: 3; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; }
.track { stroke: #b79d70; stroke-opacity: .5; stroke-dasharray: 0.9 3.1; }
.bar { position: relative; height: 3px; margin: 8px 10px 3px; background: radial-gradient(circle, rgba(183,157,112,.55) 0.9px, transparent 1.3px) 0 50% / 6px 3px repeat-x; }
.bar .used { position: absolute; left: 0; top: 0; bottom: 0; background: #b79d70; border-radius: 2px; }
.bartext { padding: 0 10px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bartext b { color: #b79d70; font-weight: 600; }
.legend { font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; }
.legend b { color: #b79d70; font-weight: 600; }
.legend .l2 b { opacity: .62; }
.tools { display: flex; gap: 4px; flex: none; }
.ib { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 5px; color: var(--vscode-descriptionForeground); cursor: pointer; }
.ib:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
.ib.on { color: #b79d70; background: rgba(183, 157, 112, .18); }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const state = vscode.getState() || { openLane: null };
let current = { blockedLanes: [], waiting: [], ready: [], tabs: [], lanes: [] };
let shownLane = null;
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
function stageMark(l) {
  if (l.stage === 'blocked') return el('span', 'y', '\\u26A0');
  const cls = { running: 'sd pulse b', ready: 'sd b', complete: l.seen ? 'sd dim' : 'sd g', partial: 'sd o', abandoned: 'sd r', queued: 'sd dim' }[l.stage];
  return cls ? el('span', cls) : null;
}
function laneBar(s) {
  const bar = el('div', 'lanes');
  s.lanes.forEach(function (l) {
    const seg = el('div', 'seg' + (state.openLane === l.n ? ' open' : ''));
    seg.appendChild(el('span', null, String(l.n)));
    const mark = stageMark(l);
    if (mark) seg.appendChild(mark);
    seg.title = 'Lane ' + l.n + ' \\u00b7 ' + l.text;
    seg.onclick = function () {
      if (state.openLane === l.n) return closeDrawer();
      state.openLane = l.n; vscode.setState(state); render(current);
    };
    bar.appendChild(seg);
  });
  return bar;
}
function closeDrawer() {
  const d = document.querySelector('.drawer');
  if (d) d.classList.remove('open');
  setTimeout(function () { state.openLane = null; shownLane = null; vscode.setState(state); render(current); }, 260);
}
function drawer(s) {
  const d = el('div', 'drawer');
  const l = s.lanes.find(function (x) { return x.n === state.openLane; });
  if (!l) return d;
  if (shownLane === l.n) d.classList.add('open');
  else requestAnimationFrame(function () { requestAnimationFrame(function () { d.classList.add('open'); }); });
  shownLane = l.n;
  const inner = el('div', 'inner');
  const head = el('div', 'dh');
  head.appendChild(el('b', null, 'Lane ' + l.n));
  head.appendChild(el('span', 'meta ' + (l.age ? l.age.tier : ''), l.text));
  const cw = el('span', 'cw', 'Cowork \\u2197');
  cw.title = 'Open this lane in Cowork';
  cw.onclick = function () { send({ type: 'openCowork', n: l.n }); };
  head.appendChild(cw);
  inner.appendChild(head);
  l.tasks.forEach(function (task) {
    const g = taskGlyph(task);
    const prefix = task.role === 'result' ? 'Result' : task.role === 'current' ? 'Now' : 'Queued #' + task.position;
    inner.appendChild(child(el('span', g[0], g[1]), prefix + ': ' + task.label, task.status + (task.returnTo ? ' \\u2192 \\u00ab' + task.returnTo + '\\u00bb' : ''), function () { send({ type: 'openLaneFile', n: l.n, file: task.file }); }));
  });
  l.tabs.forEach(function (tab) {
    inner.appendChild(child(numIcon(l.n), 'Tab: \\u00ab' + tab.label + '\\u00bb', 'waiting on this lane', function () { send(tab.sessionId ? { type: 'goToSession', id: tab.sessionId } : { type: 'goToTab', label: tab.tabLabel || tab.label }); }));
  });
  if (!l.tasks.length && !l.tabs.length) inner.appendChild(el('div', 'empty', 'nothing queued'));
  d.appendChild(inner);
  return d;
}
const GOLD = '#b79d70';
const MUTE = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.6L8 3.5v9L5.1 10H2.5z"/><path d="M10.5 6.5l3 3M13.5 6.5l-3 3"/></svg>';
const POPOUT = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5H3.5v9h9V9"/><path d="M9.5 3h3.5v3.5M13 3L7.5 8.5"/></svg>';
function iconButton(markup, title, on, onclick) {
  const b = el('span', 'ib' + (on ? ' on' : ''));
  b.appendChild(svg(markup)); b.title = title; b.onclick = onclick;
  return b;
}
function footer(s) {
  const bar = el('div', 'footer');
  bar.appendChild(drawer(s));
  bar.appendChild(laneBar(s));
  const strip = el('div', 'strip');
  const all = s.usage && s.usage.meters ? s.usage.meters : [];
  const five = all.find(function (m) { return m.label === '5h'; });
  const meters = all.filter(function (m) { return m !== five; }).slice(0, 2);
  const radii = [17, 11.4], alpha = [1, 0.62];
  let circles = '';
  meters.forEach(function (m, i) {
    const r = radii[i], c = 2 * Math.PI * r, off = c * (1 - Math.min(100, m.percent) / 100);
    circles += '<circle class="track" cx="20" cy="20" r="' + r + '"/><circle cx="20" cy="20" r="' + r + '" stroke="' + GOLD + '" stroke-opacity="' + alpha[i] + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/>';
  });
  const rings = svg('<svg class="rings" viewBox="0 0 40 40">' + circles + '</svg>');
  rings.setAttribute('title', s.usage && s.usage.spend ? s.usage.spend : 'Claude usage');
  strip.appendChild(rings);
  const legend = el('div', 'legend');
  if (meters.length) {
    meters.forEach(function (m, i) {
      const line = el('div', 'l' + (i + 1));
      line.appendChild(el('b', null, m.label + ' ' + Math.round(m.percent) + '%'));
      if (m.resetsIn) line.appendChild(document.createTextNode(' · ' + m.resetsIn));
      legend.appendChild(line);
    });
  } else {
    legend.appendChild(el('div', null, s.usage && s.usage.error ? 'usage: ' + s.usage.error : 'usage: loading…'));
  }
  legend.title = s.usage && s.usage.spend ? s.usage.spend : '';
  strip.appendChild(legend);
  const tools = el('div', 'tools');
  tools.appendChild(iconButton(MUTE, s.quiet ? 'Muted · ' + s.quiet.held + ' held · click to unmute' : 'Mute pings (money / failed / BLOCKED still break through)', !!s.quiet, function () { send({ type: 'toggleQuiet' }); }));
  tools.appendChild(iconButton(POPOUT, 'Pop out into its own window', false, function () { send({ type: 'popOut' }); }));
  strip.appendChild(tools);
  bar.appendChild(strip);
  if (five) {
    const line = el('div', 'bar');
    const used = el('div', 'used');
    used.style.width = Math.min(100, five.percent) + '%';
    line.appendChild(used);
    bar.appendChild(line);
    const text = el('div', 'bartext');
    text.appendChild(el('b', null, '5h ' + Math.round(five.percent) + '%'));
    text.appendChild(document.createTextNode(five.resetsIn ? ' · resets in ' + five.resetsIn : ''));
    bar.appendChild(text);
  }
  return bar;
}
function render(s) {
  current = s;
  const frag = document.createDocumentFragment();
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
  frag.appendChild(footer(s));
  root.replaceChildren(frag);
}
`;

function html(surface: 'sidebar' | 'panel'): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body class="${surface}"><div id="root"></div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
