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
  brief: { state: string; detail?: string; next: string; actions: Array<{ label: string; kind: string; primary?: boolean }> };
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

// Row order + tab groups. Lives in the extension host (not per-webview vscode.setState) so
// the sidebar and a popped-out panel — two separate webviews — see the same layout instead
// of the popout always starting blank.
export interface LayoutState {
  topOrder: string[];
  groups: Array<{ id: string; name: string; color: string }>;
  groupMembers: Record<string, string[]>;
  groupOf: Record<string, string>;
  collapsed: Record<string, boolean>;
}

export interface Snapshot {
  quiet?: { held: number };
  sound: boolean;
  toast: boolean;
  usage?: { meters: MeterRow[]; spend?: string; error?: string };
  rows: Row[];
  lanes: LaneRow[];
  problems: ProblemRow[];
  // Optional: nothing currently populates or reads this (extension.ts's snapshot() doesn't set
  // it, and Board doesn't look at it) — left optional so it doesn't block the build while that
  // wiring is unfinished elsewhere. The actual sidebar/popout layout sync lives in Board.layout
  // below, driven by the webview's own 'layout'/'layoutSync' messages.
  layout?: LayoutState;
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
  | { type: 'brief'; n: number; kind: 'clear' | 'receive' | 'start' | 'retry' | 'cowork' | 'attach' | 'open' }
  | { type: 'snooze'; id: string }
  | { type: 'unsnooze'; id: string }
  | { type: 'goToReturn'; returnTo: string; n: number; taskId?: string }
  | { type: 'closeTab'; id?: string; label: string }
  | { type: 'saveLayout'; layout: LayoutState }
  // Row order, tab groups, and the Parked shelf — the webview's own client-side state
  // (`vscode.setState`), which is per-webview and so would otherwise leave the sidebar and a
  // popped-out panel showing two different boards. The webview that renders first hands its
  // restored layout here; Board caches it and mirrors it to every other open surface, and every
  // later drag/group/park edit re-sends it so the surfaces stay in sync for the rest of the session.
  | { type: 'layout'; layout: BoardLayout }
  | { type: 'ready' };

export interface BoardLayout {
  topOrder: string[];
  groups: Array<{ id: string; name: string; color: string }>;
  groupMembers: Record<string, string[]>;
  groupOf: Record<string, string>;
  collapsed: Record<string, boolean>;
  parked: string[];
}

// One HTML board, shown in the sidebar and, popped out, as an editor that can float on a sidecar.
export class Board implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private last?: Snapshot;
  private layout?: BoardLayout;

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
    const panel = vscode.window.createWebviewPanel('claudeQueueRelay.board', 'Claude Queue', vscode.ViewColumn.Active, {
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
      // Layout messages are a client-view concern Board owns entirely: cache + mirror to every
      // other open surface, don't forward to the domain onMessage handler.
      if (m.type === 'layout') {
        this.layout = m.layout;
        this.post({ type: 'layoutSync', layout: m.layout });
        return;
      }
      if (m.type !== 'ready') return this.onMessage(m);
      // Layout first, so it's applied before the webview's first render off the snapshot below.
      if (this.layout) void webview.postMessage({ type: 'layoutSync', layout: this.layout });
      if (this.last) void webview.postMessage({ type: 'snapshot', snapshot: this.last });
    });
    onDidDispose(() => sub.dispose());
  }
}

const CSS = `
html, body { overflow-x: hidden; }
body { margin: 0; padding: 8px 10px 132px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
.row { display: flex; gap: 7px; align-items: center; padding: 3px 6px; border-radius: 5px; cursor: pointer; }
.quietrow { opacity: .65; }
.row:hover { background: var(--vscode-list-hoverBackground); }
/* Bright gold text marks the row under the mouse and, always, the tab that has focus. */
.row:hover .label, .row.active .label { color: #c9b184; }
/* A stronger tint plus a left accent bar (padding trimmed to match, so content doesn't shift)
   gives the focused row a defined edge instead of just a faint wash. */
.row.active { background: rgba(183,157,112,.28); border-left: 2px solid #b79d70; padding-left: 4px; }
.row.active:hover { background: rgba(183,157,112,.36); }
/* The focused tab's title is bolder and brighter than a plain hover, so it still reads as
   "this one" even once the mouse has moved off it. */
.row.active .label { color: #e8d9b8; font-weight: 700; }
/* The focused tab's close button stays visible without a hover; other rows still need one. */
.row.active .cx { opacity: .82; }
.row.active:hover .cx { opacity: 1; }
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
/* A lane with something to look at breathes its own outline instead of wearing a dot. */
.seg.warn { animation: segglow 2.6s ease-in-out infinite; }
@keyframes segglow {
  0%, 100% { box-shadow: inset 0 0 0 1px rgba(183,157,112,.4), inset 0 0 6px rgba(183,157,112,.12); }
  50% { box-shadow: inset 0 0 0 1px rgba(183,157,112,.95), inset 0 0 12px rgba(183,157,112,.42); }
}
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
.brief .ba { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
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
/* Drag-to-reorder rows and groups. */
.row.dragging { opacity: .35; }
.row.dragover { outline: 1.5px dashed #b79d70; outline-offset: -2px; }
.dropend { height: 8px; margin: 2px 4px; border-radius: 5px; }
.dropend.dragover { height: 20px; border: 1.5px dashed #b79d70; background: rgba(183,157,112,.08); }
/* Tab groups: a Chrome-style colored section with an editable name and a color swatch. */
.grouptoolbar { display: flex; justify-content: flex-end; padding: 0 4px 4px; }
.gsection { margin: 5px 0 2px; border-left: 2px solid var(--gc, #b79d70); border-radius: 0 0 0 3px; }
.gsection .row { margin-left: 5px; }
.ghead { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px; cursor: pointer; background: color-mix(in srgb, var(--gc, #b79d70) 15%, transparent); }
.ghead:hover, .ghead.dragover { background: color-mix(in srgb, var(--gc, #b79d70) 26%, transparent); }
.ghead.dragover { outline: 1.5px dashed var(--gc, #b79d70); outline-offset: -2px; }
.gchev { flex: none; width: 14px; font-size: 13px; line-height: 1; color: var(--vscode-descriptionForeground); }
.gdot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--gc, #b79d70); cursor: pointer; }
.gname { flex: 1; min-width: 0; font-size: 12px; font-weight: 700; color: var(--gc, #b79d70); outline: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gname:focus { background: var(--vscode-input-background); border-radius: 3px; padding: 0 3px; box-shadow: 0 0 0 1px var(--gc, #b79d70); }
.gcount { flex: none; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.gdel { flex: none; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 4px; font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0; }
.ghead:hover .gdel { opacity: .7; }
.gdel:hover { opacity: 1 !important; background: rgba(128,128,128,.25); }
.swatches { position: fixed; z-index: 50; display: flex; gap: 6px; padding: 7px; border-radius: 7px; background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.35)); box-shadow: 0 2px 10px rgba(0,0,0,.4); }
.swatch { width: 17px; height: 17px; border-radius: 50%; cursor: pointer; border: 1.5px solid rgba(128,128,128,.35); }
.swatch:hover { transform: scale(1.18); }
/* Parked: a fixed slide-up shelf above the relay lanes, not a colored tab-group folder —
   plain gold-outline chrome to match the drawer/lane look instead. */
.parkwrap { margin: 4px 6px 0; }
.parkhead { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; cursor: pointer; background: rgba(183,157,112,.09); border: 1px solid rgba(183,157,112,.4); }
.parkhead:hover, .parkhead.dragover { background: rgba(183,157,112,.2); }
.parkhead.dragover { outline: 1.5px dashed #b79d70; outline-offset: -2px; }
.parkchev { flex: none; width: 14px; font-size: 13px; line-height: 1; color: #b79d70; }
.parktitle { flex: 1; font-size: 11px; font-weight: 700; color: #b79d70; text-transform: uppercase; letter-spacing: .05em; }
.parkcount { flex: none; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.parkdrawer { max-height: 0; opacity: 0; overflow: hidden; margin: 0 1px; border-radius: 0 0 7px 7px; transition: max-height .26s ease, opacity .2s ease; }
.parkdrawer.open { max-height: 240px; opacity: 1; overflow: auto; border: 1px solid rgba(183,157,112,.4); border-top: 0; background: var(--vscode-sideBar-background); padding: 2px 0; }
body.panel .parkdrawer.open { background: var(--vscode-editor-background); }
.parkempty { padding: 6px 8px; font-size: 11px; font-style: italic; color: var(--vscode-descriptionForeground); }
`;

// Runs inside the webview: no template literals here (this whole script is itself one).
const SCRIPT = `
const vscode = acquireVsCodeApi();
const state = vscode.getState() || { openLane: null };
let current = { rows: [], lanes: [], problems: [] };
let shownLane = null;
let activeSwatchPop = null;
// Groups/order/parked live in each webview's own vscode.setState by default, so the sidebar
// and a popped-out panel would otherwise drift apart. These two flags make exactly one surface
// (whichever renders first) hand its restored layout to the extension host as ground truth,
// and every later mutation re-broadcasts so any other open surface stays a mirror, not a fork.
let receivedLayoutSync = false;
let pushedInitialLayout = false;
// render() replaces every row's DOM node from scratch (root.replaceChildren), so a snapshot
// landing between a click's mousedown and mouseup swaps the ✕/row a finger is already
// mid-press on for a freshly built one at the same pixel — the click then lands on
// whatever session THAT new node belongs to, closing a tab Alex never touched. Snapshots
// arrive constantly (any tab finishing, any relay lane changing) and Alex uses this board
// often enough that the race was landing for real, not just in theory. Fix: while a mouse
// gesture is in flight anywhere on the page, hold the latest snapshot and apply it only
// once the gesture (and any click it produces) has fully resolved.
let gestureInFlight = false;
let pendingSnapshot = null;
window.addEventListener('mousedown', function () { gestureInFlight = true; }, true);
window.addEventListener('mouseup', function () {
  setTimeout(function () {
    gestureInFlight = false;
    if (pendingSnapshot) { const s = pendingSnapshot; pendingSnapshot = null; render(s); }
  }, 0);
}, true);
const root = document.getElementById('root');
// Dusty, low-chroma tones in the same warm-gold family as the rest of the board, instead of
// Chrome's vivid tab colors — folders shouldn't be the brightest thing on screen.
const GROUP_COLORS = ['#71717a', '#6e88a6', '#a3706b', '#b3925f', '#6f9179', '#a06e8c', '#8779a3', '#5f8f92'];
// Old vivid palette, kept only so any group colored before this change repaints itself in the
// new muted palette (same index) instead of staying stuck on the bright original.
const OLD_GROUP_COLORS = ['#5f6368', '#1a73e8', '#d93025', '#f9ab00', '#188038', '#d01884', '#8430ce', '#007b83'];
const LANE = ['1\\uFE0F\\u20E3', '2\\uFE0F\\u20E3', '3\\uFE0F\\u20E3', '4\\uFE0F\\u20E3', '5\\uFE0F\\u20E3'];
window.addEventListener('message', function (e) {
  if (!e.data) return;
  if (e.data.type === 'snapshot') { if (gestureInFlight) { pendingSnapshot = e.data.snapshot; } else { render(e.data.snapshot); } }
  if (e.data.type === 'showDoctor') { state.showDoctor = true; state.showKeys = false; state.openLane = null; vscode.setState(state); render(current); }
  if (e.data.type === 'layoutSync') {
    receivedLayoutSync = true;
    const L = e.data.layout || {};
    state.topOrder = L.topOrder || [];
    state.groups = L.groups || [];
    state.groupMembers = L.groupMembers || {};
    state.groupOf = L.groupOf || {};
    state.collapsed = L.collapsed || {};
    state.parked = L.parked || [];
    vscode.setState(state);
    render(current);
  }
});
vscode.postMessage({ type: 'ready' });

function send(msg) { vscode.postMessage(msg); }
// Hands the groups/order/parked slice of state to the extension host, which caches it and
// mirrors it to every other open surface (sidebar + popped-out panel).
function pushLayout() {
  send({ type: 'layout', layout: { topOrder: state.topOrder, groups: state.groups, groupMembers: state.groupMembers, groupOf: state.groupOf, collapsed: state.collapsed, parked: state.parked } });
}
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
    const seg = el('div', 'seg' + (state.openLane === l.n ? ' open' : l.problems ? ' warn' : ''));
    seg.appendChild(el('span', null, String(l.n)));
    const mark = stageMark(l);
    if (mark) seg.appendChild(mark);
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
function briefBlock(l) {
  const b = l.brief;
  const box = el('div', 'brief');
  box.appendChild(el('div', 'bs', b.state));
  if (b.detail) box.appendChild(el('div', 'bd', b.detail));
  const next = el('div', 'bn');
  next.appendChild(el('i', null, 'Next'));
  next.appendChild(document.createTextNode(b.next));
  box.appendChild(next);
  const acts = b.actions || [];
  if (acts.length) {
    const row = el('div', 'ba');
    acts.forEach(function (a) {
      const btn = el('span', 'cw' + (a.primary ? ' primary' : ''), a.label);
      btn.title = a.kind === 'clear' ? 'File this job in the lane archive and empty the lane' : a.label;
      btn.onclick = function () { send({ type: 'brief', n: l.n, kind: a.kind }); };
      row.appendChild(btn);
    });
    box.appendChild(row);
  }
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
  inner.appendChild(briefBlock(l));
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
  ['Clear it', 'In a lane read-out: file the whole job in the archive and free the lane'],
  ['\\u2715', 'Hover a task in a lane: clear that one task into the archive'],
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
// Parked: a fixed shelf pinned above the relay lanes, not one of the drag-anywhere tab-group
// folders — a single click slides it open, and any row (not a group) can be dragged onto the
// header or into the open shelf to park it; dragging a parked row onto the main list unparks it.
function parkedSection(s) {
  const byKey = new Map(s.rows.map(function (r) { return [r.key, r]; }));
  const keys = state.parked.filter(function (k) { return byKey.has(k); });
  const wrap = el('div', 'parkwrap');
  const head = el('div', 'parkhead');
  head.appendChild(el('span', 'parkchev', state.parkedOpen ? '\\u25BE' : '\\u25B8'));
  head.appendChild(el('span', 'parktitle', 'Parked'));
  head.appendChild(el('span', 'parkcount', String(keys.length)));
  head.onclick = function () { state.parkedOpen = !state.parkedOpen; vscode.setState(state); render(current); };
  head.ondragover = function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; head.classList.add('dragover'); };
  head.ondragleave = function () { head.classList.remove('dragover'); };
  head.ondrop = function (e) {
    e.preventDefault(); e.stopPropagation(); head.classList.remove('dragover');
    const srcKey = e.dataTransfer.getData('text/plain');
    if (srcKey) parkRow(srcKey);
  };
  wrap.appendChild(head);
  const box = el('div', 'parkdrawer' + (state.parkedOpen ? ' open' : ''));
  box.ondragover = function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  box.ondrop = function (e) {
    e.preventDefault();
    const srcKey = e.dataTransfer.getData('text/plain');
    if (srcKey) parkRow(srcKey);
  };
  if (!keys.length) box.appendChild(el('div', 'parkempty', 'drag a tab here to park it'));
  keys.forEach(function (k) {
    const r = byKey.get(k);
    if (!r) return;
    const rw = row(r);
    makeDraggable(rw, r.key, dropOnParkedRow);
    box.appendChild(rw);
  });
  wrap.appendChild(box);
  return wrap;
}
function footer(s) {
  const bar = el('div', 'footer');
  bar.appendChild(drawer(s));
  bar.appendChild(parkedSection(s));
  // Relay lanes are opt-in (claudeQueueRelay.relayLanes) — no lanes configured, no lane strip clutter.
  // The keys/check-up drawer above still opens from the tools row regardless.
  if (s.lanes.length) bar.appendChild(laneBar(s));
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
const NEWGROUP = SVG + '<rect x="2" y="4.5" width="12" height="8" rx="1.8"/><path d="M8 6.8v3.4M6.3 8.5h3.4"/></svg>';
// Layout state lives in vscode.setState (same durable store as openLane etc.), not in the
// server snapshot: reordering and grouping are a client-only view over the same rows.
function syncLayout(rows) {
  state.topOrder = state.topOrder || [];
  state.groups = state.groups || [];
  state.groupMembers = state.groupMembers || {};
  state.groupOf = state.groupOf || {};
  state.collapsed = state.collapsed || {};
  state.parked = state.parked || [];
  // Repaint any group still on the old vivid palette (matched by index) onto the new muted one.
  state.groups.forEach(function (g) {
    const i = OLD_GROUP_COLORS.indexOf(g.color);
    if (i >= 0) g.color = GROUP_COLORS[i];
  });
  // One-time migration: a group literally named "Parked" becomes the built-in Parked shelf.
  if (!state.parkedMigrated) {
    state.parkedMigrated = true;
    const legacy = state.groups.filter(function (g) { return (g.name || '').trim().toLowerCase() === 'parked'; });
    if (legacy.length) {
      const legacyIds = new Set(legacy.map(function (g) { return g.id; }));
      legacy.forEach(function (g) {
        (state.groupMembers[g.id] || []).forEach(function (k) {
          if (state.parked.indexOf(k) < 0) state.parked.push(k);
          delete state.groupOf[k];
        });
        delete state.groupMembers[g.id];
      });
      state.groups = state.groups.filter(function (g) { return !legacyIds.has(g.id); });
      state.topOrder = state.topOrder.filter(function (id) { return !(id.indexOf('grp:') === 0 && legacyIds.has(id.slice(4))); });
    }
  }
  const live = new Set(rows.map(function (r) { return r.key; }));
  state.groups.forEach(function (g) {
    state.groupMembers[g.id] = (state.groupMembers[g.id] || []).filter(function (k) { return live.has(k); });
  });
  Object.keys(state.groupOf).forEach(function (k) { if (!live.has(k)) delete state.groupOf[k]; });
  state.parked = state.parked.filter(function (k) { return live.has(k); });
  const parkedSet = new Set(state.parked);
  const groupIds = new Set(state.groups.map(function (g) { return 'grp:' + g.id; }));
  state.topOrder = state.topOrder.filter(function (id) {
    return id.indexOf('grp:') === 0 ? groupIds.has(id) : live.has(id) && !state.groupOf[id] && !parkedSet.has(id);
  });
  const placed = new Set(state.topOrder.concat(state.parked));
  rows.forEach(function (r) {
    if (!placed.has(r.key) && !state.groupOf[r.key]) { state.topOrder.push(r.key); placed.add(r.key); }
  });
  vscode.setState(state);
}
function removeFromEverywhere(key) {
  state.topOrder = state.topOrder.filter(function (x) { return x !== key; });
  state.parked = (state.parked || []).filter(function (x) { return x !== key; });
  const gid = state.groupOf[key];
  if (gid) {
    state.groupMembers[gid] = (state.groupMembers[gid] || []).filter(function (x) { return x !== key; });
    delete state.groupOf[key];
  }
}
function parkRow(key) {
  if (key.indexOf('grp:') === 0) return;
  removeFromEverywhere(key);
  state.parked.push(key);
  state.parkedOpen = true;
  vscode.setState(state); pushLayout(); render(current);
}
function dropOnParkedRow(srcKey, targetKey) {
  if (srcKey.indexOf('grp:') === 0) return;
  removeFromEverywhere(srcKey);
  let idx = state.parked.indexOf(targetKey); if (idx < 0) idx = state.parked.length;
  state.parked.splice(idx, 0, srcKey);
  vscode.setState(state); pushLayout(); render(current);
}
function dropOnRow(srcKey, targetKey) {
  const isGroupSrc = srcKey.indexOf('grp:') === 0;
  const targetGroup = state.groupOf[targetKey];
  if (isGroupSrc && targetGroup) return; // groups can't nest inside a group
  removeFromEverywhere(srcKey);
  if (targetGroup && !isGroupSrc) {
    const arr = state.groupMembers[targetGroup] = state.groupMembers[targetGroup] || [];
    let idx = arr.indexOf(targetKey); if (idx < 0) idx = arr.length;
    arr.splice(idx, 0, srcKey);
    state.groupOf[srcKey] = targetGroup;
  } else {
    const arr = state.topOrder;
    let idx = arr.indexOf(targetKey); if (idx < 0) idx = arr.length;
    arr.splice(idx, 0, srcKey);
  }
  vscode.setState(state); pushLayout(); render(current);
}
function dropOnGroupHeader(srcKey, gid) {
  if (srcKey.indexOf('grp:') === 0) return; // groups can't join another group
  removeFromEverywhere(srcKey);
  state.groupMembers[gid] = state.groupMembers[gid] || [];
  state.groupMembers[gid].push(srcKey);
  state.groupOf[srcKey] = gid;
  vscode.setState(state); pushLayout(); render(current);
}
function dropAtEnd(srcKey) {
  removeFromEverywhere(srcKey);
  state.topOrder.push(srcKey);
  vscode.setState(state); pushLayout(); render(current);
}
function makeDraggable(node, key, onDropFn) {
  node.draggable = true;
  node.ondragstart = function (e) { e.dataTransfer.setData('text/plain', key); e.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging'); };
  node.ondragend = function () { node.classList.remove('dragging'); };
  node.ondragover = function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('dragover'); };
  node.ondragleave = function () { node.classList.remove('dragover'); };
  node.ondrop = function (e) {
    e.preventDefault(); e.stopPropagation(); node.classList.remove('dragover');
    const srcKey = e.dataTransfer.getData('text/plain');
    if (!srcKey || srcKey === key) return;
    (onDropFn || dropOnRow)(srcKey, key);
  };
}
function closeColorPicker() { if (activeSwatchPop) { activeSwatchPop.remove(); activeSwatchPop = null; } }
function openColorPicker(g, anchor) {
  closeColorPicker();
  const pop = el('div', 'swatches');
  GROUP_COLORS.forEach(function (c) {
    const sw = el('span', 'swatch'); sw.style.background = c;
    sw.onclick = function (e) { e.stopPropagation(); g.color = c; vscode.setState(state); pushLayout(); closeColorPicker(); render(current); };
    pop.appendChild(sw);
  });
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(4, r.left) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  activeSwatchPop = pop;
  setTimeout(function () { document.addEventListener('click', closeColorPicker, { once: true }); }, 0);
}
function groupToolbar() {
  const bar = el('div', 'grouptoolbar');
  const btn = el('span', 'ib');
  btn.appendChild(svg(NEWGROUP));
  btn.setAttribute('data-tip', 'New tab group \\u2014 drag tabs onto it');
  btn.onclick = function () {
    const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.groups.push({ id: id, name: 'New Group', color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length] });
    state.groupMembers[id] = [];
    state.topOrder.unshift('grp:' + id);
    vscode.setState(state); pushLayout(); render(current);
  };
  bar.appendChild(btn);
  return bar;
}
function groupHeader(g, memberCount) {
  const collapsed = !!state.collapsed[g.id];
  const head = el('div', 'ghead' + (collapsed ? ' collapsed' : ''));
  head.style.setProperty('--gc', g.color);
  const chev = el('span', 'gchev', collapsed ? '\\u25B8' : '\\u25BE');
  head.appendChild(chev);
  const dot = el('span', 'gdot');
  dot.onclick = function (e) { e.stopPropagation(); openColorPicker(g, dot); };
  head.appendChild(dot);
  const name = el('span', 'gname', g.name);
  name.contentEditable = 'true'; name.spellcheck = false;
  name.onclick = function (e) { e.stopPropagation(); };
  name.onblur = function () { g.name = name.textContent.trim() || 'New Group'; name.textContent = g.name; vscode.setState(state); pushLayout(); };
  name.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } };
  head.appendChild(name);
  head.appendChild(el('span', 'gcount', String(memberCount)));
  const del = el('span', 'gdel', '\\u2715');
  del.title = 'Delete this group (tabs stay open, just ungrouped)';
  del.onclick = function (e) {
    e.stopPropagation();
    (state.groupMembers[g.id] || []).slice().forEach(function (k) { delete state.groupOf[k]; state.topOrder.push(k); });
    state.groups = state.groups.filter(function (x) { return x.id !== g.id; });
    delete state.groupMembers[g.id];
    state.topOrder = state.topOrder.filter(function (x) { return x !== 'grp:' + g.id; });
    vscode.setState(state); pushLayout(); render(current);
  };
  head.appendChild(del);
  head.onclick = function () { state.collapsed[g.id] = !collapsed; vscode.setState(state); pushLayout(); render(current); };
  makeDraggable(head, 'grp:' + g.id, function (srcKey) {
    if (srcKey.indexOf('grp:') === 0) dropOnRow(srcKey, 'grp:' + g.id);
    else dropOnGroupHeader(srcKey, g.id);
  });
  return head;
}
function render(s) {
  current = s;
  syncLayout(s.rows);
  const frag = document.createDocumentFragment();
  if (!s.rows.length) frag.appendChild(el('div', 'empty', 'no Claude tabs open here'));
  frag.appendChild(groupToolbar());
  const byKey = new Map(s.rows.map(function (r) { return [r.key, r]; }));
  state.topOrder.forEach(function (id) {
    if (id.indexOf('grp:') === 0) {
      const gid = id.slice(4);
      const g = state.groups.find(function (x) { return x.id === gid; });
      if (!g) return;
      const memberKeys = state.groupMembers[gid] || [];
      const members = memberKeys.map(function (k) { return byKey.get(k); }).filter(Boolean);
      const section = el('div', 'gsection');
      section.style.setProperty('--gc', g.color);
      section.appendChild(groupHeader(g, members.length));
      if (!state.collapsed[gid]) {
        members.forEach(function (r) {
          const rw = row(r);
          makeDraggable(rw, r.key);
          section.appendChild(rw);
        });
      }
      frag.appendChild(section);
    } else {
      const r = byKey.get(id);
      if (!r) return;
      const rw = row(r);
      makeDraggable(rw, r.key);
      frag.appendChild(rw);
    }
  });
  const dz = el('div', 'dropend');
  dz.ondragover = function (e) { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = function () { dz.classList.remove('dragover'); };
  dz.ondrop = function (e) { e.preventDefault(); dz.classList.remove('dragover'); const k = e.dataTransfer.getData('text/plain'); if (k) dropAtEnd(k); };
  frag.appendChild(dz);
  frag.appendChild(footer(s));
  root.replaceChildren(frag);
  // First surface to render this session hands its restored layout to the host as ground
  // truth, so a surface opening later (e.g. popping the board out) starts already matching it
  // instead of showing its own stale, separately-persisted groups/order/parked.
  if (!pushedInitialLayout && !receivedLayoutSync) { pushedInitialLayout = true; pushLayout(); }
}
`;

function html(surface: 'sidebar' | 'panel'): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body class="${surface}"><div id="root"></div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
