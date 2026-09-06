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
  peek?: string;
  snoozed?: string;
  age?: Age;
  lanes: number[];
  seen: boolean;
  active?: boolean;
}

export interface TaskRow {
  role: 'result' | 'current' | 'queued';
  label: string;
  taskId?: string;
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
  landed: boolean;
  canStart: boolean;
  startBlocked?: string;
  problems: number;
  brief: { state: string; detail?: string; next: string };
  tasks: TaskRow[];
}

export interface ProblemRow {
  lane: number;
  code: string;
  text: string;
  fixes: string[];
}

export interface MeterRow {
  label: string;
  percent: number;
  resetsIn?: string;
}

export interface Snapshot {
  quiet?: { held: number };
  sound: boolean;
  toast: boolean;
  usage?: { meters: MeterRow[]; spend?: string; error?: string };
  rows: Row[];
  lanes: LaneRow[];
  problems: ProblemRow[];
}

export type BoardMessage =
  | { type: 'goToSession'; id: string }
  | { type: 'goToTab'; label: string }
  | { type: 'openCowork'; n: number }
  | { type: 'openLaneFile'; n: number; file?: string }
  | { type: 'popOut' }
  | { type: 'toggleQuiet' }
  | { type: 'toggleSound' }
  | { type: 'toggleToast' }
  | { type: 'next' }
  | { type: 'balance' }
  | { type: 'sweep' }
  | { type: 'receive'; n: number }
  | { type: 'play'; n: number; file: string }
  | { type: 'dismiss'; n: number; file: string }
  | { type: 'fix'; lane: number; code: string; fix: string }
  | { type: 'snooze'; id: string }
  | { type: 'unsnooze'; id: string }
  | { type: 'goToReturn'; returnTo: string; n: number; taskId?: string }
  | { type: 'closeTab'; id?: string; label: string }
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
    this.post({ type: 'snapshot', snapshot });
  }

  post(message: object): void {
    for (const webview of [this.view?.webview, this.panel?.webview]) void webview?.postMessage(message);
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
.row { display: flex; gap: 7px; align-items: center; padding: 3px 6px; border-radius: 5px; cursor: pointer; }
.quietrow { opacity: .65; }
.row:hover { background: var(--vscode-list-hoverBackground); }
/* Bright gold text marks the row under the mouse and, always, the tab that has focus. */
.row:hover .label, .row.active .label { color: #c9b184; }
.row.active .label { font-weight: 600; }
.icon { width: 16px; height: 16px; flex: none; display: grid; place-items: center; font-size: 12px; }
.label { flex: 1; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { flex: none; max-width: 48%; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
/* Row-side buttons (snooze, dismiss) show on hover only. */
.zz, .x { flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0; }
.row:hover .zz, .row:hover .x { opacity: .75; }
.zz:hover, .x:hover { opacity: 1; background: rgba(183,157,112,.22); color: #b79d70; }
.x:hover { color: #1b1b1b; background: #b79d70; }
/* Close button: a gold block with a black ✕ at the right edge of a tab row. Full strength while the
   mouse is on the row, half strength for a second after it leaves, then gone. */
.cx { flex: none; width: 20px; height: 18px; display: grid; place-items: center; border-radius: 4px; font-size: 11px; font-weight: 700; color: #1b1b1b; background: #b79d70; opacity: 0; transition: opacity .18s ease; }
.row:hover .cx { opacity: 1; transition: opacity .1s ease; }
.cx.linger { opacity: .5; }
.cx:hover { background: #c9b184; }
/* Meter strip: frozen at the bottom while the list scrolls. */
.footer { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); background: var(--vscode-sideBar-background); }
.strip { display: flex; align-items: center; gap: 10px; padding: 7px 10px 0; }
.lanes { display: flex; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
.seg { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 6px 0; cursor: pointer; color: #b79d70; font-weight: 700; font-size: 13px; border-left: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
.seg:first-child { border-left: 0; }
.seg.tool { flex: 0 0 34px; color: var(--vscode-descriptionForeground); }
.seg.tool:hover { color: #b79d70; }
.seg:hover { background: var(--vscode-list-hoverBackground); }
.seg.open { background: #b79d70; color: #1b1b1b; }
.sd { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pd { position: absolute; top: 4px; right: 6px; width: 5px; height: 5px; border-radius: 50%; background: #b79d70; }
.badge { position: absolute; top: 2px; right: 3px; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px; background: #b79d70; color: #1b1b1b; font-size: 9px; font-weight: 700; display: grid; place-items: center; }
.keys { padding: 6px 8px; }
.keys .kr { display: flex; align-items: center; gap: 10px; padding: 3px 0; font-size: 12px; }
.keys kbd { font: 600 11px var(--vscode-editor-font-family, monospace); color: #1b1b1b; background: #b79d70; border-radius: 4px; padding: 1px 6px; min-width: 52px; text-align: center; }
.drawer { max-height: 0; opacity: 0; overflow: hidden; margin: 0 6px; border-radius: 10px 10px 0 0; transition: max-height .26s ease, opacity .2s ease; }
.drawer.open { max-height: 360px; opacity: 1; overflow: auto; border: 2px solid #b79d70; border-bottom: 0; background: var(--vscode-sideBar-background); box-shadow: 0 -8px 22px rgba(0,0,0,.35); }
body.panel .drawer.open { background: var(--vscode-editor-background); }
/* The read-out under a lane's tasks: heading, what it said, then the next move. */
.brief { margin: 7px 2px 0; padding: 7px 9px; border-left: 2px solid #b79d70; background: rgba(183,157,112,.07); border-radius: 0 6px 6px 0; }
.brief .bs { font-size: 12px; font-weight: 700; color: #c9b184; line-height: 1.3; }
.brief .bd { margin-top: 3px; font-size: 11px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
.brief .bn { margin-top: 6px; font-size: 11.5px; line-height: 1.45; color: var(--vscode-foreground); }
.brief .bn i { font-style: normal; font-weight: 700; color: #b79d70; text-transform: uppercase; font-size: 10px; letter-spacing: .05em; margin-right: 5px; }
.drawer .inner { padding: 8px 6px 8px 8px; }
.dh { display: flex; align-items: center; gap: 8px; margin: 0 0 6px 4px; }
.dh b { background: #b79d70; color: #1b1b1b; padding: 1px 9px; border-radius: 999px; font-weight: 700; }
.dh .meta { flex: 1; }
.cw { font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #b79d70; color: #b79d70; cursor: pointer; white-space: nowrap; }
.cw:hover { background: rgba(183,157,112,.18); }
.cw.primary { background: #b79d70; color: #1b1b1b; font-weight: 700; }
.cw.primary:hover { background: #c9b184; }
.play { width: 16px; height: 16px; display: grid; place-items: center; color: #b79d70; cursor: pointer; border-radius: 3px; }
.play:hover { background: rgba(183,157,112,.22); }
.play.off { opacity: .3; cursor: not-allowed; }
.play.off:hover { background: none; }
.lh { font-size: 10.5px; color: #b79d70; font-weight: 700; margin: 6px 4px 2px; text-transform: uppercase; letter-spacing: .05em; }
.prob { padding: 4px 6px 6px; border-radius: 5px; }
.prob:hover { background: var(--vscode-list-hoverBackground); }
.prob .pt { display: flex; gap: 7px; align-items: flex-start; font-size: 12px; line-height: 1.35; }
.prob .pt .icon { margin-top: 1px; }
.prob .fx { display: flex; gap: 5px; flex-wrap: wrap; margin: 5px 0 0 23px; }
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
/* Icon row: left-aligned above the rings so it stays put when the sidebar is resized. */
.tools { display: flex; gap: 4px; justify-content: flex-start; padding: 6px 10px 0; }
.ib { position: relative; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 5px; color: var(--vscode-descriptionForeground); cursor: pointer; }
.tip { position: relative; flex: none; display: inline-block; line-height: 0; }
/* Hover explainers, styled like VS Code's own hovers; open upward because the row sits at the bottom. */
[data-tip]::after { content: attr(data-tip); position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 9; width: max-content; max-width: 230px; padding: 4px 8px; border-radius: 4px; font-size: 12px; line-height: 1.35; white-space: normal; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.35)); box-shadow: 0 2px 8px rgba(0,0,0,.35); opacity: 0; pointer-events: none; transform: translateY(2px); transition: opacity .12s ease .3s, transform .12s ease .3s; }
[data-tip]:hover::after { opacity: 1; transform: none; }
.ib:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
.ib.on { color: #b79d70; background: rgba(183, 157, 112, .18); }
`;

// Runs inside the webview: no template literals here (this whole script is itself one).
const SCRIPT = `
const vscode = acquireVsCodeApi();
const state = vscode.getState() || { openLane: null };
let current = { rows: [], lanes: [], problems: [] };
let shownLane = null;
const root = document.getElementById('root');
const LANE = ['1\\uFE0F\\u20E3', '2\\uFE0F\\u20E3', '3\\uFE0F\\u20E3', '4\\uFE0F\\u20E3', '5\\uFE0F\\u20E3'];
window.addEventListener('message', function (e) {
  if (!e.data) return;
  if (e.data.type === 'snapshot') render(e.data.snapshot);
  if (e.data.type === 'showDoctor') { state.showDoctor = true; state.showKeys = false; state.openLane = null; vscode.setState(state); render(current); }
});
vscode.postMessage({ type: 'ready' });

function send(msg) { vscode.postMessage(msg); }
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function svg(markup) { const w = document.createElement('div'); w.innerHTML = markup; return w.firstElementChild; }
function laneMark(n) { return LANE[n - 1] || ('#' + n); }
function numIcon(n) {
  return svg('<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="1.5"/><text x="8" y="8.7" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="700" font-family="inherit" fill="var(--vscode-charts-blue)">' + n + '</text></svg>');
}
function rowIcon(r) {
  if (r.snoozed) return el('span', 'dim', '\\uD83D\\uDCA4');
  if (r.state === 'waiting') return el('span', 'y', '\\u26A0');
  if (r.state === 'ready') return el('span', r.seen ? 'dim' : 'g', r.emoji || '\\u2713');
  if (r.state === 'running') return el('span', 'dot pulse');
  if (r.lanes.length) return numIcon(r.lanes[0]);
  return el('span', 'hollow');
}
function row(r) {
  const quiet = r.snoozed || r.state === 'idle' || (r.state === 'ready' && r.seen);
  const d = el('div', 'row ' + (r.age && !r.snoozed ? r.age.tier : 'fresh') + (quiet ? ' quietrow' : '') + (r.active ? ' active' : ''));
  const icon = el('span', 'icon'); icon.appendChild(rowIcon(r)); d.appendChild(icon);
  d.appendChild(el('span', 'label', r.label));
  const lanes = r.lanes.map(laneMark).join('');
  const emoji = r.emoji && r.state !== 'ready' ? r.emoji + ' ' : '';
  const meta = r.snoozed ? r.snoozed : r.state === 'idle' ? '' : (lanes ? lanes + ' ' : '') + emoji + r.text;
  if (meta) d.appendChild(el('span', 'meta', meta));
  if (r.sessionId && (r.snoozed || r.state === 'ready' || r.state === 'waiting')) {
    const zz = el('span', 'zz', r.snoozed ? '\\u21BA' : '\\uD83D\\uDCA4');
    zz.title = r.snoozed ? 'Wake it up now' : 'Snooze: hide it and ping again later';
    zz.onclick = function (e) { e.stopPropagation(); send({ type: r.snoozed ? 'unsnooze' : 'snooze', id: r.sessionId }); };
    d.appendChild(zz);
  }
  const cx = el('span', 'cx', '\\u2715');
  cx.title = 'Close this tab (\\u2318\\u21E7T reopens it)';
  cx.onclick = function (e) { e.stopPropagation(); send({ type: 'closeTab', id: r.sessionId, label: r.tabLabel || r.label }); };
  d.appendChild(cx);
  d.onmouseleave = function () { cx.classList.add('linger'); setTimeout(function () { cx.classList.remove('linger'); }, 500); };
  d.title = r.label + '\\n' + (r.peek || r.text);
  d.onclick = function () { send(r.sessionId ? { type: 'goToSession', id: r.sessionId } : { type: 'goToTab', label: r.tabLabel || r.label }); };
  return d;
}
function taskGlyph(t) {
  if (t.role === 'queued') return ['dim', '\\u25D4'];
  if (t.role === 'current') return ['b', t.status === 'RUNNING' ? '\\u25CF' : '\\u25D4'];
  if (t.status === 'COMPLETE') return ['g', '\\u2713'];
  if (t.status === 'PARTIAL') return ['o', '\\u26A0'];
  if (t.status === 'BLOCKED') return ['y', '\\u26A0'];
  return ['r', '\\u2715'];
}
function child(iconNode, label, meta, onclick, tip) {
  const r = el('div', 'row');
  const i = el('span', 'icon'); i.appendChild(iconNode); r.appendChild(i);
  r.appendChild(el('span', 'label', label));
  if (meta) r.appendChild(el('span', 'meta', meta));
  r.title = tip || (label + (meta ? ' \\u00b7 ' + meta : ''));
  r.onclick = onclick;
  return r;
}
const PLAY = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>';
function playButton(l, task) {
  const p = el('span', l.canStart ? 'play' : 'play off');
  p.appendChild(svg(PLAY));
  p.title = l.canStart ? 'Start this task now: make it lane ' + l.n + "'s next job and tell Cowork to run drain" : (l.startBlocked || 'Not now');
  p.onclick = function (e) { e.stopPropagation(); if (l.canStart) send({ type: 'play', n: l.n, file: task.file }); };
  return p;
}
function dismissButton(l, task) {
  const x = el('span', 'x', '\\u2715');
  x.title = 'Clear this task: archive it as ' + (task.role === 'result' ? 'CONSUMED' : 'CANCELLED') + ' and empty its slot';
  x.onclick = function (e) { e.stopPropagation(); send({ type: 'dismiss', n: l.n, file: task.file }); };
  return x;
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
    if (l.problems && state.openLane !== l.n) seg.appendChild(el('span', 'pd'));
    seg.title = 'Lane ' + l.n + ' \\u00b7 ' + l.text + (l.problems ? ' \\u00b7 ' + l.problems + ' to check' : '');
    seg.onclick = function () {
      if (state.openLane === l.n && !state.showKeys && !state.showDoctor) return closeDrawer();
      state.openLane = l.n; state.showKeys = false; state.showDoctor = false; vscode.setState(state); render(current);
    };
    bar.appendChild(seg);
  });
  const even = el('div', 'seg tool');
  even.appendChild(svg(BALANCE));
  even.title = 'Even out the lanes';
  even.onclick = function () { send({ type: 'balance' }); };
  bar.appendChild(even);
  const doc = el('div', 'seg tool' + (state.showDoctor ? ' open' : ''));
  doc.appendChild(svg(DOCTOR));
  const count = (s.problems || []).length;
  if (count && !state.showDoctor) doc.appendChild(el('span', 'badge', String(count)));
  doc.title = count ? 'Check-up: ' + count + ' thing' + (count === 1 ? '' : 's') + ' to look at' : 'Check-up: all lanes look fine';
  doc.onclick = function () {
    if (state.showDoctor) return closeDrawer();
    state.showDoctor = true; state.showKeys = false; state.openLane = null; vscode.setState(state); render(current);
  };
  bar.appendChild(doc);
  return bar;
}
function closeDrawer() {
  const d = document.querySelector('.drawer');
  if (d) d.classList.remove('open');
  setTimeout(function () { state.openLane = null; state.showKeys = false; state.showDoctor = false; shownLane = null; vscode.setState(state); render(current); }, 260);
}
function sheetHead(title, metaText) {
  const head = el('div', 'dh');
  head.appendChild(el('b', null, title));
  head.appendChild(el('span', 'meta', metaText || ''));
  const x = el('span', 'cw', 'close');
  x.onclick = closeDrawer;
  head.appendChild(x);
  return head;
}
function keysSheet() {
  const inner = el('div', 'inner keys');
  inner.appendChild(sheetHead('Shortcuts'));
  SHORTCUTS.forEach(function (pair) {
    const row = el('div', 'kr');
    row.appendChild(el('kbd', null, pair[0]));
    row.appendChild(el('span', null, pair[1]));
    inner.appendChild(row);
  });
  return inner;
}
function doctorSheet(s) {
  const inner = el('div', 'inner');
  const probs = s.problems || [];
  inner.appendChild(sheetHead('Check-up', probs.length ? probs.length + ' to look at' : 'all clear'));
  if (!probs.length) inner.appendChild(el('div', 'empty', 'every lane looks healthy'));
  let lastLane = -1;
  probs.forEach(function (p) {
    if (p.lane !== lastLane) { inner.appendChild(el('div', 'lh', p.lane ? 'Lane ' + p.lane : 'This Mac')); lastLane = p.lane; }
    const d = el('div', 'prob');
    const pt = el('div', 'pt');
    const i = el('span', 'icon'); i.appendChild(el('span', p.code === 'blocked' || p.code === 'stuck' ? 'y' : 'o', '\\u26A0')); pt.appendChild(i);
    pt.appendChild(el('span', null, p.text));
    d.appendChild(pt);
    const fx = el('div', 'fx');
    p.fixes.forEach(function (label, k) {
      const b = el('span', 'cw' + (k === 0 ? ' primary' : ''), label);
      b.onclick = function () { send({ type: 'fix', lane: p.lane, code: p.code, fix: label }); };
      fx.appendChild(b);
    });
    d.appendChild(fx);
    inner.appendChild(d);
  });
  return inner;
}
function reveal(d, key) {
  if (shownLane === key) d.classList.add('open');
  else requestAnimationFrame(function () { requestAnimationFrame(function () { d.classList.add('open'); }); });
  shownLane = key;
}
function briefBlock(b) {
  const box = el('div', 'brief');
  box.appendChild(el('div', 'bs', b.state));
  if (b.detail) box.appendChild(el('div', 'bd', b.detail));
  const next = el('div', 'bn');
  next.appendChild(el('i', null, 'Next'));
  next.appendChild(document.createTextNode(b.next));
  box.appendChild(next);
  return box;
}
function drawer(s) {
  const d = el('div', 'drawer');
  if (state.showKeys) { d.appendChild(keysSheet()); reveal(d, 'keys'); return d; }
  if (state.showDoctor) { d.appendChild(doctorSheet(s)); reveal(d, 'doctor'); return d; }
  const l = s.lanes.find(function (x) { return x.n === state.openLane; });
  if (!l) return d;
  reveal(d, l.n);
  const inner = el('div', 'inner');
  const head = el('div', 'dh');
  head.appendChild(el('b', null, 'Lane ' + l.n));
  const spacer = el('span', 'meta'); spacer.title = l.text; head.appendChild(spacer);
  if (l.landed) {
    const rc = el('span', 'cw primary', '\\u2913');
    rc.title = 'Hand this result to the tab that sent it (types "check relay ' + l.n + '" there)';
    rc.onclick = function () { send({ type: 'receive', n: l.n }); };
    head.appendChild(rc);
  }
  const cw = el('span', 'cw', '\\u2197');
  cw.title = 'Open this lane in Cowork';
  cw.onclick = function () { send({ type: 'openCowork', n: l.n }); };
  head.appendChild(cw);
  inner.appendChild(head);
  l.tasks.forEach(function (task) {
    const g = taskGlyph(task);
    const startable = task.role === 'queued' || (task.role === 'current' && task.status === 'READY');
    const icon = startable ? playButton(l, task) : el('span', g[0], g[1]);
    // Title only: the glyph shows the state and the tooltip spells it out, so the name has the whole row.
    const state = task.role === 'result' ? task.status.toLowerCase() : task.role === 'current' ? (task.status === 'RUNNING' ? 'running' : 'ready for Cowork') : 'queued #' + task.position;
    const tip = task.label + ' \\u00b7 ' + state + (task.returnTo ? ' \\u2192 \\u00ab' + task.returnTo + '\\u00bb' : '');
    const r = child(icon, task.label, '', function () { send({ type: 'goToReturn', returnTo: task.returnTo || '', n: l.n, taskId: task.taskId }); }, tip);
    r.appendChild(dismissButton(l, task));
    inner.appendChild(r);
  });
  inner.appendChild(briefBlock(l.brief));
  d.appendChild(inner);
  return d;
}
const GOLD = '#b79d70';
const SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
const BELL_PATH = '<path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.4L3 10.6v.6h10v-.6l-1.4-2.4V5.8A3.6 3.6 0 0 0 8 2.2z"/><path d="M6.6 13.2a1.5 1.5 0 0 0 2.8 0"/>';
const BELL = SVG + BELL_PATH + '</svg>';
const BELL_OFF = SVG + BELL_PATH + '<path d="M2.5 13.5l11-11"/></svg>';
const SPEAKER_PATH = '<path d="M2.5 6h2.6L8 3.5v9L5.1 10H2.5z"/>';
const SPEAKER = SVG + SPEAKER_PATH + '<path d="M10.3 5.7a3.3 3.3 0 0 1 0 4.6M12.4 3.8a6 6 0 0 1 0 8.4"/></svg>';
const SPEAKER_OFF = SVG + SPEAKER_PATH + '<path d="M10.5 6.5l3 3M13.5 6.5l-3 3"/></svg>';
const BREAD_PATH = '<path d="M4.2 7.2c-.9-.4-1.4-1.1-1.4-2 0-1.6 2.2-2.7 5.2-2.7s5.2 1.1 5.2 2.7c0 .9-.5 1.6-1.4 2V13H4.2z"/>';
const BREAD = SVG + BREAD_PATH + '<path d="M6.3 9.4h3.4M6.3 11.2h2"/></svg>';
const BREAD_OFF = SVG + BREAD_PATH + '<path d="M2.5 13.5l11-11"/></svg>';
const BALANCE = SVG + '<path d="M2.5 5.5h9M9 3l2.5 2.5L9 8"/><path d="M13.5 10.5h-9M7 8l-2.5 2.5L7 13"/></svg>';
const DOCTOR = SVG + '<path d="M1.5 8.5h3l1.6-4.2 2.4 7.4 1.6-3.2h4.4"/></svg>';
const BROOM = SVG + '<path d="M13.5 2.5L8.2 7.8"/><path d="M8.2 7.8l-2.7-.5-2.4 2.4 1.7 3.6 3.9-1.4 1.2-3z"/><path d="M4.8 13.3l1.6-2.4"/></svg>';
const KEYS = SVG + '<rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M5 10.5h6"/><path d="M5 6.5h.01M8 6.5h.01M11 6.5h.01"/></svg>';
const POPOUT = SVG + '<path d="M7 3.5H3.5v9h9V9"/><path d="M9.5 3h3.5v3.5M13 3L7.5 8.5"/></svg>';
const SHORTCUTS = [
  ['\\u2303\\u2318U', 'Go to what needs you next'],
  ['\\u2303\\u2318J', 'Jump to any tab or lane'],
  ['\\u2303\\u2318.', 'Peek: what each finished tab said, without opening it'],
  ['\\u2303\\u2318\\u232B', 'Sweep: close the \\uD83E\\uDD19 done tabs (\\u2318\\u21E7T reopens)'],
  ['\\u21E7\\u2325\\u2318J', 'Mute / unmute pings'],
  ['\\uD83D\\uDD14', 'Bell: hold every ping until you unmute'],
  ['\\uD83D\\uDD0A', 'Speaker: ping sounds on / off'],
  ['\\uD83C\\uDF5E', 'Toast: pop-up notifications on / off'],
  ['\\uD83E\\uDDF9', 'Broom: pick tabs to close, done ones pre-checked'],
  ['\\uD83D\\uDCA4', 'Hover a row: snooze it for 30m, 2h, or until a lane lands'],
  ['\\u2303Tab', 'VS Code tab switcher (works with the tab bar hidden)'],
  ['1 2 3', 'Click a lane number to slide its queue up'],
  ['\\u21C4', 'Even out the lanes (moves queued tasks, never the one in flight)'],
  ['\\u2661', 'Check-up: orphaned, stale, stuck or blocked tasks, each with a fix'],
  ['\\u2715', 'Hover a tab row: the gold \\u2715 closes that tab (\\u2318\\u21E7T reopens)'],
  ['\\u2715', 'Hover a task in a lane: clear it into the archive'],
  ['Receive \\u2913', 'Hand a landed result to the tab that sent it'],
  ['\\u25B6', 'Start a queued task now (grayed until the last result is Received)'],
  ['Cowork \\u2197', 'Open that lane in Cowork'],
  ['\\u2197', 'Pop the board out into its own window']
];
function iconButton(markup, title, on, onclick) {
  const b = el('span', 'ib' + (on ? ' on' : ''));
  b.appendChild(svg(markup)); b.setAttribute('data-tip', title); b.onclick = onclick;
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
  const usageTip = meters.length
    ? 'Claude usage · outer ring = ' + meters[0].label + (meters[1] ? ' · inner ring = ' + meters[1].label : '') + (s.usage && s.usage.spend ? ' · ' + s.usage.spend : '')
    : 'Claude usage';
  const ringWrap = el('span', 'tip'); ringWrap.setAttribute('data-tip', usageTip); ringWrap.appendChild(rings);
  strip.appendChild(ringWrap);
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
  legend.setAttribute('data-tip', usageTip);
  strip.appendChild(legend);
  const tools = el('div', 'tools');
  tools.appendChild(iconButton(s.quiet ? BELL_OFF : BELL, s.quiet ? 'Muted · ' + s.quiet.held + ' held · click to unmute (⇧⌥⌘J)' : 'Notifications on · click to mute everything until you unmute. Money, failed and BLOCKED still break through. ⇧⌥⌘J', !s.quiet, function () { send({ type: 'toggleQuiet' }); }));
  tools.appendChild(iconButton(s.sound ? SPEAKER : SPEAKER_OFF, s.sound ? 'Sound is on · click to turn the ping sounds off' : 'Sound is off · click to turn the ping sounds on', !!s.sound, function () { send({ type: 'toggleSound' }); }));
  tools.appendChild(iconButton(s.toast ? BREAD : BREAD_OFF, s.toast ? 'Toast is on · click to turn off the pop-up notifications (in-window toast + macOS banner)' : 'Toast is off · click to turn the pop-up notifications on', !!s.toast, function () { send({ type: 'toggleToast' }); }));
  tools.appendChild(iconButton(BROOM, 'Sweep: pick tabs to close, 🤙 done ones pre-checked (⌃⌘⌫)', false, function () { send({ type: 'sweep' }); }));
  tools.appendChild(iconButton(KEYS, 'Keyboard shortcuts and what each icon does', !!state.showKeys, function () {
    if (state.showKeys) return closeDrawer();
    state.showKeys = true; state.showDoctor = false; vscode.setState(state); render(current);
  }));
  tools.appendChild(iconButton(POPOUT, 'Pop the board out into its own window', false, function () { send({ type: 'popOut' }); }));
  bar.appendChild(tools);
  bar.appendChild(strip);
  if (five) {
    const line = el('div', 'bar');
    const used = el('div', 'used');
    used.style.width = Math.min(100, five.percent) + '%';
    line.appendChild(used);
    bar.appendChild(line);
    const text = el('div', 'bartext');
    text.setAttribute('data-tip', '5-hour session limit' + (five.resetsIn ? ' · resets in ' + five.resetsIn : ''));
    text.appendChild(el('b', null, '5h ' + Math.round(five.percent) + '%'));
    text.appendChild(document.createTextNode(five.resetsIn ? ' · resets in ' + five.resetsIn : ''));
    bar.appendChild(text);
  }
  return bar;
}
function render(s) {
  current = s;
  const frag = document.createDocumentFragment();
  if (!s.rows.length) frag.appendChild(el('div', 'empty', 'no Claude tabs open here'));
  s.rows.forEach(function (r) { frag.appendChild(row(r)); });
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
