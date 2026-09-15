import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventSpool, HookEvent } from './events';
import { Log } from './log';
import { Session, SessionRegistry, Transition } from './sessions';
import { readSessionTitle, readTitles } from './titles';
import * as tabs from './tabs';
import { SoundKind, claim, cleanupClaims, macNotify, playSound } from './notify';
import { Age, Board, BoardMessage, LaneRow, ProblemRow, Row, Snapshot } from './board';
import { Lane, LaneStage, LaneTask, RelayWatcher, fileAgeMs, laneIsResult, laneLook, laneTaskLabel, taskNameIn, wedgedInbox } from './relay';
import { coworkSessionFor, openCowork } from './cowork';
import { fuzzyPickKey } from './fuzzy';
import { headline } from './footer';
import { Usage, currentUsage, resetsIn } from './usage';
import { BASE_DIR, EVENTS_DIR, hooksInstalled, installHooks } from './hooks';

const HOME = os.homedir();
const LANE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
// Tab titles carry "<status><lane> <task>": ▶️ in flight, ⏭️ next up, ⏳ further back, ✅ landed, ⚠️ blocked.
// Anything short in front of the lane keycap is a prefix we wrote (or a stray character from a rename).
const LANE_PREFIX = /^[^\s]{0,3}?[1-5]️?⃣\s*/;
// A shell command that actually runs the lane's send script, not one that merely mentions it.
const SEND_SCRIPT = /(?:^|[\s;&|(])(?:\S*\/)?send\.sh(?=\s|$)/m;
const LANDING_WORDS: Partial<Record<LaneStage, string>> = {
  complete: 'landed',
  partial: 'landed PARTIAL',
  blocked: 'BLOCKED, needs you',
  abandoned: 'abandoned',
};
const QUIET_FILE = path.join(BASE_DIR, 'quiet');
const SNOOZE_FILE = path.join(BASE_DIR, 'snooze.json');
// TASK_ID → the session/tab that sent it; survives reloads and Claude's shaky RETURN-TO names.
const SENDERS_FILE = path.join(BASE_DIR, 'lanes.json');
interface Sender {
  sessionId: string;
  title?: string;
  n: number;
  at: number;
}
interface Snooze {
  until?: number;
  lane?: number;
}
// What Alex should look at first, in order.
const RANK = { money: 0, waiting: 1, failed: 2, blocked: 3, landed: 4, file: 5, ready: 6 } as const;
type Rank = keyof typeof RANK;
const SIGNAL_RANK: Record<string, Rank> = { money: 'money', failed: 'failed', file: 'file', 'needs-you': 'waiting' };
const GATED = new Set(['money', 'failed', 'needs-you', 'file']);
// Minutes after which a row turns amber, then red.
const AGE_LIMITS: Record<string, [number, number]> = { waiting: [20, 60], running: [20, 240], lane: [30, 120] };
const STALE_DAYS = 7;
const STUCK_MS = 2 * 3_600_000;
const DEFER_GIVE_UP_MS = 10 * 60_000;

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, HOME);
const short = (id: string) => id.slice(0, 8);
const run = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args);
const setting = <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('claudeQueueRelay').get<T>(key, fallback);
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const keycap = (n: number) => LANE_EMOJI[n - 1] ?? `#${n}`;

const settings = {
  get pinMode() { return setting('pinMode', 'immediate'); },
  get sound() { return setting('sound', true); },
  get macNotification() { return setting('macNotification', true); },
  get toast() { return setting('toast', true); },
  get markUnread() { return setting('markUnread', true); },
  get pinnedRow() { return setting('pinnedRow', true); },
  get relayLanes() { return setting<string[]>('relayLanes', []).map(expandHome); },
  get extraRoots() { return setting<string[]>('extraRoots', []).map(expandHome); },
};

interface Announcement {
  key: string;
  headline: string;
  detail: string;
  sound: SoundKind;
  gate: boolean;
  tab?: vscode.Tab;
  toast: boolean;
  action: string;
  run: () => unknown;
}

interface LaneTouch {
  n: number;
  action: 'assign' | 'release';
  file?: string;
}

type Entry = Row & { since: number; session?: Session; tab?: vscode.Tab };

// The board's view of an entry: everything but the live objects behind it.
function rowOf({ since, session, tab, ...row }: Entry): Row {
  return row;
}

interface Step {
  rank: number;
  since: number;
  label: string;
  text: string;
  run: () => unknown;
}

interface Fix {
  label: string;
  run: () => unknown;
}

interface Brief {
  state: string;
  detail?: string;
  next: string;
  actions: BriefAction[];
}

// The next move, as a button in the read-out; `kind` is what the board sends back.
type BriefKind = 'clear' | 'receive' | 'start' | 'retry' | 'cowork' | 'attach' | 'open';
interface BriefAction {
  label: string;
  kind: BriefKind;
  primary?: boolean;
}

interface Problem {
  lane: number;
  code: string;
  text: string;
  fixes: Fix[];
}

// Which lanes a tab is tied to through their task files.
interface Tie {
  lanes: Set<number>;
}

interface Deferred {
  job: () => Promise<unknown>;
  since: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function transcriptFor(cwd: string, sessionId: string): string {
  return path.join(HOME, '.claude', 'projects', cwd.replace(/[/.]/g, '-'), `${sessionId}.jsonl`);
}

// ~/.claude/sessions/<pid>.json is written by every running Claude Code process.
function liveSessions(): Array<{ sessionId: string; cwd: string }> {
  const dir = path.join(HOME, '.claude', 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live: Array<{ sessionId: string; cwd: string }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (meta.sessionId && meta.cwd && (!meta.pid || processAlive(meta.pid))) live.push(meta);
    } catch {
      // half-written; next pass gets it
    }
  }
  return live;
}

function sessionLabel(s: Session): string {
  return s.title ?? s.tabLabel ?? `${path.basename(s.cwd)} · ${short(s.id)}`;
}

function age(since: number, kind: string): Age {
  const minutes = Math.floor((Date.now() - since) / 60_000);
  const text = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const [stale, old] = AGE_LIMITS[kind] ?? [Infinity, Infinity];
  return { text, tier: minutes >= old ? 'old' : minutes >= stale ? 'stale' : 'fresh' };
}

function hoursText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h < 1 ? `${Math.floor(ms / 60_000)}m` : h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Keystrokes land in whatever has focus, so callers activate the tab and focus Claude's input first.
function frontmostApp(): Promise<string> {
  return new Promise((resolve) =>
    execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], (err, out) => resolve(err ? '' : out.trim())),
  );
}

function typeIntoFocused(text: string): Promise<boolean> {
  const script = ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`, '-e', 'delay 0.05', '-e', 'tell application "System Events" to key code 36'];
  return new Promise((resolve) => execFile('osascript', script, (err) => resolve(!err)));
}

// System Events answers whether this app may drive the keyboard; an error means we can't tell, so assume yes.
function accessibilityEnabled(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('osascript', ['-e', 'tell application "System Events" to get UI elements enabled'], (err, out) => resolve(err ? true : out.trim() !== 'false')),
  );
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readSenders(): Record<string, Sender> {
  return readJson<Record<string, Sender>>(SENDERS_FILE, {});
}

function writeSenders(all: Record<string, Sender>): void {
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const [id, rec] of Object.entries(all)) if (rec.at < cutoff) delete all[id];
  fs.writeFileSync(SENDERS_FILE, JSON.stringify(all, null, 1));
}

// Cowork copies RETURN-TO from the task into its result, so writing the real tab title here
// makes the result find its way home no matter what name the sending Claude guessed.
// SESSION: pins the sending session's id into the file too, so the tie survives a renamed tab
// and a lost lanes.json.
function stampReturnTo(file: string, title: string, sessionId?: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const taskId = /^TASK_ID:\s*(\S+)/m.exec(text)?.[1];
  let next = setField(text, 'RETURN-TO', `«${title}»`, 'TASK_ID');
  if (sessionId) next = setField(next, 'SESSION', sessionId, 'RETURN-TO');
  if (next !== text) fs.writeFileSync(file, next);
  return taskId;
}

// Replace "KEY: …" in a handover, or add it right after the line that starts with `after`.
function setField(text: string, key: string, value: string, after: string): string {
  const line = `${key}:${' '.repeat(Math.max(1, 11 - key.length))}${value}`;
  const own = new RegExp(`^${key}:.*$`, 'm');
  if (own.test(text)) return text.replace(own, line);
  return text.replace(new RegExp(`^(${after}:.*)$`, 'm'), `$1\n${line}`);
}

// The task file a lane's send script just wrote: inbound.md or the newest queue entry.
function newestLaneFile(lane: Lane): string | undefined {
  const relay = path.join(lane.dir, 'relay');
  const candidates = [path.join(relay, 'inbound.md'), ...lane.queue.map((t) => t.file)];
  const recent = candidates.filter((f) => fileAgeMs(f) < 15_000).sort((a, b) => fileAgeMs(a) - fileAgeMs(b));
  return recent[0];
}

function watchQuietFile(onChange: () => void): vscode.Disposable {
  try {
    const watcher = fs.watch(BASE_DIR, (_, name) => name === 'quiet' && onChange());
    watcher.on('error', () => {});
    return { dispose: () => watcher.close() };
  } catch {
    return { dispose: () => {} };
  }
}

class TabQueue implements vscode.Disposable {
  private readonly registry = new SessionRegistry();
  private readonly relay: RelayWatcher;
  private readonly board = new Board((m) => this.onBoard(m));
  private readonly status = vscode.window.createStatusBarItem('claudeQueueRelay.status', vscode.StatusBarAlignment.Left, 50);
  private readonly pinnedByUs = new Set<string>();
  private readonly pendingPins = new Set<string>();
  private readonly deferred = new Map<string, Deferred>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly held: Announcement[] = [];
  private muted = false;
  private usage?: Usage;
  private accessible = true;
  private dancing = false;
  private syncing = false;
  private seenTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private readonly snoozeTimer: NodeJS.Timeout;
  private titleIndex = new Map<string, { sessionId: string; cwd: string; transcriptPath: string }>();
  private titleIndexAt = 0;
  private ties = new Map<string, Tie>();
  private lastProblems: Problem[] = [];
  private lastFuzzy = new Map<string, string | undefined>();
  private coworkCache = new Map<number, { at: number; id?: string }>();

  constructor(private readonly log: Log) {
    this.relay = new RelayWatcher(settings.relayLanes, log);
    this.status.name = 'Claude Queue Relay';
    this.status.command = 'claudeQueueRelay.next';
    this.status.show();
    this.loadQuiet();
    this.snoozeTimer = setInterval(() => this.snoozeTick(), 30_000);
    this.disposables.push(
      this.relay,
      this.status,
      this.board,
      vscode.window.registerWebviewViewProvider('claudeQueueRelay.board', this.board, { webviewOptions: { retainContextWhenHidden: true } }),
      this.relay.onDidLand((lane) => {
        this.landed(lane);
        this.wakeForLane(lane.n);
      }),
      this.relay.onDidChange(() => {
        this.render();
        this.scheduleSync();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeQueueRelay') && this.render()),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.tabsChanged(e)),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
      vscode.window.onDidChangeWindowState(() => {
        this.tabsChanged();
        this.drainDeferred();
      }),
      watchQuietFile(() => {
        this.loadQuiet();
        this.render();
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.seenTimer);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.syncTimer);
    clearInterval(this.idleTimer);
    clearInterval(this.snoozeTimer);
    for (const d of this.disposables) d.dispose();
  }

  roots(): string[] {
    return [...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), ...settings.extraRoots];
  }

  private owns(cwd: string): boolean {
    return this.roots().some((root) => cwd === root || cwd.startsWith(root + path.sep));
  }

  private sessions(): Session[] {
    return [...this.registry.sessions.values()];
  }

  private lane(n: number): Lane | undefined {
    return this.relay.lanes.find((l) => l.n === n);
  }

  private laneTask(lane: Lane, file: string): LaneTask | undefined {
    return [lane.result, lane.current, ...lane.queue].find((t) => t?.file === file);
  }

  // --- hook events ---------------------------------------------------------

  handle(event: HookEvent): void {
    if (event.agent_id || !this.owns(event.cwd)) return;
    const transition = this.registry.apply(event);
    const session = transition.session;
    session.dormant = false;
    this.logTransition(transition);
    if (event.hook_event_name === 'SessionEnd') return this.forget(session);
    if (event.hook_event_name === 'UserPromptSubmit') this.promptSubmitted(session);
    const touch = this.laneTouched(event);
    if (touch) void this.laneTouchedBy(session, touch);
    if (transition.from === 'waiting' && transition.to === 'running' && session.tabLabel) void this.unpin(session.tabLabel);
    if (!session.title || event.hook_event_name === 'Stop') void this.learnTitle(session).then(() => this.render());
    if (transition.to !== transition.from && (transition.to === 'ready' || transition.to === 'waiting')) void this.surface(session, event.file);
    this.render();
  }

  private logTransition({ session, from, to, event }: Transition): void {
    if (event.hook_event_name.startsWith('PostToolUse') && from === to) return;
    const tag = event.tool_name ?? event.notification_type;
    this.log.info(`${event.hook_event_name}${tag ? `:${tag}` : ''} ${short(session.id)} ${from}→${to}`);
  }

  private forget(session: Session): void {
    if (session.tabLabel) this.pendingPins.delete(session.tabLabel);
    this.registry.remove(session.id);
    this.render();
  }

  private promptSubmitted(session: Session): void {
    this.bindActiveTab(session);
    if (session.tabLabel) void this.unpin(session.tabLabel);
    this.unsnooze(session, 'you prompted it');
  }

  // The session that writes a lane's inbound/queue file is the one waiting on that lane;
  // reading the lane's outbound is how it collects the result.
  private laneTouched(e: HookEvent): LaneTouch | undefined {
    if (e.hook_event_name !== 'PostToolUse' || !e.tool_input) return undefined;
    const target = e.tool_input.file_path ?? e.tool_input.command ?? '';
    const n = settings.relayLanes.findIndex((dir) => target.includes(`${path.basename(dir)}/relay/`)) + 1;
    if (!n || target.includes('/archive/')) return undefined;
    const writes = ['Write', 'Edit', 'MultiEdit'].includes(e.tool_name ?? '');
    const touchesOutbound = /outbound\.md/.test(target);
    const touchesInbound = /inbound\.md|\/queue\//.test(target);
    if (e.tool_name === 'Read' && touchesOutbound) return { n, action: 'release' };
    if (writes && touchesOutbound && !touchesInbound) return { n, action: 'release' };
    if (writes && touchesInbound) return { n, action: 'assign', file: e.tool_input.file_path };
    if (e.tool_name === 'Bash' && SEND_SCRIPT.test(target)) return { n, action: 'assign' };
    // A shell command that reads the outbound (cat/grep/head…) collects the result, even when it also
    // mentions inbound.md; only a command that writes into inbound counts as a send.
    const writesInbound = /(?:>>?|\btee\b|\bcp\b|\bmv\b)[^\n]*inbound\.md/.test(target);
    if (e.tool_name === 'Bash' && touchesOutbound && !writesInbound) return { n, action: 'release' };
    return undefined;
  }

  private async laneTouchedBy(session: Session, touch: LaneTouch): Promise<void> {
    const { n, action } = touch;
    if (action === 'release') {
      if (!session.lanes.includes(n)) return;
      session.lanes = session.lanes.filter((lane) => lane !== n);
      this.log.info(`${short(session.id)} collected lane ${n}`);
      this.relay.markSeen(n);
      if (session.tabLabel) void this.unpin(session.tabLabel);
      this.scheduleSync();
      return;
    }
    if (!session.lanes.includes(n)) session.lanes = [...session.lanes, n].sort();
    const lane = this.lane(n);
    const file = touch.file ?? (lane && newestLaneFile(lane));
    await this.learnTitle(session);
    const title = this.plainTitle(session);
    this.log.info(`${short(session.id)} sent "${(file && taskNameIn(file)) ?? '?'}" to lane ${n}`);
    if (file && title) this.recordSender(file, title, session, n);
    this.scheduleSync(900);
    this.render();
  }

  private recordSender(file: string, title: string, session: Session, n: number): void {
    const taskId = stampReturnTo(file, title, session.id);
    if (!taskId) return;
    const all = readSenders();
    all[taskId] = { sessionId: session.id, title, n, at: Date.now() };
    writeSenders(all);
    this.log.info(`stamped RETURN-TO «${title}» on ${path.basename(file)} (task ${taskId})`);
  }

  // --- titles and tabs -----------------------------------------------------

  // A custom title (from any rename, ours or Alex's) wins over the AI's, however old it is.
  private async learnTitle(session: Session): Promise<void> {
    if (!session.transcriptPath) return;
    const { ai, custom } = await readTitles(session.transcriptPath);
    if (ai) session.aiTitle = ai;
    if (custom) session.customTitle = custom;
    const title = session.customTitle ?? session.aiTitle;
    if (!title || title === session.title) return;
    session.title = title;
    this.log.info(`title ${short(session.id)} = "${title}"`);
  }

  // The tab's own name, with none of our lane prefixes on it.
  private plainTitle(session: Session): string | undefined {
    return (session.aiTitle ?? session.title ?? session.tabLabel)?.replace(LANE_PREFIX, '').trim() || undefined;
  }

  private async retitle(session: Session, next: string): Promise<void> {
    const tab = this.tabOf(session);
    if (!tab) return;
    const current = session.title ?? tab.label;
    if (next === current) return;
    this.dancing = true;
    try {
      const ok = await tabs.renameTab(tab, next);
      this.log.info(`${ok ? 'renamed' : 'could not rename'} "${current}" → "${next}"`);
      if (!ok) return;
      session.title = next;
      session.customTitle = next;
    } catch (err) {
      this.log.warn(`rename failed for "${current}": ${err}`);
    } finally {
      this.dancing = false;
    }
  }

  private tabOf(session: Session): vscode.Tab | undefined {
    if (session.tab && tabs.locate(session.tab)) return session.tab;
    session.tab = undefined;
    const taken = new Set(this.sessions().filter((s) => s !== session && s.tab).map((s) => s.tab!));
    // Re-bind by every name we know, NOT just the title. VS Code labels a Claude tab
    // from the opening prompt ("I would like you to do s…") while session.title is the
    // AI's summary of the thread ("Vibe filming prompt engine with sliders") — two
    // different strings for the same tab. This used to read `title ?? tabLabel`, so a
    // session that had a title never consulted tabLabel, and once the cached tab handle
    // went stale (a window reload, a tab moved between groups) it could never re-bind:
    // the lane went "no tab here is waiting for this" while the tab sat open in front of
    // Alex, and the result was stranded. tabLabel goes first because it is the literal
    // label VS Code is showing; if the tab really was renamed it simply misses and the
    // titles below get their turn.
    for (const name of [session.tabLabel, session.title, session.aiTitle, session.customTitle]) {
      if (!name) continue;
      const tab = tabs.findByLabel(name, taken);
      if (!tab) continue;
      session.tab = tab;
      session.tabLabel = tab.label;
      this.log.info(`bound ${short(session.id)} → tab "${tab.label}" (matched on "${name}")`);
      return tab;
    }
    return undefined;
  }

  // The tab that is active when a prompt is submitted is the tab of that session.
  private bindActiveTab(session: Session): void {
    if (this.dancing) return;
    const active = tabs.activeClaudeTab();
    if (!active) return;
    for (const other of this.sessions()) if (other !== session && other.tab === active) other.tab = undefined;
    if (session.tab !== active) this.log.info(`bound ${short(session.id)} → tab "${active.label}" (active at prompt)`);
    session.tab = active;
    session.tabLabel = active.label;
  }

  // Any name a session has gone by: its current title, the AI's title, a rename, or its tab label.
  private sessionTitled(title: string): Session | undefined {
    const names = (s: Session) => [s.title, s.aiTitle, s.customTitle].filter((x): x is string => !!x);
    return (
      this.sessions().find((s) => names(s).includes(title)) ??
      this.sessions().find((s) => names(s).some((x) => tabs.labelMatches(x, title) || tabs.labelMatches(title, x)) || (!!s.tabLabel && tabs.labelMatches(s.tabLabel, title)))
    );
  }

  private laneTaskById(n: number | undefined, taskId: string | undefined): LaneTask | undefined {
    const lane = n ? this.lane(n) : undefined;
    if (!lane || !taskId) return undefined;
    return [lane.current, ...lane.queue, lane.result].find((t) => t?.taskId === taskId);
  }

  private sessionOnTab(tab: vscode.Tab): Session | undefined {
    // Same trap as tabOf: the old `s.title ? … : s.tabLabel === …` meant a titled
    // session never compared its own last-known label against the tab in front of it.
    return (
      this.sessions().find((s) => s.tab === tab) ??
      this.sessions().find((s) => s.tabLabel === tab.label) ??
      this.sessions().find((s) =>
        [s.title, s.aiTitle, s.customTitle].some((name) => !!name && tabs.labelMatches(tab.label, name)),
      )
    );
  }

  // --- surfacing -----------------------------------------------------------

  private async surface(session: Session, eventFile: string): Promise<void> {
    await this.learnTitle(session);
    const tab = this.tabOf(session);
    const label = sessionLabel(session);
    const waiting = session.state === 'waiting';
    const kind = session.signal?.kind;
    if (session.snoozedUntil || session.snoozedForLane) return this.log.info(`"${label}" finished while snoozed; staying quiet`);
    if (tab && tabs.looking(tab)) return this.log.info(`"${label}" finished in front of Alex; staying quiet`);
    this.announce({
      key: `evt-${eventFile}`,
      headline: `${session.signal?.emoji ?? (waiting ? '⚠️' : '✅')} ${label}`,
      detail: session.signal?.action ?? session.reason ?? (waiting ? 'needs your input' : 'finished'),
      sound: waiting ? 'waiting' : kind === 'failed' ? 'failed' : 'ready',
      gate: kind === 'money' || kind === 'failed',
      tab,
      toast: !!tab,
      action: 'Go to tab',
      run: () => this.goToSession(session.id),
    });
  }

  private landed(lane: Lane): void {
    const task = lane.result;
    const name = task ? laneTaskLabel(task) : 'result';
    const returnTo = task?.returnTo;
    const tab = this.tabFor(task, lane.n);
    this.log.info(`relay lane ${lane.n} ${lane.stage}: ${name}${returnTo ? ` return-to "${returnTo}"` : ''}${tab ? ' (tab found)' : ''}`);
    this.announce({
      key: `relay-${lane.n}-${Math.round(lane.outbound.mtime)}`,
      headline: `${keycap(lane.n)} Relay lane ${lane.n} ${LANDING_WORDS[lane.stage] ?? lane.stage}`,
      detail: `${name}${returnTo ? ` → «${returnTo}»` : ''}. Say "check relay ${lane.n}"`,
      sound: lane.stage === 'blocked' ? 'waiting' : 'relay',
      gate: lane.stage === 'blocked',
      tab,
      toast: true,
      action: tab ? 'Go to tab' : 'Open result',
      run: () => (tab ? this.goToTab(tab.label) : this.openLaneFile(lane.n)),
    });
    this.render();
  }

  private announce(a: Announcement): void {
    if (a.tab) this.pin(a.tab);
    if (this.quiet && !a.gate) {
      this.held.push(a);
      this.log.info(`held (muted): ${a.headline}`);
      return this.render();
    }
    if (claim(a.key)) this.ping(a.headline, a.detail, a.sound);
    if (a.toast) this.toast(`${a.headline}: ${a.detail}`, a.action, a.run);
  }

  private ping(headline: string, detail: string, sound: SoundKind): void {
    if (settings.sound) playSound(sound);
    if (settings.macNotification) macNotify(headline, detail);
  }

  private toast(message: string, action: string, onAction: () => unknown): void {
    if (!settings.toast) return;
    void vscode.window.showInformationMessage(message, action).then((choice) => choice && onAction());
  }

  // --- mute ----------------------------------------------------------------

  private get quiet(): boolean {
    return this.muted;
  }

  // The flag file is shared by every window and can be flipped by any script or Claude session.
  private loadQuiet(): void {
    this.muted = fs.existsSync(QUIET_FILE);
  }

  toggleQuiet(): void {
    if (this.muted) this.unmute('Unmuted');
    else {
      fs.writeFileSync(QUIET_FILE, 'on');
      this.muted = true;
      this.log.info('muted');
    }
    this.render();
  }

  toggleSound(): void {
    void this.updateSetting('sound', !settings.sound);
  }

  // One switch for both pop-ups: the in-window toast and the macOS banner.
  toggleToast(): void {
    const on = !settings.toast;
    void Promise.all([this.updateSetting('toast', on), this.updateSetting('macNotification', on)]);
  }

  private async updateSetting(key: string, value: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('claudeQueueRelay').update(key, value, vscode.ConfigurationTarget.Global);
    this.log.info(`${key} ${value ? 'on' : 'off'}`);
    this.render();
  }

  private unmute(why: string): void {
    try {
      fs.unlinkSync(QUIET_FILE);
    } catch {
      // another window already removed it
    }
    this.muted = false;
    const held = this.held.splice(0);
    this.log.info(`${why}; releasing ${held.length} held`);
    if (!held.length) return;
    if (claim(`digest-${Date.now() >> 12}`)) this.ping(why, `${held.length} thing${held.length === 1 ? '' : 's'} landed while muted`, 'ready');
    const lines = held.slice(0, 3).map((a) => `${a.headline}: ${a.detail}`);
    this.toast(`${why}: ${held.length} landed. ${lines.join(' · ')}`, 'Show queue', () => run('claudeQueueRelay.board.focus'));
  }

  // --- snooze --------------------------------------------------------------

  async snooze(id: string): Promise<void> {
    const session = this.registry.sessions.get(id);
    if (!session) return;
    type Pick = vscode.QuickPickItem & { minutes?: number; lane?: number };
    const items: Pick[] = [
      { label: '30 minutes', minutes: 30 },
      { label: '2 hours', minutes: 120 },
      ...this.relay.lanes.filter((l) => l.current || l.queue.length).map((l) => ({ label: `Until lane ${l.n} lands`, description: laneLook(l).description, lane: l.n })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Snooze "${sessionLabel(session)}" until…` });
    if (!pick) return;
    session.snoozedUntil = pick.minutes ? Date.now() + pick.minutes * 60_000 : undefined;
    session.snoozedForLane = pick.lane;
    session.seenAt = undefined;
    if (session.tabLabel) void this.unpin(session.tabLabel);
    this.saveSnoozes();
    this.log.info(`snoozed "${sessionLabel(session)}" ${pick.label.toLowerCase()}`);
    this.render();
  }

  unsnooze(session: Session | string, why: string): void {
    const s = typeof session === 'string' ? this.registry.sessions.get(session) : session;
    if (!s || (!s.snoozedUntil && !s.snoozedForLane)) return;
    s.snoozedUntil = undefined;
    s.snoozedForLane = undefined;
    this.saveSnoozes();
    this.log.info(`woke "${sessionLabel(s)}": ${why}`);
    if (s.state === 'ready' || s.state === 'waiting') void this.surface(s, `wake-${short(s.id)}-${Date.now()}`);
    this.render();
  }

  private snoozeTick(): void {
    const now = Date.now();
    for (const s of this.sessions()) if (s.snoozedUntil && s.snoozedUntil <= now) this.unsnooze(s, 'time is up');
  }

  private wakeForLane(n: number): void {
    for (const s of this.sessions()) if (s.snoozedForLane === n) this.unsnooze(s, `lane ${n} landed`);
  }

  private saveSnoozes(): void {
    const all: Record<string, Snooze> = {};
    for (const s of this.sessions()) if (s.snoozedUntil || s.snoozedForLane) all[s.id] = { until: s.snoozedUntil, lane: s.snoozedForLane };
    fs.writeFileSync(SNOOZE_FILE, JSON.stringify(all, null, 1));
  }

  private loadSnoozes(): void {
    const all = readJson<Record<string, Snooze>>(SNOOZE_FILE, {});
    for (const [id, z] of Object.entries(all)) {
      const s = this.registry.sessions.get(id);
      if (!s || (z.until && z.until <= Date.now())) continue;
      s.snoozedUntil = z.until;
      s.snoozedForLane = z.lane;
    }
  }

  // --- doing things only while Alex isn't typing ---------------------------

  private busy(): boolean {
    return this.dancing || this.syncing || tabs.userBusy();
  }

  // Pins and renames switch tabs for a moment; while Alex is typing or clicking they wait.
  private whenIdle(key: string, job: () => Promise<unknown>): void {
    if (!this.busy()) return void job();
    const known = this.deferred.get(key);
    this.deferred.set(key, { job, since: known?.since ?? Date.now() });
    if (!known) this.log.info(`deferred ${key} (you're busy)`);
    this.idleTimer ??= setInterval(() => this.drainDeferred(), 3000);
  }

  private drainDeferred(): void {
    const cutoff = Date.now() - DEFER_GIVE_UP_MS;
    for (const [key, d] of this.deferred) {
      if (d.since >= cutoff) continue;
      this.deferred.delete(key);
      this.log.info(`gave up on ${key}; you never went idle`);
    }
    if (!this.deferred.size) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
      return;
    }
    if (this.busy()) return;
    const [key, d] = this.deferred.entries().next().value as [string, Deferred];
    this.deferred.delete(key);
    void d.job();
  }

  // --- pinning -------------------------------------------------------------

  private pin(tab: vscode.Tab): void {
    if (settings.pinMode === 'off') return;
    if (tabs.activeClaudeTab()?.label === tab.label) return this.log.info(`"${tab.label}" is already in front of you; not pinning`);
    if (settings.pinMode === 'onNextSwitch') return void this.pendingPins.add(tab.label);
    this.whenIdle(`pin "${tab.label}"`, () => this.pinNow(tab.label));
  }

  private async pinNow(label: string): Promise<void> {
    const tab = tabs.findByLabel(label);
    if (!tab || tabs.activeClaudeTab()?.label === label) return;
    this.dancing = true;
    try {
      const ok = await tabs.pinToFront(tab, { markUnread: settings.markUnread, log: (m) => this.log.warn(m) });
      if (!ok) return this.log.warn(`could not locate tab "${label}" to pin`);
      this.pinnedByUs.add(label);
      this.pendingPins.delete(label);
      this.log.info(`pinned "${label}" to front`);
    } catch (err) {
      this.log.warn(`pin failed for "${label}": ${err}`);
    } finally {
      this.dancing = false;
    }
  }

  // With pins off, tabs we pinned before a reload stay pinned; make every Claude tab regular again.
  unpinAll(): void {
    if (settings.pinMode !== 'off') return;
    if (!tabs.claudeTabs().some((t) => t.isPinned)) return;
    this.whenIdle('unpin all', () => this.unpinAllNow());
  }

  private async unpinAllNow(): Promise<void> {
    this.dancing = true;
    try {
      for (const tab of tabs.claudeTabs()) {
        if (!tab.isPinned) continue;
        const ok = await tabs.unpin(tab);
        this.pinnedByUs.delete(tab.label);
        this.log.info(`${ok ? 'unpinned' : 'could not unpin'} "${tab.label}" (pins are off)`);
      }
    } finally {
      this.dancing = false;
    }
  }

  private pinNextPending(except?: string): void {
    for (const label of this.pendingPins) {
      if (label === except || !tabs.findByLabel(label)) continue;
      this.pendingPins.delete(label);
      this.whenIdle(`pin "${label}"`, () => this.pinNow(label));
      return;
    }
  }

  private async unpin(label: string): Promise<void> {
    this.pendingPins.delete(label);
    this.deferred.delete(`pin "${label}"`);
    if (!this.pinnedByUs.has(label)) return;
    try {
      if (!(await tabs.unpinActive(label))) return;
      this.pinnedByUs.delete(label);
      this.log.info(`unpinned "${label}"`);
    } catch (err) {
      this.log.warn(`unpin failed for "${label}": ${err}`);
    }
  }

  // Always re-draw, even mid-dance: a tab Alex closes must leave the board that instant.
  private tabsChanged(e?: vscode.TabChangeEvent): void {
    const closed = (e?.closed ?? []).filter(tabs.isClaudeTab);
    const opened = (e?.opened ?? []).filter(tabs.isClaudeTab);
    if (closed.length || opened.length) this.log.info(`tabs: ${closed.map((t) => `closed "${t.label}"`).concat(opened.map((t) => `opened "${t.label}"`)).join(', ')}`);
    for (const tab of closed) this.tabClosed(tab);
    for (const tab of e?.changed ?? []) this.tabRelabeled(tab);
    if (opened.length) void this.adoptDormantTabs();
    this.render();
    if (this.dancing) return;
    clearTimeout(this.seenTimer);
    const active = tabs.activeClaudeTab();
    if (active && vscode.window.state.focused) {
      this.pinNextPending(active.label);
      this.seenTimer = setTimeout(() => this.viewed(active), 1500);
    }
  }

  // Pins and deferred jobs are keyed by label; a renamed tab keeps them under its new name.
  private rekey(from: string, to: string): void {
    if (this.pinnedByUs.delete(from)) this.pinnedByUs.add(to);
    if (this.pendingPins.delete(from)) this.pendingPins.add(to);
    for (const kind of ['pin', 'rename']) {
      const job = this.deferred.get(`${kind} "${from}"`);
      if (!job) continue;
      this.deferred.delete(`${kind} "${from}"`);
      this.deferred.set(`${kind} "${to}"`, job);
    }
  }

  // A label change is exactly the case where VS Code hands out a fresh Tab object (see the
  // note on closeTab in tabs.ts), so `s.tab === tab` never matches the session that owned it
  // a moment ago — the rename is never learned, the session is left bound to a dead Tab, and
  // it silently drops off the board (and out of its lane) until something else re-adopts it.
  // A rename never moves a tab to a different group, so fall back to the session whose tab
  // went stale (no longer locatable) in the same group as the one that just changed.
  private sessionForRelabeledTab(tab: vscode.Tab): Session | undefined {
    return (
      this.sessions().find((s) => s.tab === tab) ??
      this.sessions().find((s) => s.tab && s.tab.group === tab.group && !tabs.locate(s.tab))
    );
  }

  private tabRelabeled(tab: vscode.Tab): void {
    const s = this.sessionForRelabeledTab(tab);
    if (!s) return;
    s.tab = tab;
    if (s.tabLabel && s.tabLabel !== tab.label) this.rekey(s.tabLabel, tab.label);
    s.tabLabel = tab.label;
    void this.learnTitle(s).then(() => this.render());
  }

  // A closed tab leaves the board at once; its session is forgotten and re-adopted if the tab comes back.
  private tabClosed(tab: vscode.Tab): void {
    const survivor = tabs.findByLabel(tab.label);
    for (const s of this.sessions()) if (s.tab === tab) s.tab = survivor;
    if (survivor || this.dancing) return;
    this.pinnedByUs.delete(tab.label);
    this.pendingPins.delete(tab.label);
    this.deferred.delete(`pin "${tab.label}"`);
    this.deferred.delete(`rename "${tab.label}"`);
    for (const s of this.sessions()) {
      const ours = s.tabLabel === tab.label || (!!s.title && tabs.labelMatches(tab.label, s.title));
      if (!ours) continue;
      this.registry.sessions.delete(s.id);
      this.log.info(`closed "${tab.label}"; forgot ${short(s.id)}`);
    }
  }

  private viewed(tab: vscode.Tab): void {
    if (!tabs.looking(tab)) return;
    const session = this.sessionOnTab(tab);
    if (session?.state === 'ready' && !session.seenAt) {
      session.seenAt = Date.now();
      this.log.info(`seen "${tab.label}"`);
    }
    if (session?.state !== 'waiting') void this.unpin(tab.label);
    this.render();
  }

  // --- navigation ----------------------------------------------------------

  private onBoard(m: BoardMessage): void {
    switch (m.type) {
      case 'goToSession':
        return void this.goToSession(m.id);
      case 'goToTab':
        return void this.goToTab(m.label);
      case 'openCowork':
        return this.openCowork(m.n);
      case 'openLaneFile':
        return void this.openLaneFile(m.n, m.file);
      case 'popOut':
        return void this.popOut();
      case 'toggleQuiet':
        return this.toggleQuiet();
      case 'toggleSound':
        return this.toggleSound();
      case 'toggleToast':
        return this.toggleToast();
      case 'next':
        return void this.next();
      case 'balance':
        return this.balance();
      case 'sweep':
        return void this.sweep();
      case 'receive':
        return void this.receive(m.n);
      case 'play':
        return void this.play(m.n, m.file);
      case 'dismiss':
        return void this.dismiss(m.n, m.file);
      case 'brief':
        return void this.briefAction(m.n, m.kind);
      case 'fix':
        return void this.fix(m.lane, m.code, m.fix);
      case 'snooze':
        return void this.snooze(m.id);
      case 'unsnooze':
        return this.unsnooze(m.id, 'you woke it');
      case 'goToReturn':
        return void this.goToReturn(m.returnTo, m.n, m.taskId);
      case 'closeTab':
        return void this.closeRow(m.id, m.label);
    }
  }

  // The ✕ on a row closes that tab; the board drops the row the moment VS Code reports it closed.
  async closeRow(id: string | undefined, label: string): Promise<void> {
    const session = id ? this.registry.sessions.get(id) : undefined;
    const tab = (session && this.tabOf(session)) ?? tabs.findByLabel(label);
    if (!tab) return void vscode.window.showWarningMessage(`No open tab named "${label}" in this window.`);
    await tabs.closeTab(tab);
    this.log.info(`closed "${tab.label}" from the board`);
  }

  async goToSession(id: string): Promise<void> {
    const session = this.registry.sessions.get(id);
    if (!session) return;
    const tab = this.tabOf(session) ?? (await this.resumeHere(session));
    if (!tab) return void vscode.window.showWarningMessage(`Could not open "${sessionLabel(session)}" in this window.`);
    await this.focus(tab);
  }

  // No tab for this session in this window — it's likely open in a different
  // one instead of actually closed. Resume it here rather than just saying so.
  private async resumeHere(session: Session): Promise<vscode.Tab | undefined> {
    let tab: vscode.Tab | undefined;
    try {
      tab = await tabs.resumeSession(session.id);
    } catch (err) {
      this.log.warn(`resume failed for ${short(session.id)}: ${err}`);
      return undefined;
    }
    if (!tab) return undefined;
    session.tab = tab;
    session.tabLabel = tab.label;
    this.log.info(`resumed ${short(session.id)} → tab "${tab.label}" in this window`);
    return tab;
  }

  async goToTab(label: string): Promise<void> {
    const tab = tabs.findByLabel(label);
    if (!tab) return void vscode.window.showWarningMessage(`No open tab named "${label}" in this window.`);
    await this.focus(tab);
  }

  private async focus(tab: vscode.Tab): Promise<void> {
    await tabs.activate(tab);
    await tabs.focusClaudeInput();
  }

  openCowork(n: number): void {
    const found = openCowork(n);
    this.log.info(`open Cowork lane ${n}: ${found ? 'session found' : 'no HK-RELAY session, opened Claude'}`);
    if (!found) void vscode.window.showWarningMessage(`No Cowork session named HK-RELAY-${n} found; opened Claude instead.`);
  }

  async openLaneFile(n: number, file?: string): Promise<void> {
    const lane = this.lane(n);
    if (!lane) return;
    const target = file ?? lane.result?.file ?? lane.current?.file ?? lane.outbound.path;
    if (target === lane.outbound.path) this.relay.markSeen(n);
    this.render();
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not open ${target}: ${err}`);
    }
  }

  showDoctor(): void {
    void run('claudeQueueRelay.board.focus');
    this.board.post({ type: 'showDoctor' });
  }

  // --- lane titles ---------------------------------------------------------

  private scheduleSync(ms = 800): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.syncLaneTitles(), ms);
  }

  // Tab titles carry no lane marker (the board's lane circle is enough); one left over from an older version is removed.
  async syncLaneTitles(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      this.ties = this.tiesByTab();
      for (const tab of tabs.claudeTabs()) {
        const session = this.sessionOnTab(tab);
        if (!session) continue;
        if (!session.title) await this.learnTitle(session);
        const want = this.desiredTitle(session, tab);
        if (want) this.whenIdle(`rename "${tab.label}"`, () => this.retitle(session, want));
      }
    } finally {
      this.syncing = false;
    }
  }

  // A title that still starts with an old lane marker gets its plain name back; every other name is left alone.
  private desiredTitle(session: Session, _tab: vscode.Tab): string | undefined {
    const current = session.title;
    if (!current || !LANE_PREFIX.test(current)) return undefined;
    const body = (session.aiTitle ?? current).replace(LANE_PREFIX, '').trim();
    return body && body !== current ? body : undefined;
  }

  // Every lane task resolved to its tab, once per pass, so rows, drawer rows and titles agree.
  private tiesByTab(): Map<string, Tie> {
    const map = new Map<string, Tie>();
    const tie = (label: string, n: number) => {
      const t = map.get(label) ?? { lanes: new Set<number>() };
      t.lanes.add(n);
      map.set(label, t);
    };
    for (const lane of this.relay.lanes) {
      for (const task of [lane.result, lane.current, ...lane.queue]) {
        if (!task || (task.role === 'result' && (!laneIsResult(lane) || lane.seen))) continue;
        const tab = this.tabFor(task, lane.n, true);
        if (tab) tie(tab.label, lane.n);
      }
    }
    // A tab whose footer says it awaits a lane still counts while that lane has work, even if no file names it.
    for (const s of this.sessions()) {
      if (!s.lanes.length) continue;
      const tab = this.tabOf(s);
      if (!tab) continue;
      for (const n of s.lanes) {
        const lane = this.lane(n);
        if (!lane || (!lane.current && !lane.queue.length) || map.get(tab.label)?.lanes.has(n)) continue;
        tie(tab.label, n);
      }
    }
    return map;
  }

  // Going to a landed lane means going to the tab that will say "check relay N".
  private collect(lane: Lane): Promise<void> {
    const tab = this.tabFor(lane.result, lane.n);
    return tab ? this.focus(tab) : this.openLaneFile(lane.n);
  }

  async popOut(): Promise<void> {
    if (!this.board.popOut()) return;
    await run('workbench.action.moveEditorToNewWindow');
    this.log.info('board popped out into its own window');
    this.render();
  }

  async next(): Promise<void> {
    const first = this.ladder()[0];
    if (!first) return void vscode.window.setStatusBarMessage('Claude queue: nothing needs you', 2500);
    await first.run();
  }

  async jump(): Promise<void> {
    type Pick = vscode.QuickPickItem & { run?: () => unknown };
    const entries = this.rows();
    const items: Pick[] = [];
    const add = (title: string, list: Pick[]) => {
      if (!list.length) return;
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator }, ...list);
    };
    const pick = (e: Entry): Pick => ({
      label: `${e.lanes.map(keycap).join('')}${e.emoji ? `${e.emoji} ` : ''}${e.label}`,
      description: e.snoozed ?? e.text,
      run: () => (e.sessionId ? this.goToSession(e.sessionId) : this.goToTab(e.tabLabel ?? e.label)),
    });
    add('Waiting on you', entries.filter((e) => e.state === 'waiting' && !e.snoozed).map(pick));
    add('Ready', entries.filter((e) => e.state === 'ready' && !e.seen && !e.snoozed).map(pick));
    add('Tabs', entries.map(pick));
    add(
      'Relay lanes',
      this.relay.lanes.map((lane) => ({
        label: `${keycap(lane.n)} Lane ${lane.n}`,
        description: laneLook(lane).description,
        run: () => this.openCowork(lane.n),
      })),
    );
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Jump to a Claude tab or relay lane', matchOnDescription: true });
    await chosen?.run?.();
  }

  // Peek: what each finished tab said, newest first, without opening any of them.
  async peek(): Promise<void> {
    type Pick = vscode.QuickPickItem & { id: string };
    const items: Pick[] = this.rows()
      .filter((e) => e.session && e.state === 'ready' && !e.seen && !e.snoozed)
      .sort((a, b) => b.since - a.since)
      .map((e) => ({ label: `${e.emoji ?? '✓'} ${e.peek ?? e.text}`, description: e.label, detail: e.peek ? e.text : undefined, id: e.session!.id }));
    if (!items.length) return void vscode.window.setStatusBarMessage('Claude queue: nothing finished that you haven’t seen', 2500);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'What the finished tabs said · Enter jumps there', matchOnDescription: true, matchOnDetail: true });
    if (pick) await this.goToSession(pick.id);
  }

  // Sweep: close the tabs whose session signed off with 🤙, after a glance at the list.
  async sweep(): Promise<void> {
    type Pick = vscode.QuickPickItem & { tab: vscode.Tab };
    const done = (e: Entry) => e.session?.signal?.kind === 'done' && !e.lanes.length;
    const items: Pick[] = this.rows()
      .filter((e) => e.tab)
      .map((e) => ({
        label: e.label,
        description: done(e) ? `🤙 done${e.seen ? '' : ' · not viewed yet'}` : e.session ? e.text : 'no activity',
        picked: done(e),
        tab: e.tab!,
      }));
    if (!items.length) return;
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Close these tabs? 🤙 tabs are pre-checked · ⌘⇧T reopens' });
    if (!picks?.length) return;
    for (const p of picks) await tabs.closeTab(p.tab);
    this.log.info(`swept ${picks.length} tab(s): ${picks.map((p) => `"${p.label}"`).join(', ')}`);
    vscode.window.setStatusBarMessage(`Closed ${picks.length} tab${picks.length === 1 ? '' : 's'} · ⌘⇧T reopens`, 4000);
    this.render();
  }

  // Move work from the fullest lane to the emptiest until no lane is 2+ ahead. Queued tasks and a
  // READY inbound move; a task Cowork is running and a landed result never do. Always says what happened.
  balance(): void {
    const moved: string[] = [];
    for (let guard = 0; guard < 9; guard++) {
      const lanes = [...this.relay.lanes].sort((a, b) => this.relay.load(b) - this.relay.load(a));
      const from = lanes[0];
      const to = lanes[lanes.length - 1];
      if (!from || !to || this.relay.load(from) - this.relay.load(to) < 2) break;
      const task = this.relay.movable(from)[0];
      if (!task) break;
      this.relay.moveTask(task, to);
      this.retag(task.returnTo, from.n, to.n);
      moved.push(`"${laneTaskLabel(task)}" ${from.n} → ${to.n}`);
    }
    const loads = this.relay.lanes.map((l) => `lane ${l.n}: ${this.relay.load(l)}`).join(' · ');
    this.log.info(moved.length ? `balanced lanes: ${moved.join('; ')} (${loads})` : `balance: nothing to move (${loads})`);
    if (!moved.length) {
      void vscode.window.showInformationMessage(`Lanes are as even as they can be (${loads}). Only queued tasks and a READY inbound move; running tasks and landed results stay put.`);
      return;
    }
    void vscode.window.showInformationMessage(`Evened out the lanes: ${moved.join(' · ')} (now ${loads})`, 'Show queue').then((c) => c && run('claudeQueueRelay.board.focus'));
    this.render();
  }

  // The tab that sent a moved task now waits on the new lane.
  private retag(returnTo: string | undefined, from: number, to: number): void {
    const session = returnTo ? this.sessionTitled(returnTo) : undefined;
    if (!session) return;
    session.lanes = [...session.lanes.filter((n) => n !== from), to].sort();
    this.scheduleSync(900);
  }

  // "Receive": put the landed result in front of the tab that asked for it by typing its own trigger phrase.
  async receive(n: number): Promise<void> {
    const lane = this.lane(n);
    if (!lane) return;
    const returnTo = lane.result?.returnTo;
    const tab = this.tabFor(lane.result, n);
    if (!tab) return void vscode.window.showWarningMessage(`No open tab here for lane ${n}'s result${returnTo ? ` («${returnTo}»)` : ''}.`);
    if (!vscode.window.state.focused) return void vscode.window.showWarningMessage('Click into VS Code first, then press Receive again.');
    await tabs.activate(tab);
    if (vscode.window.activeTextEditor?.selection.isEmpty !== false) await tabs.focusClaudeInput();
    await new Promise((r) => setTimeout(r, 350));
    const typed = await typeIntoFocused(`check relay ${n}`);
    this.relay.markSeen(n);
    void this.unpin(tab.label);
    this.log.info(`receive lane ${n} → "${tab.label}": ${typed ? 'typed' : 'could not type (Accessibility?)'}`);
    if (!typed) void vscode.window.showWarningMessage(`Couldn't type into the tab (allow VS Code under System Settings → Privacy → Accessibility). Type "check relay ${n}" there.`);
    this.render();
  }

  // ▶ on a queued task: make it the lane's READY inbound, then tell that lane's Cowork to drain.
  async play(n: number, file: string): Promise<void> {
    const lane = this.lane(n);
    if (!lane) return;
    const blocked = this.startBlocked(lane);
    if (blocked) return void vscode.window.showWarningMessage(blocked);
    const task = [lane.current, ...lane.queue].find((t) => t?.file === file);
    if (!task) return;
    if (task.role === 'queued') this.relay.promote(lane, file);
    this.log.info(`play lane ${n}: "${laneTaskLabel(task)}" is READY`);
    await this.kickCowork(n);
    this.render();
  }

  private async kickCowork(n: number): Promise<void> {
    if (!this.coworkFor(n)) return void vscode.window.showWarningMessage(`No Cowork session named HK-RELAY-${n}; open one and run ./relay/drain.sh.`);
    openCowork(n);
    await new Promise((r) => setTimeout(r, 1500));
    const front = await frontmostApp();
    if (front !== 'Claude') return void vscode.window.showWarningMessage(`Cowork didn't come to the front (${front}); tell it to run ./relay/drain.sh.`);
    const typed = await typeIntoFocused('run ./relay/drain.sh');
    this.log.info(`kicked Cowork lane ${n}: ${typed ? 'typed drain' : 'could not type'}`);
    if (!typed) void vscode.window.showWarningMessage(`Couldn't type into Cowork (Accessibility?). Tell lane ${n} to run ./relay/drain.sh.`);
  }

  private coworkFor(n: number): string | undefined {
    const hit = this.coworkCache.get(n);
    if (hit && Date.now() - hit.at < 60_000) return hit.id;
    const id = coworkSessionFor(n);
    this.coworkCache.set(n, { at: Date.now(), id });
    return id;
  }

  async goToReturn(returnTo: string, n: number, taskId?: string): Promise<void> {
    const tab = this.tabFor(this.laneTaskById(n, taskId) ?? { returnTo, taskId }, n);
    if (!tab) return void vscode.window.showWarningMessage(returnTo ? `No open tab here named «${returnTo}» (lane ${n}).` : `Lane ${n}: that task has no RETURN-TO tab.`);
    await this.focus(tab);
  }

  // Who a task belongs to, most reliable signal first: the session id stamped in the file (a result
  // borrows it from the lane's matching inbound/queue entry), the sender record, the one session
  // waiting on the lane, the RETURN-TO name, and finally the task's own name (older versions renamed
  // the sending tab to it).
  private tabFor(task: { returnTo?: string; taskId?: string; taskName?: string; sessionId?: string } | undefined, n?: number, strict = false): vscode.Tab | undefined {
    const twin = this.laneTaskById(n, task?.taskId);
    const record = task?.taskId ? readSenders()[task.taskId] : undefined;
    for (const id of [task?.sessionId, twin?.sessionId, record?.sessionId]) {
      const session = id ? this.registry.sessions.get(id) : undefined;
      const tab = session && this.tabOf(session);
      if (tab) return tab;
    }
    if (n && !strict) {
      const waiting = this.sessions().filter((s) => s.lanes.includes(n));
      if (waiting.length === 1) {
        const tab = this.tabOf(waiting[0]);
        if (tab) return tab;
      }
    }
    for (const name of [task?.returnTo ?? record?.title, task?.taskName ?? twin?.taskName]) {
      if (!name) continue;
      const session = this.sessionTitled(name);
      const tab = (session && this.tabOf(session)) ?? tabs.findByLabel(name) ?? this.fuzzyTab(name);
      if (tab) return tab;
    }
    return undefined;
  }

  private fuzzyTab(title: string): vscode.Tab | undefined {
    const byLabel = new Map<string, vscode.Tab>();
    const items: Array<{ key: string; text: string }> = [];
    for (const tab of tabs.claudeTabs()) {
      byLabel.set(tab.label, tab);
      items.push({ key: tab.label, text: tab.label });
      const session = this.sessionOnTab(tab);
      if (session?.title) items.push({ key: tab.label, text: session.title });
    }
    const hit = fuzzyPickKey(title, items);
    if (this.lastFuzzy.get(title) !== hit) {
      this.lastFuzzy.set(title, hit);
      this.log.info(hit ? `fuzzy-matched «${title}» → tab "${hit}"` : `no fuzzy match for «${title}» among ${byLabel.size} tabs`);
    }
    return hit ? byLabel.get(hit) : undefined;
  }

  markAllSeen(): void {
    for (const s of this.sessions()) if (s.state === 'ready') s.seenAt ??= Date.now();
    for (const lane of this.relay.lanes) this.relay.markSeen(lane.n);
    this.pendingPins.clear();
    this.render();
  }

  // --- lane doctor ---------------------------------------------------------

  // Everything in a lane that won't resolve on its own, each with the buttons that resolve it.
  private problems(): Problem[] {
    const out: Problem[] = [];
    for (const lane of this.relay.lanes) {
      const name = (t: LaneTask) => `«${laneTaskLabel(t)}»`;
      const dismiss = (t: LaneTask, label = 'Dismiss'): Fix => ({ label, run: () => this.dismiss(lane.n, t.file) });
      const attach = (t: LaneTask): Fix => ({ label: 'Attach to tab…', run: () => this.attach(lane.n, t.file) });
      const current = lane.current;
      const quiet = Date.now() - Math.max(lane.inbound.mtime, lane.outbound.mtime);
      if (current?.status === 'RUNNING' && quiet > STUCK_MS) {
        out.push({
          lane: lane.n,
          code: 'stuck',
          text: `Cowork has shown nothing on ${name(current)} for ${hoursText(quiet)}`,
          fixes: [
            { label: 'Re-kick Cowork', run: () => this.kickCowork(lane.n) },
            { label: 'Reset to READY', run: () => this.relay.setStatus(lane, current.file, 'READY') },
            dismiss(current, 'Cancel'),
          ],
        });
      }
      for (const task of [current, ...lane.queue]) {
        if (!task) continue;
        const days = Math.floor(fileAgeMs(task.file) / 86_400_000);
        if (task.status !== 'RUNNING' && days >= STALE_DAYS) {
          const start: Fix[] = this.startBlocked(lane) ? [] : [{ label: 'Start', run: () => this.play(lane.n, task.file) }];
          out.push({ lane: lane.n, code: 'stale', text: `${name(task)} has been waiting ${days} days`, fixes: [dismiss(task), ...start, attach(task)] });
        } else if (!this.tabFor(task, lane.n, true)) {
          out.push({ lane: lane.n, code: 'orphan', text: `${name(task)} has no open tab to come back to`, fixes: [attach(task), dismiss(task)] });
        }
      }
      const result = lane.result;
      if (result && laneIsResult(lane) && !lane.seen) {
        if (lane.stage === 'blocked') {
          out.push({
            lane: lane.n,
            code: 'blocked',
            text: `${name(result)} is BLOCKED: ${this.blockReason(lane)}`,
            fixes: [{ label: 'Open Cowork', run: () => this.openCowork(lane.n) }, { label: 'Receive', run: () => this.receive(lane.n) }, dismiss(result)],
          });
        } else if (!this.tabFor(result, lane.n, true)) {
          out.push({
            lane: lane.n,
            code: 'orphan',
            text: `result ${name(result)} has no tab to receive it`,
            fixes: [attach(result), { label: 'Open result', run: () => this.openLaneFile(lane.n) }, dismiss(result)],
          });
        }
      }
      const wedged = wedgedInbox(lane);
      if (wedged) {
        out.push({
          lane: lane.n,
          code: 'wedged',
          text: `«${wedged.name}» sits in the inbox as ${wedged.status}; drain skips it, so the lane stays busy forever`,
          fixes: [{ label: 'Clear it', run: () => this.clearLane(lane.n) }, { label: 'Send it again', run: () => this.retry(lane.n) }],
        });
      }
      if (result && laneIsResult(lane) && lane.seen && fileAgeMs(lane.outbound.path) > 30 * 60_000) {
        out.push({
          lane: lane.n,
          code: 'lingering',
          text: `«${laneTaskLabel(result)}» was taken ${hoursText(fileAgeMs(lane.outbound.path))} ago but was never cleared, so it still holds the lane`,
          fixes: [{ label: 'Clear it', run: () => this.clearLane(lane.n) }, { label: 'Open Cowork', run: () => this.openCowork(lane.n) }],
        });
      }
      if ((lane.stage === 'ready' || lane.stage === 'running') && !this.coworkFor(lane.n)) {
        out.push({ lane: lane.n, code: 'no-cowork', text: `no Cowork session named HK-RELAY-${lane.n} is open, so nothing will run this lane`, fixes: [{ label: 'Open Claude', run: () => this.openCowork(lane.n) }] });
      }
    }
    if (!this.accessible) {
      out.push({
        lane: 0,
        code: 'accessibility',
        text: 'VS Code is not allowed to type (Accessibility is off), so Receive and ▶ cannot send their words',
        fixes: [{ label: 'Open Accessibility settings', run: () => execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], () => {}) }],
      });
    }
    return out;
  }

  // Where this lane stands and what the next move is, in the words Alex would use,
  // with the buttons that do it. Every state ends in something Alex can press.
  private laneBrief(lane: Lane): Brief {
    const name = (t?: LaneTask) => (t ? laneTaskLabel(t) : 'the task');
    const behind = lane.queue.length ? ` ${lane.queue.length} more queued behind it.` : '';
    const since = (at: number) => {
      const t = age(at, 'lane').text;
      return t === 'just now' ? 'just now' : `${t} ago`;
    };
    const cowork: BriefAction = { label: 'Open Cowork ↗', kind: 'cowork' };
    const clear: BriefAction = { label: 'Clear it', kind: 'clear' };
    if (laneIsResult(lane) && lane.result) {
      const tab = this.tabFor(lane.result, lane.n);
      const word = LANDING_WORDS[lane.stage] ?? lane.stage;
      const stuckOn = lane.stage === 'blocked' || lane.stage === 'abandoned';
      const detail = this.resultDetail(lane);
      // Seen only means Alex looked. The files still hold the lane until the job is cleared.
      if (lane.seen) {
        return {
          state: `${name(lane.result)} ${word}`,
          detail,
          next: `You already took this one, but the job still holds lane ${lane.n}. Clear it to file the result in the archive and free the lane${lane.queue.length ? ', then ▶ starts the next task' : ''}.`,
          actions: [{ ...clear, primary: true }, ...(stuckOn ? [{ label: 'Send it again', kind: 'retry' as const }] : []), cowork],
        };
      }
      return {
        state: `${name(lane.result)} ${word}`,
        detail,
        next: tab
          ? `Press Receive to hand it to «${tab.label}»; it types "check relay ${lane.n}" there. Clear it when you are done with it.`
          : 'No tab here is waiting for this. Attach one, or read the result and clear the job.',
        actions: tab
          ? [{ label: 'Receive ⤓', kind: 'receive', primary: true }, clear, ...(stuckOn ? [cowork] : [])]
          : [{ label: 'Attach to tab…', kind: 'attach', primary: true }, { label: 'Open result', kind: 'open' }, clear],
      };
    }
    const wedged = wedgedInbox(lane);
    if (wedged) {
      return {
        state: `${wedged.name} is stuck in lane ${lane.n}'s inbox`,
        detail: `Its status reads ${wedged.status}, so drain.sh skips it and Cowork will never pick it up. It will sit here until you clear it.`,
        next: 'Clear it to archive the job and free the lane, or send it again to put it back in front of Cowork.',
        actions: [{ ...clear, primary: true }, { label: 'Send it again', kind: 'retry' }, cowork],
      };
    }
    if (lane.stage === 'running') {
      const quiet = Date.now() - Math.max(lane.inbound.mtime, lane.outbound.mtime);
      const stuck = quiet > STUCK_MS;
      return {
        state: `${name(lane.current)} is in flight`,
        detail: `Cowork started it ${since(lane.inbound.mtime)}.${behind}`,
        next: stuck
          ? `Nothing from Cowork for ${hoursText(quiet)}. Send it again, or open Cowork and say "run ./relay/drain.sh".`
          : 'Nothing to do. It pings you here the moment it lands.',
        actions: stuck ? [{ label: 'Send it again', kind: 'retry', primary: true }, cowork, clear] : [cowork],
      };
    }
    if (lane.stage === 'ready') {
      const live = !!this.coworkFor(lane.n);
      return {
        state: `${name(lane.current)} is written but not started`,
        detail: `Waiting since ${since(lane.inbound.mtime)}.${behind}`,
        next: live
          ? 'Press Start and Cowork runs it, or open Cowork and say "run ./relay/drain.sh".'
          : `No Cowork session named HK-RELAY-${lane.n} is open, so nothing will run it. Open Claude first.`,
        actions: live ? [{ label: 'Start ▶', kind: 'start', primary: true }, cowork, clear] : [{ label: 'Open Claude ↗', kind: 'cowork', primary: true }, clear],
      };
    }
    if (lane.stage === 'queued') {
      return {
        state: `${lane.queue.length} task${lane.queue.length === 1 ? '' : 's'} waiting, nothing in flight`,
        detail: `Oldest first: ${name(lane.queue[0])}.`,
        next: 'Press Start and Cowork picks up the oldest one, or ▶ the one you want.',
        actions: [{ label: 'Start ▶', kind: 'start', primary: true }, cowork],
      };
    }
    return { state: 'This lane is empty', next: 'Send a task from any tab and it shows up here.', actions: [cowork] };
  }

  // The one line the result actually says: its HEADLINE, else whatever trails the STATUS word.
  private resultDetail(lane: Lane): string | undefined {
    const f = lane.outbound.fields;
    const trailing = (f.STATUS ?? '').replace(/^\S+\s*/, '').replace(/^[\s(—–:-]+/, '').replace(/\)\s*$/, '');
    const text = (f.HEADLINE ?? trailing ?? '').trim();
    if (!text) return undefined;
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }

  private blockReason(lane: Lane): string {
    const reason = this.resultDetail(lane) ?? 'needs you in Cowork';
    return reason.length > 110 ? `${reason.slice(0, 109)}…` : reason;
  }


  private fix(lane: number, code: string, label: string): Promise<unknown> | void {
    const fix = this.lastProblems.find((p) => p.lane === lane && p.code === code)?.fixes.find((f) => f.label === label);
    if (!fix) return;
    this.log.info(`check-up: ${label} (lane ${lane}, ${code})`);
    return Promise.resolve(fix.run()).then(() => this.render());
  }

  // The buttons in a lane's read-out; one message, routed to what already exists.
  async briefAction(n: number, kind: BriefKind): Promise<void> {
    const lane = this.lane(n);
    if (!lane) return;
    this.log.info(`lane ${n} read-out: ${kind}`);
    const first = lane.current ?? lane.queue[0];
    switch (kind) {
      case 'clear':
        return this.clearLane(n);
      case 'receive':
        return this.receive(n);
      case 'start':
        return first ? this.play(n, first.file) : undefined;
      case 'retry':
        return this.retry(n);
      case 'cowork':
        return this.openCowork(n);
      case 'attach':
        return lane.result ? this.attach(n, lane.result.file) : undefined;
      case 'open':
        return this.openLaneFile(n);
    }
  }

  // Clear the job this lane is sitting on, whichever file it lives in.
  async clearLane(n: number): Promise<void> {
    const lane = this.lane(n);
    if (!lane) return;
    const job = lane.result ?? lane.current;
    const taskId = job?.taskId ?? wedgedInbox(lane)?.taskId ?? lane.inbound.fields.TASK_ID;
    if (!taskId || taskId === 'none') return void vscode.window.setStatusBarMessage(`Lane ${n} has nothing to clear`, 2500);
    const label = job ? laneTaskLabel(job) : (wedgedInbox(lane)?.name ?? taskId);
    this.forgetSender(taskId, n);
    const archived = this.relay.clearJob(lane, taskId);
    this.log.info(`cleared lane ${n} job "${label}" (${taskId}); archived ${archived.length} file(s)`);
    vscode.window.setStatusBarMessage(`Cleared «${label}» · ${archived.length} file(s) archived in lane ${n}`, 5000);
    this.scheduleSync(500);
    this.render();
  }

  // Put a task back in front of Cowork: flip the inbox copy to READY and kick the lane.
  async retry(n: number): Promise<void> {
    const lane = this.lane(n);
    if (!lane) return;
    const inbox = lane.inbound;
    if (!inbox.exists || !inbox.fields.TASK_ID || inbox.fields.TASK_ID === 'none') return void vscode.window.showWarningMessage(`Lane ${n}'s inbox is empty; there is nothing to send again.`);
    this.relay.setStatus(lane, inbox.path, 'READY');
    this.log.info(`lane ${n}: sent "${inbox.fields.TASK_NAME ?? inbox.fields.TASK_ID}" again as READY`);
    await this.kickCowork(n);
    this.render();
  }

  private forgetSender(taskId: string, n: number): void {
    const all = readSenders();
    if (!all[taskId]) return;
    delete all[taskId];
    writeSenders(all);
    for (const s of this.sessions()) s.lanes = s.lanes.filter((l) => l !== n);
  }

  // Clear a task: it goes to the lane's archive as CANCELLED (a result: CONSUMED) and its slot empties.
  async dismiss(n: number, file: string): Promise<void> {
    const lane = this.lane(n);
    const task = lane && this.laneTask(lane, file);
    if (!lane || !task) return;
    const name = laneTaskLabel(task);
    const tab = this.tabFor(task, n, true);
    const session = tab && this.sessionOnTab(tab);
    if (session) session.lanes = session.lanes.filter((l) => l !== n);
    if (task.taskId) {
      const all = readSenders();
      delete all[task.taskId];
      writeSenders(all);
    }
    const archived = this.relay.dismiss(lane, task);
    this.log.info(`dismissed lane ${n} ${task.role} "${name}" → ${archived.join(', ')}`);
    vscode.window.setStatusBarMessage(`Cleared «${name}» · ${archived.length} file(s) archived in lane ${n}`, 5000);
    this.scheduleSync(500);
    this.render();
  }

  // Tie a task to the tab that is really waiting on it: stamp RETURN-TO and remember the sender.
  async attach(n: number, file: string): Promise<void> {
    const lane = this.lane(n);
    const task = lane && this.laneTask(lane, file);
    if (!lane || !task) return;
    type Pick = vscode.QuickPickItem & { tab: vscode.Tab; session?: Session };
    const items: Pick[] = this.rows()
      .filter((e) => e.tab)
      .map((e) => ({ label: e.label, description: e.session ? e.text : 'no activity', tab: e.tab!, session: e.session }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Which tab is waiting on «${laneTaskLabel(task)}»?` });
    if (!pick) return;
    const session = pick.session ?? this.sessionOnTab(pick.tab);
    const title = (session && this.plainTitle(session)) ?? pick.tab.label;
    if (session) {
      if (!session.lanes.includes(n)) session.lanes = [...session.lanes, n].sort();
      this.recordSender(file, title, session, n);
    } else {
      stampReturnTo(file, title);
      this.log.info(`stamped RETURN-TO «${title}» on ${path.basename(file)} (no session on that tab yet)`);
    }
    this.scheduleSync(500);
    this.render();
  }

  // --- the board -----------------------------------------------------------

  // Every open Claude tab in tab order, joined to its session when known. Closed tabs are gone.
  private rows(): Entry[] {
    this.ties = this.tiesByTab();
    const sessions = this.sessions().filter((s) => s.state !== 'ended');
    const used = new Set<Session>();
    const entries: Entry[] = [];
    for (const tab of tabs.claudeTabs()) {
      const session =
        sessions.find((s) => !used.has(s) && s.tab === tab) ??
        sessions.find((s) => !used.has(s) && !!s.title && tabs.labelMatches(tab.label, s.title)) ??
        sessions.find((s) => !used.has(s) && !s.title && s.tabLabel === tab.label);
      if (session) used.add(session);
      entries.push(this.entry(session, tab));
    }
    return entries;
  }

  private entry(session: Session | undefined, tab: vscode.Tab): Entry {
    const label = session?.title ?? tab.label;
    const lanes = new Set<number>(session?.lanes ?? []);
    for (const n of this.relay.lanesFor([label, tab.label, session?.title, session?.tabLabel])) lanes.add(n);
    for (const n of this.ties.get(tab.label)?.lanes ?? []) lanes.add(n);
    const base = { label, tabLabel: tab.label, lanes: [...lanes].sort(), tab, active: tabs.activeClaudeTab() === tab };
    if (!session) return { ...base, key: `t:${label}`, state: 'idle', text: 'no activity yet', seen: true, since: 0 };
    const state = session.state === 'ended' ? 'idle' : session.state;
    const a = age(state === 'running' ? session.lastEventAt : session.since, state);
    const ask = session.signal?.action ?? session.reason;
    const peek = state === 'ready' ? headline(session.lastMessage) : undefined;
    const said = session.signal && GATED.has(session.signal.kind) ? ask : (peek ?? ask);
    const text =
      state === 'waiting'
        ? `${ask ?? 'needs you'} · waiting ${a.text}`
        : state === 'running'
          ? `running ${a.text}`
          : state === 'ready'
            ? `${said ?? 'finished'} · ${a.text === 'just now' ? a.text : `${a.text} ago`}`
            : session.dormant
              ? 'idle'
              : `idle · ${a.text}`;
    const snoozed = session.snoozedForLane ? `💤 until lane ${session.snoozedForLane} lands` : session.snoozedUntil ? `💤 back at ${clock(session.snoozedUntil)}` : undefined;
    return {
      ...base,
      key: `s:${session.id}`,
      sessionId: session.id,
      state,
      emoji: session.signal && session.signal.kind !== 'lane' ? session.signal.emoji : undefined,
      text,
      peek,
      snoozed,
      age: a,
      seen: !!session.seenAt,
      since: session.since,
      session,
    };
  }

  private startBlocked(lane: Lane): string | undefined {
    if (laneIsResult(lane) && !lane.seen) return `Receive lane ${lane.n}'s result first`;
    if (lane.current?.status === 'RUNNING') return `Cowork is still running "${laneTaskLabel(lane.current)}"`;
    return undefined;
  }

  private laneRow(lane: Lane, problems: Problem[]): LaneRow {
    const inFlight = lane.stage === 'running' || lane.stage === 'ready';
    const a = inFlight ? age(lane.inbound.mtime, 'lane') : undefined;
    const tasks = [lane.result, lane.current, ...lane.queue].filter((t): t is LaneTask => !!t);
    return {
      n: lane.n,
      stage: lane.stage,
      text: laneLook(lane).description + (a ? ` · ${a.text}` : ''),
      age: a,
      seen: lane.seen,
      landed: laneIsResult(lane),
      canStart: !this.startBlocked(lane),
      startBlocked: this.startBlocked(lane),
      problems: problems.filter((p) => p.lane === lane.n).length,
      brief: this.laneBrief(lane),
      tasks: tasks.map((t) => ({ role: t.role, label: t.taskName ?? t.returnTo ?? laneTaskLabel(t), taskId: t.taskId, status: t.status, returnTo: t.returnTo, file: t.file, position: t.position })),
    };
  }

  private ladder(): Step[] {
    const steps: Step[] = [];
    for (const e of this.rows()) {
      const s = e.session;
      if (!s || e.snoozed) continue;
      const rank: Rank | undefined =
        s.state === 'waiting' ? 'waiting' : s.state === 'ready' && !s.seenAt ? (SIGNAL_RANK[s.signal?.kind ?? ''] ?? 'ready') : undefined;
      if (!rank) continue;
      steps.push({ rank: RANK[rank], since: s.since, label: e.label, text: e.text, run: () => this.goToSession(s.id) });
    }
    for (const lane of this.relay.lanes) {
      const text = laneLook(lane).description;
      if (lane.stage === 'blocked') steps.push({ rank: RANK.blocked, since: lane.landedAt ?? 0, label: `Relay lane ${lane.n} BLOCKED`, text, run: () => this.collect(lane) });
      else if (laneIsResult(lane) && !lane.seen) steps.push({ rank: RANK.landed, since: lane.landedAt ?? 0, label: `Relay lane ${lane.n} landed`, text, run: () => this.collect(lane) });
    }
    return steps.sort((a, b) => a.rank - b.rank || a.since - b.since);
  }

  // One list, no sections: what needs Alex first, then running, then seen, then idle and snoozed at the bottom.
  // A tab tied to a relay lane is an ordinary row here (its keycap says which lane); the lane's drawer repeats it.
  private snapshot(): Snapshot {
    const entries = this.rows();
    const problems = this.problems();
    this.lastProblems = problems;
    const tier = (e: Entry) => (e.snoozed ? 4 : e.state === 'waiting' ? 0 : e.state === 'ready' ? (e.seen ? 3 : 1) : e.state === 'running' ? 2 : 4);
    const visible = entries.map((e, order) => ({ e, order }));
    visible.sort((a, b) => {
      const ta = tier(a.e);
      const tb = tier(b.e);
      if (ta !== tb) return ta - tb;
      if (ta === 0) return a.e.since - b.e.since;
      if (ta === 4) return a.order - b.order;
      return b.e.since - a.e.since;
    });
    const problemRows: ProblemRow[] = problems.map((p) => ({ lane: p.lane, code: p.code, text: p.text, fixes: p.fixes.map((f) => f.label) }));
    return {
      quiet: this.quiet ? { held: this.held.length } : undefined,
      sound: settings.sound,
      toast: settings.toast,
      usage: this.usage && {
        meters: this.usage.meters.map((m) => ({ label: m.label, percent: m.percent, resetsIn: resetsIn(m.resetsAt) })),
        spend: this.usage.spend,
        error: this.usage.meters.length ? undefined : this.usage.error,
      },
      rows: visible.map(({ e }) => rowOf(e)),
      lanes: this.relay.lanes.map((lane) => this.laneRow(lane, problems)),
      problems: problemRows.sort((a, b) => a.lane - b.lane),
    };
  }

  render(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.paint(), 250);
  }

  private paint(): void {
    this.board.show(this.snapshot());
    const first = this.ladder()[0];
    const urgent = !!first && first.rank <= RANK.blocked;
    this.status.text = this.quiet
      ? `$(bell-slash) Muted · ${this.held.length} held`
      : first
        ? `$(bell-dot) ${first.label.slice(0, 36)}`
        : '$(bell) Claude: all quiet';
    const meters = this.usage?.meters.slice(0, 2).map((m) => `${m.label} ${Math.round(m.percent)}%`).join(' · ');
    if (meters) this.status.text += `  $(pulse) ${meters}`;
    this.status.backgroundColor = urgent && !this.quiet ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const checkup = this.lastProblems.length ? `\n${this.lastProblems.length} thing(s) in the lane check-up.` : '';
    this.status.tooltip = (first ? `${first.text}\nClick or ⌃⌘U: go there. ⌃⌘J: jump anywhere. ⌃⌘. peek.` : 'Claude Queue Relay') + checkup;
  }

  async refreshUsage(): Promise<void> {
    this.usage = await currentUsage();
    if (this.usage.error) this.log.warn(`usage: ${this.usage.error}`);
    const accessible = await accessibilityEnabled();
    if (accessible !== this.accessible) this.log.info(`accessibility ${accessible ? 'granted' : 'missing'}`);
    this.accessible = accessible;
    this.render();
  }

  // --- bookkeeping ---------------------------------------------------------

  seed(quiet = false): void {
    let n = 0;
    for (const { sessionId, cwd } of liveSessions()) {
      if (!this.owns(cwd)) continue;
      const session = this.registry.ensure(sessionId, cwd);
      session.transcriptPath ??= transcriptFor(cwd, sessionId);
      n++;
      void this.learnTitle(session).then(() => {
        this.tabOf(session);
        this.render();
      });
    }
    this.loadSnoozes();
    if (!quiet) this.log.info(`seeded ${n} live session(s) from ~/.claude/sessions`);
    void this.adoptDormantTabs();
  }

  // A tab whose Claude process hasn't been resumed since the reload has no live session; its
  // transcript still knows its full title and id, which is enough to track and rename it.
  private async adoptDormantTabs(): Promise<void> {
    await this.refreshTitleIndex();
    let adopted = 0;
    for (const tab of tabs.claudeTabs()) {
      if (this.sessionOnTab(tab)) continue;
      const hit = [...this.titleIndex.entries()].find(([title]) => tabs.labelMatches(tab.label, title));
      if (!hit) continue;
      const [title, { sessionId, cwd, transcriptPath }] = hit;
      if (this.registry.sessions.has(sessionId)) continue;
      const session = this.registry.ensure(sessionId, cwd);
      Object.assign(session, { title, transcriptPath, tab, tabLabel: tab.label, dormant: true });
      void this.learnTitle(session);
      adopted++;
    }
    if (adopted) {
      this.log.info(`adopted ${adopted} dormant tab(s) from transcripts`);
      this.loadSnoozes();
      this.render();
    }
  }

  private async refreshTitleIndex(): Promise<void> {
    if (Date.now() - this.titleIndexAt < 5 * 60_000) return;
    this.titleIndexAt = Date.now();
    const projects = path.join(HOME, '.claude', 'projects');
    const cutoff = Date.now() - 14 * 86_400_000;
    const index = new Map<string, { sessionId: string; cwd: string; transcriptPath: string }>();
    for (const root of this.roots()) {
      const enc = root.replace(/[/.]/g, '-');
      let dirs: string[];
      try {
        dirs = fs.readdirSync(projects).filter((d) => d === enc || d.startsWith(`${enc}-`));
      } catch {
        continue;
      }
      for (const d of dirs) {
        const dir = path.join(projects, d);
        let files: string[];
        try {
          files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const f of files) {
          const transcriptPath = path.join(dir, f);
          try {
            if (fs.statSync(transcriptPath).mtimeMs < cutoff) continue;
          } catch {
            continue;
          }
          const title = await readSessionTitle(transcriptPath);
          if (title) index.set(title, { sessionId: f.slice(0, -'.jsonl'.length), cwd: root, transcriptPath });
        }
      }
    }
    this.titleIndex = index;
  }

  // Drop sessions whose CLI process is gone and that have been silent for a while.
  reconcile(): void {
    const live = new Set(liveSessions().map((s) => s.sessionId));
    const cutoff = Date.now() - 5 * 60_000;
    for (const s of this.sessions()) {
      if (live.has(s.id) || s.lastEventAt > cutoff || (s.dormant && this.tabOf(s))) continue;
      this.registry.sessions.delete(s.id);
      this.log.info(`dropped ended session ${short(s.id)} "${sessionLabel(s)}"`);
    }
    this.render();
  }
}

function installHooksInteractively(log: Log): void {
  try {
    const r = installHooks();
    const msg = r.added.length
      ? `Claude Queue Relay: hooks added for ${r.added.join(', ')}. Backup: ${r.backup ?? 'none'}`
      : 'Claude Queue Relay: hooks were already installed.';
    log.info(msg);
    void vscode.window.showInformationMessage(msg);
  } catch (err) {
    void vscode.window.showErrorMessage(`Claude Queue Relay: hook install failed: ${err}`);
  }
}

// Scaffolds N relay lane folders (relay-kit/setup.sh, bundled with the extension) and
// offers to point claudeQueueRelay.relayLanes at them — the setup step relay lanes need
// before Claude Cowork has anywhere to run, per relay-kit/README.md.
async function setupRelayLanesInteractively(context: vscode.ExtensionContext, log: Log): Promise<void> {
  const count = await vscode.window.showQuickPick(['1', '2', '3'], {
    placeHolder: 'How many relay lanes? (each is one parallel Claude Cowork session — 3 is typical)',
  });
  if (!count) return;
  const base = await vscode.window.showInputBox({
    prompt: 'Base folder for lane 1 (further lanes go alongside it as -2, -3, …)',
    value: path.join(HOME, 'Documents', 'claude-relay'),
  });
  if (!base) return;
  const script = path.join(context.extensionPath, 'relay-kit', 'setup.sh');
  execFile('/bin/bash', [script, base, count], (err, stdout, stderr) => {
    log.info(stdout || '');
    if (err) {
      void vscode.window.showErrorMessage(`Claude Queue Relay: lane setup failed — ${stderr || err.message}`);
      log.warn(stderr || String(err));
      return;
    }
    const lanes = Array.from({ length: Number(count) }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
    void vscode.window
      .showInformationMessage(
        `Claude Queue Relay: ${count} relay lane${count === '1' ? '' : 's'} ready at ${base}. Point claudeQueueRelay.relayLanes at ${count === '1' ? 'it' : 'them'}?`,
        'Set it',
        'Show me the setup log',
      )
      .then((choice) => {
        if (choice === 'Set it') void vscode.workspace.getConfiguration('claudeQueueRelay').update('relayLanes', lanes, vscode.ConfigurationTarget.Global);
        if (choice === 'Show me the setup log') log.show();
      });
  });
}

function offerHookInstall(): void {
  void vscode.window
    .showInformationMessage('Claude Queue Relay needs its Claude Code hooks installed to see sessions.', 'Install hooks')
    .then((choice) => choice && run('claudeQueueRelay.installHooks'));
}

// Pinned editors ignore ⌘W by default; a queued tab should close like any other.
function regularCloseOnce(context: vscode.ExtensionContext, log: Log): void {
  if (context.globalState.get<boolean>('regularCloseApplied')) return;
  vscode.workspace
    .getConfiguration('workbench.editor')
    .update('preventPinnedEditorClose', 'never', vscode.ConfigurationTarget.Global)
    .then(
      () => context.globalState.update('regularCloseApplied', true),
      (err) => log.warn(`could not set preventPinnedEditorClose: ${err}`),
    );
}

function enablePinnedRowOnce(context: vscode.ExtensionContext, log: Log): void {
  if (!settings.pinnedRow || context.globalState.get<boolean>('pinnedRowApplied')) return;
  vscode.workspace
    .getConfiguration('workbench.editor')
    .update('pinnedTabsOnSeparateRow', true, vscode.ConfigurationTarget.Global)
    .then(
      () => context.globalState.update('pinnedRowApplied', true),
      (err) => log.warn(`could not enable pinnedTabsOnSeparateRow: ${err}`),
    );
}

export function activate(context: vscode.ExtensionContext): void {
  const windowName = vscode.workspace.name ?? path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'window');
  const log = new Log(path.join(BASE_DIR, 'log.txt'), windowName);
  const queue = new TabQueue(log);
  const spool = new EventSpool(EVENTS_DIR, (event) => queue.handle(event), log);
  const command = (name: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(`claudeQueueRelay.${name}`, fn);

  // Claude restarts its CLI processes after a window reload, later than we activate, so keep re-seeding.
  const timers = [
    setInterval(() => cleanupClaims(), 10 * 60_000),
    setInterval(() => {
      queue.seed(true);
      queue.reconcile();
      void queue.syncLaneTitles();
    }, 2 * 60_000),
    setInterval(() => void queue.refreshUsage(), 5 * 60_000),
    ...[20_000, 60_000].map((ms) => setTimeout(() => queue.seed(true), ms)),
  ];

  context.subscriptions.push(
    log,
    queue,
    spool,
    { dispose: () => timers.forEach(clearInterval) },
    command('showQueue', () => run('claudeQueueRelay.board.focus')),
    command('goToSession', (id: string) => queue.goToSession(id)),
    command('goToTab', (label: string) => queue.goToTab(label)),
    command('openLane', (n: number) => queue.openLaneFile(n)),
    command('openLaneFile', (n: number, file: string) => queue.openLaneFile(n, file)),
    command('openCowork', (n: number) => queue.openCowork(n)),
    command('popOut', () => queue.popOut()),
    command('next', () => queue.next()),
    command('jump', () => queue.jump()),
    command('peek', () => queue.peek()),
    command('sweep', () => queue.sweep()),
    command('snooze', (id: string) => queue.snooze(id)),
    command('doctor', () => queue.showDoctor()),
    command('dismissLaneTask', (n: number, file: string) => queue.dismiss(n, file)),
    command('clearLane', (n: number) => queue.clearLane(n)),
    command('toggleQuiet', () => queue.toggleQuiet()),
    command('toggleSound', () => queue.toggleSound()),
    command('toggleToast', () => queue.toggleToast()),
    command('openLog', () => log.show()),
    command('refresh', () => {
      queue.seed();
      queue.reconcile();
      void queue.refreshUsage();
    }),
    command('clear', () => queue.markAllSeen()),
    command('installHooks', () => installHooksInteractively(log)),
    command('setupRelayLanes', () => void setupRelayLanesInteractively(context, log)),
  );

  spool.start();
  enablePinnedRowOnce(context, log);
  regularCloseOnce(context, log);
  if (!hooksInstalled()) offerHookInstall();
  queue.seed();
  queue.unpinAll();
  queue.render();
  void queue.refreshUsage();
  log.info(`activated; roots=${queue.roots().join(', ')}; claude tabs=${tabs.claudeTabs().map((t) => `"${t.label}"`).join(', ') || 'none'}`);
}

export function deactivate(): void {}
