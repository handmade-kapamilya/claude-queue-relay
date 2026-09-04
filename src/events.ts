import * as fs from 'fs';
import * as path from 'path';
import { Log } from './log';

export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  transcript_path?: string;
  prompt_id?: string;
  tool_name?: string;
  notification_type?: string;
  last_assistant_message?: string;
  user_prompt?: string;
  agent_id?: string;
  reason?: string;
  error?: string;
  file: string;
  at: number;
}

interface SpoolFile {
  name: string;
  mtime: number;
}

// Hook scripts drop one JSON file per event into a spool directory; every VS Code
// window reads the same spool, so files are never deleted on read, only aged out.
export class EventSpool {
  private readonly processed = new Set<string>();
  private watcher?: fs.FSWatcher;
  private debounce?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private janitor?: NodeJS.Timeout;
  private scanning = false;
  private rescan = false;

  constructor(
    private readonly dir: string,
    private readonly onEvent: (e: HookEvent) => void,
    private readonly log: Log,
    private readonly lookbackMs = 120_000,
  ) {}

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const cutoff = Date.now() - this.lookbackMs;
    for (const f of this.list()) {
      if (f.mtime < cutoff) this.processed.add(f.name);
    }
    try {
      this.watcher = fs.watch(this.dir, () => this.schedule());
      this.watcher.on('error', (err) => this.log.warn(`spool watcher error: ${err}`));
    } catch (err) {
      this.log.warn(`fs.watch unavailable, polling only: ${err}`);
    }
    this.poll = setInterval(() => this.scan(), 2000);
    this.janitor = setInterval(() => this.cleanup(), 5 * 60_000);
    this.scan();
  }

  dispose(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    clearInterval(this.janitor);
  }

  private schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan(), 40);
  }

  private list(): SpoolFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SpoolFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push({ name, mtime: fs.statSync(path.join(this.dir, name)).mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
    return out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  }

  private scan(): void {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    try {
      for (const f of this.list()) {
        if (this.processed.has(f.name)) continue;
        let raw: string;
        try {
          raw = fs.readFileSync(path.join(this.dir, f.name), 'utf8');
        } catch {
          continue;
        }
        let parsed: Partial<HookEvent>;
        try {
          parsed = JSON.parse(raw);
        } catch {
          if (Date.now() - f.mtime < 3000) continue;
          this.processed.add(f.name);
          this.log.warn(`unparseable event file ${f.name}`);
          continue;
        }
        this.processed.add(f.name);
        if (!parsed.hook_event_name || !parsed.session_id || !parsed.cwd) continue;
        try {
          this.onEvent({ ...(parsed as HookEvent), file: f.name, at: f.mtime });
        } catch (err) {
          this.log.warn(`handler threw on ${f.name}: ${err}`);
        }
      }
    } finally {
      this.scanning = false;
      if (this.rescan) {
        this.rescan = false;
        this.schedule();
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const live = new Set(names);
    for (const name of names) {
      const p = path.join(this.dir, name);
      try {
        const age = now - fs.statSync(p).mtimeMs;
        if ((name.endsWith('.json') && age > 15 * 60_000) || (name.endsWith('.tmp') && age > 60_000)) {
          fs.unlinkSync(p);
        }
      } catch {
        // another window got there first
      }
    }
    for (const name of this.processed) {
      if (!live.has(name)) this.processed.delete(name);
    }
  }
}
