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
import { RelayWatcher, laneReturnTo, laneSummary, laneTaskName } from './relay';
import { BASE_DIR, EVENTS_DIR, hooksInstalled, installHooks } from './hooks';

const HOME = os.homedir();
const LANE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, HOME);
const short = (id: string): string => id.slice(0, 8);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function activate(context: vscode.ExtensionContext): void {
  const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const windowName = vscode.workspace.name ?? path.basename(firstFolder ?? 'window');
  const log = new Log(path.join(BASE_DIR, 'log.txt'), windowName);
  const cfg = <T>(key: string, fallback: T): T => vscode.workspace.getConfiguration('claudeTabQueue').get<T>(key, fallback);

  const registry = new SessionRegistry();
  const relay = new RelayWatcher(cfg<string[]>('relayLanes', []).map(expandHome), log);
  const view = new QueueView(registry, relay);
  const tree = vscode.window.createTreeView('claudeTabQueue.queue', { treeDataProvider: view });
  const status = vscode.window.createStatusBarItem('claudeTabQueue.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Claude Tab Queue';
  status.command = 'claudeTabQueue.showQueue';
  status.show();

  const pinnedByUs = new Set<string>();
  const pendingPins = new Set<string>();
  let dancing = false;
  let seenTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;

  const roots = (): string[] => [
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ...cfg<string[]>('extraRoots', []).map(expandHome),
  ];
  const owns = (cwd: string): boolean =>
    roots().some((r) => cwd === r || cwd.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`));
  const sound = (kind: SoundKind): void => {
    if (cfg('sound', true)) playSound(kind);
  };
  const notifyMac = (title: string, body: string): void => {
    if (cfg('macNotification', true)) macNotify(title, body);
  };

  function updateStatus(): void {
    const all = [...registry.sessions.values()];
    const waiting = all.filter((s) => s.state === 'waiting').length;
    const ready = all.filter((s) => s.state === 'ready' && !s.seenAt).length;
    const landed = relay.lanes.filter((l) => l.landedAt && !l.seen).length;
    const parts: string[] = [];
    if (waiting) parts.push(`${waiting} waiting on you`);
    if (ready) parts.push(`${ready} ready`);
    if (landed) parts.push(`${landed} relay landed`);
    status.text = parts.length ? `$(bell-dot) ${parts.join(' · ')}` : '$(bell) Claude: all quiet';
    status.tooltip = 'Claude Tab Queue: click to open the queue';
    status.backgroundColor = waiting || landed ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => view.refresh(), 250);
  }

  async function refreshTitle(s: Session): Promise<void> {
    if (!s.transcriptPath) return;
    const title = await readSessionTitle(s.transcriptPath);
    if (title && title !== s.title) {
      s.title = title;
      log.info(`title ${short(s.id)} = "${title}"`);
    }
  }

  function bindByLabel(s: Session): vscode.Tab | undefined {
    if (s.tab && tabs.locate(s.tab)) return s.tab;
    s.tab = undefined;
    const label = s.title ?? s.tabLabel;
    if (!label) return undefined;
    const taken = new Set<vscode.Tab>();
    for (const other of registry.sessions.values()) if (other !== s && other.tab) taken.add(other.tab);
    const tab = tabs.findByLabel(label, taken);
    if (tab) {
      s.tab = tab;
      s.tabLabel = tab.label;
      log.info(`bound ${short(s.id)} → tab "${tab.label}" (by label)`);
    }
    return tab;
  }

  // The tab that is active when a prompt is submitted is the tab of that session.
  function bindActiveTab(s: Session): void {
    if (dancing) return;
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tabs.isClaudeTab(active)) return;
    for (const other of registry.sessions.values()) {
      if (other !== s && other.tab === active) other.tab = undefined;
    }
    if (s.tab !== active) log.info(`bound ${short(s.id)} → tab "${active.label}" (active at prompt)`);
    s.tab = active;
    s.tabLabel = active.label;
  }

  function findSessionByTitle(title: string): Session | undefined {
    return [...registry.sessions.values()].find(
      (s) => s.title === title || (!!s.tabLabel && tabs.labelMatches(s.tabLabel, title)),
    );
  }

  async function pinTab(tab: vscode.Tab): Promise<void> {
    const mode = cfg<string>('pinMode', 'immediate');
    if (mode === 'off') return;
    if (tabs.activeClaudeTab()?.label === tab.label) {
      log.info(`"${tab.label}" is already in front of you; not pinning`);
      return;
    }
    if (mode === 'onNextSwitch' || dancing) {
      pendingPins.add(tab.label);
      return;
    }
    dancing = true;
    try {
      const ok = await tabs.pinToFront(tab, { markUnread: cfg('markUnread', true), log: (m) => log.warn(m) });
      if (ok) {
        pinnedByUs.add(tab.label);
        pendingPins.delete(tab.label);
        log.info(`pinned "${tab.label}" to front`);
      } else {
        log.warn(`could not locate tab "${tab.label}" to pin`);
      }
    } catch (err) {
      log.warn(`pin failed for "${tab.label}": ${err}`);
    } finally {
      dancing = false;
    }
    for (const label of pendingPins) {
      const next = tabs.findByLabel(label);
      if (next) {
        pendingPins.delete(label);
        void pinTab(next);
        break;
      }
    }
  }

  async function maybeUnpin(label: string): Promise<void> {
    pendingPins.delete(label);
    if (!pinnedByUs.has(label)) return;
    try {
      if (await tabs.unpinActive(label)) {
        pinnedByUs.delete(label);
        log.info(`unpinned "${label}"`);
      }
    } catch (err) {
      log.warn(`unpin failed for "${label}": ${err}`);
    }
  }

  async function goToSession(id: string): Promise<void> {
    const s = registry.sessions.get(id);
    if (!s) return;
    const tab = bindByLabel(s);
    if (!tab) {
      void vscode.window.showWarningMessage(`No open tab for "${sessionLabel(s)}" in this window.`);
      return;
    }
    await tabs.activate(tab);
    await tabs.focusClaudeInput();
  }

  async function openLane(n: number): Promise<void> {
    const lane = relay.lanes.find((l) => l.n === n);
    if (!lane) return;
    const file = laneSummary(lane).file;
    relay.markSeen(n);
    updateStatus();
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not open ${file}: ${err}`);
    }
  }

  async function surface(t: Transition): Promise<void> {
    const s = t.session;
    await refreshTitle(s);
    const tab = bindByLabel(s);
    const label = sessionLabel(s);
    const waiting = s.state === 'waiting';
    const kind: SoundKind = waiting ? 'waiting' : s.signal?.kind === 'failed' ? 'failed' : 'ready';
    const headline = `${s.signal?.emoji ?? (waiting ? '⚠️' : '✅')} ${label}`;
    const detail = s.reason ?? (waiting ? 'needs your input' : 'finished');
    if (claim(`evt-${t.event.file}`)) {
      sound(kind);
      notifyMac(headline, detail);
    }
    if (!tab) {
      log.info(`surface ${short(s.id)} "${label}": no tab in this window`);
      return;
    }
    if (cfg('toast', true)) {
      void vscode.window.showInformationMessage(`${headline}: ${detail}`, 'Go to tab').then((choice) => {
        if (choice) void goToSession(s.id);
      });
    }
    await pinTab(tab);
  }

  function handle(e: HookEvent): void {
    if (e.agent_id || !owns(e.cwd)) return;
    const t = registry.apply(e);
    const s = t.session;
    const quiet = e.hook_event_name === 'PostToolUse' || e.hook_event_name === 'PostToolUseFailure';
    if (!quiet || t.to !== t.from) {
      const tag = e.tool_name ? `:${e.tool_name}` : e.notification_type ? `:${e.notification_type}` : '';
      log.info(`${e.hook_event_name}${tag} ${short(s.id)} ${t.from}→${t.to}`);
    }
    if (e.hook_event_name === 'SessionEnd') {
      if (s.tabLabel) pendingPins.delete(s.tabLabel);
      registry.remove(s.id);
      updateStatus();
      return;
    }
    if (e.hook_event_name === 'UserPromptSubmit') {
      bindActiveTab(s);
      if (s.tabLabel) void maybeUnpin(s.tabLabel);
    }
    if (t.to === 'running' && t.from === 'waiting' && s.tabLabel) void maybeUnpin(s.tabLabel);
    if (!s.title) {
      void refreshTitle(s).then(() => {
        bindByLabel(s);
        updateStatus();
      });
    }
    if (t.to !== t.from && (t.to === 'ready' || t.to === 'waiting')) void surface(t).finally(updateStatus);
    updateStatus();
  }

  function onTabsChanged(): void {
    if (dancing) return;
    clearTimeout(seenTimer);
    const active = tabs.activeClaudeTab();
    if (!active) return;
    for (const label of [...pendingPins]) {
      if (label === active.label) continue;
      const tab = tabs.findByLabel(label);
      if (tab) void pinTab(tab);
    }
    seenTimer = setTimeout(() => {
      const all = [...registry.sessions.values()];
      const s =
        all.find((x) => x.tab === active) ??
        all.find((x) => (x.title ? tabs.labelMatches(active.label, x.title) : x.tabLabel === active.label));
      if (s && s.state === 'ready' && !s.seenAt) {
        s.seenAt = Date.now();
        log.info(`seen "${active.label}"`);
      }
      if (!s || s.state !== 'waiting') void maybeUnpin(active.label);
      updateStatus();
    }, 1500);
  }

  function seed(): void {
    const dir = path.join(HOME, '.claude', 'sessions');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
          sessionId?: string;
          cwd?: string;
          pid?: number;
        };
        if (!meta.sessionId || !meta.cwd || !owns(meta.cwd) || (meta.pid && !alive(meta.pid))) continue;
        const s = registry.ensure(meta.sessionId, meta.cwd);
        s.transcriptPath ??= path.join(HOME, '.claude', 'projects', meta.cwd.replace(/[/.]/g, '-'), `${meta.sessionId}.jsonl`);
        n++;
        void refreshTitle(s).then(() => {
          bindByLabel(s);
          updateStatus();
        });
      } catch {
        // malformed session file; skip
      }
    }
    log.info(`seeded ${n} live session(s) from ~/.claude/sessions`);
  }

  // Drop sessions whose CLI process is gone and that have been silent for a while.
  function reconcile(): void {
    const dir = path.join(HOME, '.claude', 'sessions');
    const live = new Set<string>();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { sessionId?: string; pid?: number };
        if (meta.sessionId && (!meta.pid || alive(meta.pid))) live.add(meta.sessionId);
      }
    } catch {
      return;
    }
    const cutoff = Date.now() - 5 * 60_000;
    for (const s of [...registry.sessions.values()]) {
      if (!live.has(s.id) && s.lastEventAt < cutoff) {
        registry.sessions.delete(s.id);
        log.info(`dropped ended session ${short(s.id)} "${sessionLabel(s)}"`);
      }
    }
    updateStatus();
  }

  relay.onDidLand((lane) => {
    const name = laneTaskName(lane.outbound) ?? 'result';
    const emoji = LANE_EMOJI[lane.n - 1] ?? `#${lane.n}`;
    const returnTo = laneReturnTo(lane.outbound);
    const target = returnTo ? findSessionByTitle(returnTo) : undefined;
    const tab = target ? bindByLabel(target) : returnTo ? tabs.findByLabel(returnTo) : undefined;
    const headline = `${emoji} Relay lane ${lane.n} landed`;
    const detail = `${name}${returnTo ? ` → «${returnTo}»` : ''}. Say "check relay ${lane.n}"`;
    log.info(`relay lane ${lane.n} landed: ${name}${returnTo ? ` return-to "${returnTo}"` : ''}${tab ? ' (tab found)' : ''}`);
    if (claim(`relay-${lane.n}-${Math.round(lane.outbound.mtime)}`)) {
      sound('relay');
      notifyMac(headline, detail);
    }
    if (cfg('toast', true)) {
      const actions = tab ? ['Go to tab', 'Open outbound.md'] : ['Open outbound.md'];
      void vscode.window.showInformationMessage(`${headline}: ${detail}`, ...actions).then(async (choice) => {
        if (choice === 'Go to tab' && tab) {
          await tabs.activate(tab);
          await tabs.focusClaudeInput();
        } else if (choice) {
          await openLane(lane.n);
        }
      });
    }
    if (tab) void pinTab(tab);
    updateStatus();
  });
  relay.onDidChange(() => updateStatus());

  context.subscriptions.push(
    log,
    relay,
    tree,
    status,
    vscode.window.tabGroups.onDidChangeTabs((ev) => {
      for (const tab of ev.closed) {
        for (const s of registry.sessions.values()) if (s.tab === tab) s.tab = undefined;
        if (!tabs.findByLabel(tab.label)) {
          pinnedByUs.delete(tab.label);
          pendingPins.delete(tab.label);
        }
      }
      for (const tab of ev.changed) {
        for (const s of registry.sessions.values()) if (s.tab === tab) s.tabLabel = tab.label;
      }
      onTabsChanged();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => onTabsChanged()),
    vscode.commands.registerCommand('claudeTabQueue.showQueue', () => vscode.commands.executeCommand('claudeTabQueue.queue.focus')),
    vscode.commands.registerCommand('claudeTabQueue.goToSession', (id: string) => goToSession(id)),
    vscode.commands.registerCommand('claudeTabQueue.openLane', (n: number) => openLane(n)),
    vscode.commands.registerCommand('claudeTabQueue.openLog', () => log.show()),
    vscode.commands.registerCommand('claudeTabQueue.refresh', () => {
      seed();
      reconcile();
    }),
    vscode.commands.registerCommand('claudeTabQueue.clear', () => {
      for (const s of registry.sessions.values()) if (s.state === 'ready') s.seenAt ??= Date.now();
      for (const lane of relay.lanes) relay.markSeen(lane.n);
      pendingPins.clear();
      updateStatus();
    }),
    vscode.commands.registerCommand('claudeTabQueue.installHooks', () => {
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
    }),
  );

  const spool = new EventSpool(EVENTS_DIR, handle, log);
  spool.start();
  context.subscriptions.push({ dispose: () => spool.dispose() });

  const timers = [
    setInterval(() => cleanupClaims(), 10 * 60_000),
    setInterval(() => reconcile(), 2 * 60_000),
    setInterval(() => view.refresh(), 30_000),
  ];
  context.subscriptions.push({ dispose: () => timers.forEach(clearInterval) });

  if (cfg('pinnedRow', true) && !context.globalState.get<boolean>('pinnedRowApplied')) {
    vscode.workspace
      .getConfiguration('workbench.editor')
      .update('pinnedTabsOnSeparateRow', true, vscode.ConfigurationTarget.Global)
      .then(
        () => context.globalState.update('pinnedRowApplied', true),
        (err) => log.warn(`could not enable pinnedTabsOnSeparateRow: ${err}`),
      );
  }

  if (!hooksInstalled()) {
    void vscode.window
      .showInformationMessage('Claude Tab Queue needs its Claude Code hooks installed to see sessions.', 'Install hooks')
      .then((choice) => {
        if (choice) void vscode.commands.executeCommand('claudeTabQueue.installHooks');
      });
  }

  seed();
  updateStatus();
  log.info(`activated; roots=${roots().join(', ')}; claude tabs=${tabs.claudeTabs().map((t) => `"${t.label}"`).join(', ') || 'none'}`);
}

export function deactivate(): void {}
