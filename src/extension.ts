import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventSpool, HookEvent } from './events';
import { Log } from './log';
import { Session, SessionRegistry, Transition } from './sessions';
import { readSessionTitle } from './titles';
import * as tabs from './tabs';
import { SoundKind, claim, cleanupClaims, macNotify, playSound } from './notify';
import { QueueView, sessionLabel } from './queueView';
import { Lane, LaneStage, RelayWatcher, laneIsResult, laneTaskLabel } from './relay';
import { BASE_DIR, EVENTS_DIR, hooksInstalled, installHooks } from './hooks';

const HOME = os.homedir();
const LANE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const LANDING_WORDS: Partial<Record<LaneStage, string>> = {
  complete: 'landed',
  partial: 'landed PARTIAL',
  blocked: 'BLOCKED, needs you',
  abandoned: 'abandoned',
};

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, HOME);
const short = (id: string) => id.slice(0, 8);
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

class TabQueue implements vscode.Disposable {
  private readonly registry = new SessionRegistry();
  private readonly relay: RelayWatcher;
  private readonly view: QueueView;
  private readonly status = vscode.window.createStatusBarItem('claudeTabQueue.status', vscode.StatusBarAlignment.Left, 50);
  private readonly pinnedByUs = new Set<string>();
  private readonly pendingPins = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private dancing = false;
  private seenTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext, private readonly log: Log) {
    this.relay = new RelayWatcher(settings.relayLanes, log);
    this.view = new QueueView(this.registry, this.relay, vscode.Uri.joinPath(context.extensionUri, 'media'));
    this.status.name = 'Claude Tab Queue';
    this.status.command = 'claudeTabQueue.showQueue';
    this.status.show();
    this.disposables.push(
      this.relay,
      this.status,
      vscode.window.createTreeView('claudeTabQueue.queue', { treeDataProvider: this.view }),
      this.relay.onDidLand((lane) => this.landed(lane)),
      this.relay.onDidChange(() => this.render()),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.tabsChanged(e)),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
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

  // --- hook events ---------------------------------------------------------

  handle(event: HookEvent): void {
    if (event.agent_id || !this.owns(event.cwd)) return;
    const transition = this.registry.apply(event);
    const session = transition.session;
    this.logTransition(transition);
    if (event.hook_event_name === 'SessionEnd') return this.forget(session);
    if (event.hook_event_name === 'UserPromptSubmit') this.promptSubmitted(session);
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

  // --- titles and tabs -----------------------------------------------------

  private async learnTitle(session: Session): Promise<void> {
    if (!session.transcriptPath) return;
    const title = await readSessionTitle(session.transcriptPath);
    if (!title || title === session.title) return;
    session.title = title;
    this.log.info(`title ${short(session.id)} = "${title}"`);
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

  private sessions(): Session[] {
    return [...this.registry.sessions.values()];
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
    const waiting = session.state === 'waiting';
    const headline = `${session.signal?.emoji ?? (waiting ? '⚠️' : '✅')} ${sessionLabel(session)}`;
    const detail = session.reason ?? (waiting ? 'needs your input' : 'finished');
    const sound: SoundKind = waiting ? 'waiting' : session.signal?.kind === 'failed' ? 'failed' : 'ready';
    if (claim(`evt-${eventFile}`)) this.ping(headline, detail, sound);
    if (!tab) return this.log.info(`surface ${short(session.id)} "${sessionLabel(session)}": no tab in this window`);
    this.toast(`${headline}: ${detail}`, 'Go to tab', () => this.goToSession(session.id));
    await this.pin(tab);
    this.render();
  }

  private landed(lane: Lane): void {
    const task = lane.result;
    const name = task ? laneTaskLabel(task) : 'result';
    const returnTo = task?.returnTo;
    const session = returnTo ? this.sessionTitled(returnTo) : undefined;
    const tab = session ? this.tabOf(session) : returnTo ? tabs.findByLabel(returnTo) : undefined;
    const emoji = LANE_EMOJI[lane.n - 1] ?? `#${lane.n}`;
    const headline = `${emoji} Relay lane ${lane.n} ${LANDING_WORDS[lane.stage] ?? lane.stage}`;
    const detail = `${name}${returnTo ? ` → «${returnTo}»` : ''}. Say "check relay ${lane.n}"`;
    this.log.info(`relay lane ${lane.n} ${lane.stage}: ${name}${returnTo ? ` return-to "${returnTo}"` : ''}${tab ? ' (tab found)' : ''}`);
    if (claim(`relay-${lane.n}-${Math.round(lane.outbound.mtime)}`)) this.ping(headline, detail, lane.stage === 'blocked' ? 'waiting' : 'relay');
    this.toast(`${headline}: ${detail}`, tab ? 'Go to tab' : 'Open result', () => (tab ? this.goToTab(tab.label) : this.openLaneFile(lane.n)));
    if (tab) void this.pin(tab);
    this.render();
  }

  private ping(headline: string, detail: string, sound: SoundKind): void {
    if (settings.sound) playSound(sound);
    if (settings.macNotification) macNotify(headline, detail);
  }

  private toast(message: string, action: string, onAction: () => unknown): void {
    if (!settings.toast) return;
    void vscode.window.showInformationMessage(message, action).then((choice) => choice && onAction());
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
    if (active) {
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
    const session = this.sessionOnTab(tab);
    if (session?.state === 'ready' && !session.seenAt) {
      session.seenAt = Date.now();
      this.log.info(`seen "${tab.label}"`);
    }
    if (session?.state !== 'waiting') void this.unpin(tab.label);
    this.render();
  }

  // --- navigation ----------------------------------------------------------

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

  markAllSeen(): void {
    for (const s of this.sessions()) if (s.state === 'ready') s.seenAt ??= Date.now();
    for (const lane of this.relay.lanes) this.relay.markSeen(lane.n);
    this.pendingPins.clear();
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

  render(): void {
    const sessions = this.sessions();
    const counts = {
      'waiting on you': sessions.filter((s) => s.state === 'waiting').length,
      ready: sessions.filter((s) => s.state === 'ready' && !s.seenAt).length,
      'relay landed': this.relay.lanes.filter((l) => laneIsResult(l) && !l.seen).length,
      'relay blocked': this.relay.lanes.filter((l) => l.stage === 'blocked').length,
    };
    const parts = Object.entries(counts).filter(([, n]) => n).map(([what, n]) => `${n} ${what}`);
    const urgent = counts['waiting on you'] || counts['relay landed'] || counts['relay blocked'];
    this.status.text = parts.length ? `$(bell-dot) ${parts.join(' · ')}` : '$(bell) Claude: all quiet';
    this.status.tooltip = 'Claude Tab Queue: click to open the queue';
    this.status.backgroundColor = urgent ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.view.refresh(), 250);
  }

  redraw(): void {
    this.view.refresh();
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
    .then((choice) => choice && vscode.commands.executeCommand('claudeTabQueue.installHooks'));
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
  const queue = new TabQueue(context, log);
  const spool = new EventSpool(EVENTS_DIR, (event) => queue.handle(event), log);
  const command = (name: string, run: (...args: any[]) => unknown) => vscode.commands.registerCommand(`claudeTabQueue.${name}`, run);

  // Claude restarts its CLI processes after a window reload, later than we activate, so keep re-seeding.
  const timers = [
    setInterval(() => cleanupClaims(), 10 * 60_000),
    setInterval(() => {
      queue.seed(true);
      queue.reconcile();
    }, 2 * 60_000),
    setInterval(() => queue.redraw(), 30_000),
    ...[20_000, 60_000].map((ms) => setTimeout(() => queue.seed(true), ms)),
  ];

  context.subscriptions.push(
    log,
    queue,
    spool,
    { dispose: () => timers.forEach(clearInterval) },
    command('showQueue', () => vscode.commands.executeCommand('claudeTabQueue.queue.focus')),
    command('goToSession', (id: string) => queue.goToSession(id)),
    command('goToTab', (label: string) => queue.goToTab(label)),
    command('openLane', (n: number) => queue.openLaneFile(n)),
    command('openLaneFile', (n: number, file: string) => queue.openLaneFile(n, file)),
    command('openLog', () => log.show()),
    command('refresh', () => {
      queue.seed();
      queue.reconcile();
    }),
    command('clear', () => queue.markAllSeen()),
    command('installHooks', () => installHooksInteractively(log)),
  );

  spool.start();
  enablePinnedRowOnce(context, log);
  if (!hooksInstalled()) offerHookInstall();
  queue.seed();
  queue.render();
  log.info(`activated; roots=${queue.roots().join(', ')}; claude tabs=${tabs.claudeTabs().map((t) => `"${t.label}"`).join(', ') || 'none'}`);
}

export function deactivate(): void {}
