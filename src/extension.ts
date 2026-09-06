import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventSpool, HookEvent } from './events';
import { Log } from './log';
import { Session, SessionRegistry, Transition } from './sessions';
import { readSessionTitle } from './titles';
import * as tabs from './tabs';
import { SoundKind, claim, cleanupClaims, macNotify, playSound } from './notify';
import { Age, Board, BoardMessage, LaneRow, Row, Snapshot } from './board';
import { Lane, LaneStage, LaneTask, RelayWatcher, laneIsResult, laneLook, laneTaskLabel, taskNameIn } from './relay';
import { openCowork } from './cowork';
import { Usage, currentUsage, resetsIn } from './usage';
import { BASE_DIR, EVENTS_DIR, hooksInstalled, installHooks } from './hooks';

const HOME = os.homedir();
const LANE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const LANDING_WORDS: Partial<Record<LaneStage, string>> = {
  complete: 'landed',
  partial: 'landed PARTIAL',
  blocked: 'BLOCKED, needs you',
  abandoned: 'abandoned',
};
const QUIET_FILE = path.join(BASE_DIR, 'quiet');
// What Alex should look at first, in order.
const RANK = { money: 0, waiting: 1, failed: 2, blocked: 3, landed: 4, file: 5, ready: 6 } as const;
type Rank = keyof typeof RANK;
const SIGNAL_RANK: Record<string, Rank> = { money: 'money', failed: 'failed', file: 'file', 'needs-you': 'waiting' };
// Minutes after which a row turns amber, then red.
const AGE_LIMITS: Record<string, [number, number]> = { waiting: [20, 60], running: [20, 240], lane: [30, 120] };

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, HOME);
const short = (id: string) => id.slice(0, 8);
const run = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args);
const setting = <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('claudeTabQueue').get<T>(key, fallback);

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

interface Step {
  rank: number;
  since: number;
  label: string;
  text: string;
  run: () => unknown;
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

// Keystrokes land in whatever has focus, so callers activate the tab and focus Claude's input first.
function typeIntoFocused(text: string): Promise<boolean> {
  const script = ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`, '-e', 'delay 0.05', '-e', 'tell application "System Events" to key code 36'];
  return new Promise((resolve) => execFile('osascript', script, (err) => resolve(!err)));
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
  private readonly status = vscode.window.createStatusBarItem('claudeTabQueue.status', vscode.StatusBarAlignment.Left, 50);
  private readonly pinnedByUs = new Set<string>();
  private readonly pendingPins = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly held: Announcement[] = [];
  private muted = false;
  private usage?: Usage;
  private dancing = false;
  private seenTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly log: Log) {
    this.relay = new RelayWatcher(settings.relayLanes, log);
    this.status.name = 'Claude Tab Queue';
    this.status.command = 'claudeTabQueue.next';
    this.status.show();
    this.loadQuiet();
    this.disposables.push(
      this.relay,
      this.status,
      this.board,
      vscode.window.registerWebviewViewProvider('claudeTabQueue.board', this.board, { webviewOptions: { retainContextWhenHidden: true } }),
      this.relay.onDidLand((lane) => this.landed(lane)),
      this.relay.onDidChange(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeTabQueue') && this.render()),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.tabsChanged(e)),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
      vscode.window.onDidChangeWindowState(() => this.tabsChanged()),
      watchQuietFile(() => {
        this.loadQuiet();
        this.render();
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.seenTimer);
    clearTimeout(this.refreshTimer);
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

  // --- hook events ---------------------------------------------------------

  handle(event: HookEvent): void {
    if (event.agent_id || !this.owns(event.cwd)) return;
    const transition = this.registry.apply(event);
    const session = transition.session;
    this.logTransition(transition);
    if (event.hook_event_name === 'SessionEnd') return this.forget(session);
    if (event.hook_event_name === 'UserPromptSubmit') this.promptSubmitted(session);
    const touch = this.laneTouched(event);
    if (touch) void this.laneTouchedBy(session, touch);
    if (transition.from === 'waiting' && transition.to === 'running' && session.tabLabel) void this.unpin(session.tabLabel);
    if (!session.title) void this.learnTitle(session).then(() => this.render());
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
    if (e.tool_name === 'Bash' && /send\.sh/.test(target)) return { n, action: 'assign' };
    if (e.tool_name === 'Bash' && touchesOutbound && !touchesInbound) return { n, action: 'release' };
    return undefined;
  }

  private async laneTouchedBy(session: Session, touch: LaneTouch): Promise<void> {
    const { n, action } = touch;
    if (action === 'release') {
      if (!session.lanes.includes(n)) return;
      session.lanes = session.lanes.filter((lane) => lane !== n);
      this.log.info(`${short(session.id)} collected lane ${n}`);
      await this.retitle(session, (title) => title.replace(new RegExp(`^${n}️?⃣\\s*`), ''));
      return;
    }
    if (!session.lanes.includes(n)) session.lanes = [...session.lanes, n].sort();
    const lane = this.relay.lanes[n - 1];
    const name = (touch.file && taskNameIn(touch.file)) || (lane && taskNameIn(path.join(lane.dir, 'relay', 'inbound.md')));
    this.log.info(`${short(session.id)} sent "${name ?? '?'}" to lane ${n}`);
    if (name) await this.retitle(session, () => `${LANE_EMOJI[n - 1] ?? n} ${name}`);
    this.render();
  }

  // --- titles and tabs -----------------------------------------------------

  private async learnTitle(session: Session): Promise<void> {
    if (!session.transcriptPath) return;
    const title = await readSessionTitle(session.transcriptPath);
    if (!title || title === session.title) return;
    session.title = title;
    this.log.info(`title ${short(session.id)} = "${title}"`);
  }

  private async retitle(session: Session, rename: (current: string) => string): Promise<void> {
    await this.learnTitle(session);
    const tab = this.tabOf(session);
    if (!tab) return;
    const current = session.title ?? tab.label;
    const next = rename(current);
    if (next === current || this.dancing) return;
    this.dancing = true;
    try {
      const ok = await tabs.renameTab(tab, next);
      this.log.info(`${ok ? 'renamed' : 'could not rename'} "${current}" → "${next}"`);
      if (!ok) return;
      session.title = next;
      session.tabLabel = tab.label;
    } catch (err) {
      this.log.warn(`rename failed for "${current}": ${err}`);
    } finally {
      this.dancing = false;
    }
  }

  private tabOf(session: Session): vscode.Tab | undefined {
    if (session.tab && tabs.locate(session.tab)) return session.tab;
    session.tab = undefined;
    const name = session.title ?? session.tabLabel;
    if (!name) return undefined;
    const taken = new Set(this.sessions().filter((s) => s !== session && s.tab).map((s) => s.tab!));
    const tab = tabs.findByLabel(name, taken);
    if (!tab) return undefined;
    session.tab = tab;
    session.tabLabel = tab.label;
    this.log.info(`bound ${short(session.id)} → tab "${tab.label}" (by label)`);
    return tab;
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

  private sessionTitled(title: string): Session | undefined {
    return this.sessions().find((s) => s.title === title || (!!s.tabLabel && tabs.labelMatches(s.tabLabel, title)));
  }

  private sessionOnTab(tab: vscode.Tab): Session | undefined {
    return (
      this.sessions().find((s) => s.tab === tab) ??
      this.sessions().find((s) => (s.title ? tabs.labelMatches(tab.label, s.title) : s.tabLabel === tab.label))
    );
  }

  // --- surfacing -----------------------------------------------------------

  private async surface(session: Session, eventFile: string): Promise<void> {
    await this.learnTitle(session);
    const tab = this.tabOf(session);
    const label = sessionLabel(session);
    const waiting = session.state === 'waiting';
    const kind = session.signal?.kind;
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
    const session = returnTo ? this.sessionTitled(returnTo) : undefined;
    const tab = session ? this.tabOf(session) : returnTo ? tabs.findByLabel(returnTo) : undefined;
    const emoji = LANE_EMOJI[lane.n - 1] ?? `#${lane.n}`;
    this.log.info(`relay lane ${lane.n} ${lane.stage}: ${name}${returnTo ? ` return-to "${returnTo}"` : ''}${tab ? ' (tab found)' : ''}`);
    this.announce({
      key: `relay-${lane.n}-${Math.round(lane.outbound.mtime)}`,
      headline: `${emoji} Relay lane ${lane.n} ${LANDING_WORDS[lane.stage] ?? lane.stage}`,
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
    if (a.tab) void this.pin(a.tab);
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
    await vscode.workspace.getConfiguration('claudeTabQueue').update(key, value, vscode.ConfigurationTarget.Global);
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
    this.toast(`${why}: ${held.length} landed. ${lines.join(' · ')}`, 'Show queue', () => run('claudeTabQueue.board.focus'));
  }

  // --- pinning -------------------------------------------------------------

  private async pin(tab: vscode.Tab): Promise<void> {
    if (settings.pinMode === 'off') return;
    if (tabs.activeClaudeTab()?.label === tab.label) return this.log.info(`"${tab.label}" is already in front of you; not pinning`);
    if (settings.pinMode === 'onNextSwitch' || this.dancing) {
      this.pendingPins.add(tab.label);
      return;
    }
    this.dancing = true;
    try {
      const ok = await tabs.pinToFront(tab, { markUnread: settings.markUnread, log: (m) => this.log.warn(m) });
      if (!ok) return this.log.warn(`could not locate tab "${tab.label}" to pin`);
      this.pinnedByUs.add(tab.label);
      this.pendingPins.delete(tab.label);
      this.log.info(`pinned "${tab.label}" to front`);
    } catch (err) {
      this.log.warn(`pin failed for "${tab.label}": ${err}`);
    } finally {
      this.dancing = false;
    }
    this.pinNextPending();
  }

  private pinNextPending(except?: string): void {
    for (const label of this.pendingPins) {
      if (label === except) continue;
      const tab = tabs.findByLabel(label);
      if (!tab) continue;
      this.pendingPins.delete(label);
      void this.pin(tab);
      return;
    }
  }

  private async unpin(label: string): Promise<void> {
    this.pendingPins.delete(label);
    if (!this.pinnedByUs.has(label)) return;
    try {
      if (!(await tabs.unpinActive(label))) return;
      this.pinnedByUs.delete(label);
      this.log.info(`unpinned "${label}"`);
    } catch (err) {
      this.log.warn(`unpin failed for "${label}": ${err}`);
    }
  }

  private tabsChanged(e?: vscode.TabChangeEvent): void {
    for (const tab of e?.closed ?? []) this.tabClosed(tab);
    for (const tab of e?.changed ?? []) for (const s of this.sessions()) if (s.tab === tab) s.tabLabel = tab.label;
    if (this.dancing) return;
    clearTimeout(this.seenTimer);
    const active = tabs.activeClaudeTab();
    if (active && vscode.window.state.focused) {
      this.pinNextPending(active.label);
      this.seenTimer = setTimeout(() => this.viewed(active), 1500);
    }
    this.render();
  }

  private tabClosed(tab: vscode.Tab): void {
    for (const s of this.sessions()) if (s.tab === tab) s.tab = undefined;
    if (tabs.findByLabel(tab.label)) return;
    this.pinnedByUs.delete(tab.label);
    this.pendingPins.delete(tab.label);
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
      case 'receive':
        return void this.receive(m.n);
      case 'goToReturn':
        return void this.goToReturn(m.returnTo, m.n);
    }
  }

  async goToSession(id: string): Promise<void> {
    const session = this.registry.sessions.get(id);
    if (!session) return;
    const tab = this.tabOf(session);
    if (!tab) return void vscode.window.showWarningMessage(`No open tab for "${sessionLabel(session)}" in this window.`);
    await this.focus(tab);
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
    const lane = this.relay.lanes.find((l) => l.n === n);
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

  // Going to a landed lane means going to the tab that will say "check relay N".
  private collect(lane: Lane): Promise<void> {
    const returnTo = lane.result?.returnTo;
    const session = returnTo ? this.sessionTitled(returnTo) : undefined;
    if (session) return this.goToSession(session.id);
    const tab = returnTo ? tabs.findByLabel(returnTo) : undefined;
    return tab ? this.goToTab(tab.label) : this.openLaneFile(lane.n);
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
      label: `${e.lanes.map((n) => LANE_EMOJI[n - 1] ?? `#${n}`).join('')}${e.emoji ? `${e.emoji} ` : ''}${e.label}`,
      description: e.text,
      run: () => (e.sessionId ? this.goToSession(e.sessionId) : this.goToTab(e.tabLabel ?? e.label)),
    });
    add('Waiting on you', entries.filter((e) => e.state === 'waiting').map(pick));
    add('Ready', entries.filter((e) => e.state === 'ready' && !e.seen).map(pick));
    add('Tabs', entries.map(pick));
    add(
      'Relay lanes',
      this.relay.lanes.map((lane) => ({
        label: `${LANE_EMOJI[lane.n - 1]} Lane ${lane.n}`,
        description: laneLook(lane).description,
        run: () => this.openCowork(lane.n),
      })),
    );
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Jump to a Claude tab or relay lane', matchOnDescription: true });
    await chosen?.run?.();
  }

  // Move queued tasks from the fullest lane to the emptiest until no lane is 2+ ahead.
  balance(): void {
    const moved: string[] = [];
    for (let guard = 0; guard < 9; guard++) {
      const lanes = [...this.relay.lanes].sort((a, b) => this.relay.load(b) - this.relay.load(a));
      const from = lanes[0];
      const to = lanes[lanes.length - 1];
      if (!from || !to || this.relay.load(from) - this.relay.load(to) < 2) break;
      const task = [...from.queue].reverse().find((t) => !t.chained);
      if (!task) break;
      this.relay.moveQueued(task, to);
      this.retag(task.returnTo, from.n, to.n);
      moved.push(`"${laneTaskLabel(task)}" ${from.n} → ${to.n}`);
    }
    this.log.info(moved.length ? `balanced lanes: ${moved.join('; ')}` : 'balance: lanes already even');
    if (!moved.length) return void vscode.window.setStatusBarMessage('Lanes are already even', 2500);
    this.toast(`Evened out the lanes: ${moved.join(' · ')}`, 'Show queue', () => run('claudeTabQueue.board.focus'));
    this.render();
  }

  // The tab that sent a moved task now waits on the new lane.
  private retag(returnTo: string | undefined, from: number, to: number): void {
    const session = returnTo ? this.sessionTitled(returnTo) : undefined;
    if (!session) return;
    session.lanes = [...session.lanes.filter((n) => n !== from), to].sort();
    void this.retitle(session, (title) => title.replace(new RegExp(`^${from}️?⃣`), LANE_EMOJI[to - 1] ?? String(to)));
  }

  // "Receive": put the landed result in front of the tab that asked for it by typing its own trigger phrase.
  async receive(n: number): Promise<void> {
    const lane = this.relay.lanes.find((l) => l.n === n);
    if (!lane) return;
    const returnTo = lane.result?.returnTo;
    const tab = this.tabFor(returnTo);
    if (!tab) return void vscode.window.showWarningMessage(`No open tab here for lane ${n}'s result${returnTo ? ` («${returnTo}»)` : ''}.`);
    if (!vscode.window.state.focused) return void vscode.window.showWarningMessage('Click into VS Code first, then press Receive again.');
    await tabs.activate(tab);
    if (vscode.window.activeTextEditor?.selection.isEmpty !== false) await tabs.focusClaudeInput();
    await new Promise((r) => setTimeout(r, 350));
    const typed = await typeIntoFocused(`check relay ${n}`);
    this.relay.markSeen(n);
    this.log.info(`receive lane ${n} → "${tab.label}": ${typed ? 'typed' : 'could not type (Accessibility?)'}`);
    if (!typed) void vscode.window.showWarningMessage(`Couldn't type into the tab (allow VS Code under System Settings → Privacy → Accessibility). Type "check relay ${n}" there.`);
    this.render();
  }

  async goToReturn(returnTo: string, n: number): Promise<void> {
    const tab = this.tabFor(returnTo);
    if (!tab) return void vscode.window.showWarningMessage(returnTo ? `No open tab here named «${returnTo}» (lane ${n}).` : `Lane ${n}: that task has no RETURN-TO tab.`);
    await this.focus(tab);
  }

  private tabFor(returnTo: string | undefined): vscode.Tab | undefined {
    if (!returnTo) return undefined;
    const session = this.sessionTitled(returnTo);
    return (session && this.tabOf(session)) ?? tabs.findByLabel(returnTo);
  }

  markAllSeen(): void {
    for (const s of this.sessions()) if (s.state === 'ready') s.seenAt ??= Date.now();
    for (const lane of this.relay.lanes) this.relay.markSeen(lane.n);
    this.pendingPins.clear();
    this.render();
  }

  // --- the board -----------------------------------------------------------

  // Every open Claude tab in tab order, joined to its session when known, then sessions with no tab here.
  private rows(): Entry[] {
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
    for (const s of sessions) if (!used.has(s)) entries.push(this.entry(s, undefined));
    return entries;
  }

  private entry(session: Session | undefined, tab: vscode.Tab | undefined): Entry {
    const label = session?.title ?? tab?.label ?? (session ? sessionLabel(session) : 'tab');
    const lanes = new Set<number>(session?.lanes ?? []);
    for (const n of this.relay.lanesFor([label, tab?.label, session?.title, session?.tabLabel])) lanes.add(n);
    const base = { label, tabLabel: tab?.label ?? session?.tabLabel, lanes: [...lanes].sort(), hasTab: !!tab, tab };
    if (!session) return { ...base, key: `t:${label}`, state: 'idle', text: 'no activity yet', seen: true, since: 0 };
    const state = session.state === 'ended' ? 'idle' : session.state;
    const a = age(state === 'running' ? session.lastEventAt : session.since, state);
    const ask = session.signal?.action ?? session.reason;
    const text =
      state === 'waiting'
        ? `${ask ?? 'needs you'} · waiting ${a.text}`
        : state === 'running'
          ? `running ${a.text}`
          : state === 'ready'
            ? `${ask ?? 'finished'} · ${a.text === 'just now' ? a.text : `${a.text} ago`}`
            : `idle · ${a.text}`;
    return {
      ...base,
      key: `s:${session.id}`,
      sessionId: session.id,
      state,
      emoji: session.signal && session.signal.kind !== 'lane' ? session.signal.emoji : undefined,
      text,
      age: a,
      seen: !!session.seenAt,
      since: session.since,
      session,
    };
  }

  private laneRow(lane: Lane, entries: Entry[]): LaneRow {
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
      tasks: tasks.map((t) => ({ role: t.role, label: t.taskName ?? t.returnTo ?? laneTaskLabel(t), status: t.status, returnTo: t.returnTo, file: t.file, position: t.position })),
      tabs: entries.filter((e) => e.lanes.includes(lane.n)).map((e) => ({ label: e.label, sessionId: e.sessionId, tabLabel: e.tabLabel })),
    };
  }

  private ladder(): Step[] {
    const steps: Step[] = [];
    for (const e of this.rows()) {
      const s = e.session;
      if (!s) continue;
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

  // One list, no sections: what needs Alex first, then running, then seen, then idle at the bottom.
  // Tabs waiting on a relay lane live in that lane's drawer instead, unless they need input right now.
  private snapshot(): Snapshot {
    const entries = this.rows();
    const tier = (e: Entry) => (e.state === 'waiting' ? 0 : e.state === 'ready' ? (e.seen ? 3 : 1) : e.state === 'running' ? 2 : 4);
    const strip = ({ since, session, tab, ...row }: Entry): Row => row;
    const visible = entries.map((e, order) => ({ e, order })).filter(({ e }) => !e.lanes.length || e.state === 'waiting');
    visible.sort((a, b) => {
      const ta = tier(a.e);
      const tb = tier(b.e);
      if (ta !== tb) return ta - tb;
      if (ta === 0) return a.e.since - b.e.since;
      if (ta === 4) return a.order - b.order;
      return b.e.since - a.e.since;
    });
    return {
      quiet: this.quiet ? { held: this.held.length } : undefined,
      sound: settings.sound,
      toast: settings.toast,
      usage: this.usage && {
        meters: this.usage.meters.map((m) => ({ label: m.label, percent: m.percent, resetsIn: resetsIn(m.resetsAt) })),
        spend: this.usage.spend,
        error: this.usage.meters.length ? undefined : this.usage.error,
      },
      rows: visible.map(({ e }) => strip(e)),
      lanes: this.relay.lanes.map((lane) => this.laneRow(lane, entries)),
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
    this.status.tooltip = first ? `${first.text}\nClick or ⌃⌘U: go there. ⌃⌘J: jump anywhere.` : 'Claude Tab Queue';
  }

  async refreshUsage(): Promise<void> {
    this.usage = await currentUsage();
    if (this.usage.error) this.log.warn(`usage: ${this.usage.error}`);
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
    if (!quiet) this.log.info(`seeded ${n} live session(s) from ~/.claude/sessions`);
  }

  // Drop sessions whose CLI process is gone and that have been silent for a while.
  reconcile(): void {
    const live = new Set(liveSessions().map((s) => s.sessionId));
    const cutoff = Date.now() - 5 * 60_000;
    for (const s of this.sessions()) {
      if (live.has(s.id) || s.lastEventAt > cutoff) continue;
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
      ? `Claude Tab Queue: hooks added for ${r.added.join(', ')}. Backup: ${r.backup ?? 'none'}`
      : 'Claude Tab Queue: hooks were already installed.';
    log.info(msg);
    void vscode.window.showInformationMessage(msg);
  } catch (err) {
    void vscode.window.showErrorMessage(`Claude Tab Queue: hook install failed: ${err}`);
  }
}

function offerHookInstall(): void {
  void vscode.window
    .showInformationMessage('Claude Tab Queue needs its Claude Code hooks installed to see sessions.', 'Install hooks')
    .then((choice) => choice && run('claudeTabQueue.installHooks'));
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
  const command = (name: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(`claudeTabQueue.${name}`, fn);

  // Claude restarts its CLI processes after a window reload, later than we activate, so keep re-seeding.
  const timers = [
    setInterval(() => cleanupClaims(), 10 * 60_000),
    setInterval(() => {
      queue.seed(true);
      queue.reconcile();
    }, 2 * 60_000),
    setInterval(() => void queue.refreshUsage(), 5 * 60_000),
    ...[20_000, 60_000].map((ms) => setTimeout(() => queue.seed(true), ms)),
  ];

  context.subscriptions.push(
    log,
    queue,
    spool,
    { dispose: () => timers.forEach(clearInterval) },
    command('showQueue', () => run('claudeTabQueue.board.focus')),
    command('goToSession', (id: string) => queue.goToSession(id)),
    command('goToTab', (label: string) => queue.goToTab(label)),
    command('openLane', (n: number) => queue.openLaneFile(n)),
    command('openLaneFile', (n: number, file: string) => queue.openLaneFile(n, file)),
    command('openCowork', (n: number) => queue.openCowork(n)),
    command('popOut', () => queue.popOut()),
    command('next', () => queue.next()),
    command('jump', () => queue.jump()),
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
  );

  spool.start();
  enablePinnedRowOnce(context, log);
  if (!hooksInstalled()) offerHookInstall();
  queue.seed();
  queue.render();
  void queue.refreshUsage();
  log.info(`activated; roots=${queue.roots().join(', ')}; claude tabs=${tabs.claudeTabs().map((t) => `"${t.label}"`).join(', ') || 'none'}`);
}

export function deactivate(): void {}
