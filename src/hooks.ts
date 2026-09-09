import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = os.homedir();
export const BASE_DIR = path.join(HOME, '.claude-queue-relay');
export const EVENTS_DIR = path.join(BASE_DIR, 'events');
export const EMIT_PATH = path.join(BASE_DIR, 'emit.sh');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const COMMAND = '"$HOME/.claude-queue-relay/emit.sh"';
const MARKER = '.claude-queue-relay/emit.sh';

// Must stay silent: stdout from UserPromptSubmit is fed to Claude as context and
// stdout from PermissionRequest is parsed as a decision.
const EMIT_SH = `#!/bin/sh
# Spools one Claude Code hook event for the Claude Queue Relay VS Code extension.
d="$HOME/.claude-queue-relay/events"
mkdir -p "$d" 2>/dev/null || exit 0
f="$d/$(date +%s)-$$-$RANDOM"
cat > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f.json" 2>/dev/null
exit 0
`;

// [event, matcher]; undefined matcher = every occurrence
const EVENTS: Array<[string, string | undefined]> = [
  ['SessionStart', undefined],
  ['UserPromptSubmit', undefined],
  ['Stop', undefined],
  ['StopFailure', undefined],
  ['PermissionRequest', undefined],
  ['Notification', undefined],
  ['PreToolUse', 'AskUserQuestion|ExitPlanMode'],
  ['PostToolUse', undefined],
  ['PostToolUseFailure', undefined],
  ['SessionEnd', undefined],
];

export interface InstallResult {
  added: string[];
  alreadyPresent: string[];
  backup?: string;
  settingsPath: string;
  emitPath: string;
}

interface HookEntry {
  type: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

export function installHooks(): InstallResult {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  fs.writeFileSync(EMIT_PATH, EMIT_SH, { mode: 0o755 });
  fs.chmodSync(EMIT_PATH, 0o755);

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
  }
  const hooks = (settings.hooks ??= {}) as Record<string, HookGroup[]>;
  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const [event, matcher] of EVENTS) {
    const groups = (hooks[event] ??= []);
    const present = groups.some(
      (g) =>
        (g.matcher ?? undefined) === matcher &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER)),
    );
    if (present) {
      alreadyPresent.push(event);
      continue;
    }
    const group: HookGroup = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
    added.push(event);
  }

  let backup: string | undefined;
  if (added.length) {
    if (fs.existsSync(SETTINGS_PATH)) {
      const dir = path.join(HOME, '.claude', 'backups');
      fs.mkdirSync(dir, { recursive: true });
      backup = path.join(dir, `settings.json.tab-queue-${Date.now()}.bak`);
      fs.copyFileSync(SETTINGS_PATH, backup);
    }
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { added, alreadyPresent, backup, settingsPath: SETTINGS_PATH, emitPath: EMIT_PATH };
}

export function hooksInstalled(): boolean {
  try {
    return fs.readFileSync(SETTINGS_PATH, 'utf8').includes(MARKER) && fs.existsSync(EMIT_PATH);
  } catch {
    return false;
  }
}
