import * as vscode from 'vscode';
import { HookEvent } from './events';
import { Signal, classifyFooter, footerLanes } from './footer';

export type State = 'idle' | 'running' | 'ready' | 'waiting' | 'ended';

export interface Session {
  id: string;
  cwd: string;
  transcriptPath?: string;
  title?: string;
  state: State;
  since: number;
  reason?: string;
  signal?: Signal;
  lastMessage?: string;
  tab?: vscode.Tab;
  tabLabel?: string;
  seenAt?: number;
  lastEventAt: number;
  lanes: number[];
}

export interface Transition {
  session: Session;
  from: State;
  to: State;
  event: HookEvent;
}

const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

export class SessionRegistry {
  readonly sessions = new Map<string, Session>();
  private readonly emitter = new vscode.EventEmitter<Transition | undefined>();
  readonly onDidChange = this.emitter.event;

  ensure(id: string, cwd: string, at = Date.now()): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, cwd, state: 'idle', since: at, lastEventAt: at, lanes: [] };
      this.sessions.set(id, s);
    }
    return s;
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.emitter.fire(undefined);
  }

  apply(e: HookEvent): Transition {
    const s = this.ensure(e.session_id, e.cwd, e.at);
    s.lastEventAt = e.at;
    if (e.transcript_path) s.transcriptPath = e.transcript_path;
    const from = s.state;
    let to: State = from;
    let reason = s.reason;

    switch (e.hook_event_name) {
      case 'SessionStart':
        if (from === 'ended') to = 'idle';
        break;
      case 'UserPromptSubmit':
        to = 'running';
        reason = undefined;
        s.signal = undefined;
        break;
      case 'PreToolUse':
        if (e.tool_name === 'AskUserQuestion') {
          to = 'waiting';
          reason = 'asking you a question';
        } else if (e.tool_name === 'ExitPlanMode') {
          to = 'waiting';
          reason = 'plan ready for your review';
        }
        break;
      case 'PermissionRequest':
        to = 'waiting';
        reason = `needs permission: ${e.tool_name ?? 'tool'}`;
        break;
      case 'Notification':
        if (e.notification_type && WAITING_NOTIFICATIONS.has(e.notification_type) && from !== 'ready') {
          to = 'waiting';
          reason =
            e.notification_type === 'permission_prompt'
              ? 'needs permission'
              : e.notification_type === 'idle_prompt'
                ? 'waiting for your input'
                : 'needs your input';
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (from === 'waiting') {
          to = 'running';
          reason = undefined;
        }
        break;
      case 'Stop':
        to = 'ready';
        s.lastMessage = e.last_assistant_message;
        s.signal = classifyFooter(e.last_assistant_message);
        s.lanes = footerLanes(e.last_assistant_message);
        reason = s.signal?.label ?? 'finished';
        break;
      case 'StopFailure':
        to = 'ready';
        s.signal = { emoji: '❌', kind: 'failed', label: 'stopped on an API error' };
        reason = e.error ? `API error: ${e.error}` : 'stopped on an API error';
        break;
      case 'SessionEnd':
        to = 'ended';
        break;
    }

    if (to !== from) {
      s.state = to;
      s.since = e.at;
      if (to !== 'ready') s.seenAt = undefined;
    }
    s.reason = reason;
    const t: Transition = { session: s, from, to, event: e };
    this.emitter.fire(t);
    return t;
  }
}
