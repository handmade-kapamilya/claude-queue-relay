import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Log } from './log';

export interface LaneFile {
  path: string;
  exists: boolean;
  mtime: number;
  fields: Record<string, string>;
}

export interface Lane {
  n: number;
  dir: string;
  outbound: LaneFile;
  inbound: LaneFile;
  landedAt?: number;
  seen: boolean;
}

const FIELD = /^\s*[-*]?\s*\**([A-Z][A-Z_-]+)\**\s*:\s*(.+?)\s*$/;

function readLaneFile(p: string): LaneFile {
  try {
    const st = fs.statSync(p);
    const text = fs.readFileSync(p, 'utf8');
    const fields: Record<string, string> = {};
    for (const line of text.split('\n').slice(0, 40)) {
      const m = FIELD.exec(line);
      if (m && !(m[1] in fields)) fields[m[1]] = m[2];
    }
    return { path: p, exists: true, mtime: st.mtimeMs, fields };
  } catch {
    return { path: p, exists: false, mtime: 0, fields: {} };
  }
}

// STATUS lines look like "COMPLETE   (invited/pending ...)"; only the first word is the state.
function status(f: LaneFile): string {
  return (f.fields.STATUS ?? '').trim().toUpperCase().split(/\s+/)[0] ?? '';
}

export function laneLanded(lane: Lane): boolean {
  const s = status(lane.outbound);
  return lane.outbound.exists && !!s && s !== 'EMPTY';
}

export function laneTaskName(f: LaneFile): string | undefined {
  return f.fields.TASK_NAME ?? f.fields.TASK_ID;
}

// RETURN-TO carries the VS Code thread name the task came from, e.g. «Evaluate 5X Dashboard».
export function laneReturnTo(f: LaneFile): string | undefined {
  const raw = f.fields['RETURN-TO'];
  if (!raw) return undefined;
  const cleaned = raw.replace(/[«»"']/g, '').trim();
  return cleaned || undefined;
}

export interface LaneSummary {
  description: string;
  tooltip: string;
  icon: string;
  color?: string;
  file: string;
}

export function laneSummary(lane: Lane): LaneSummary {
  const out = lane.outbound;
  const inb = lane.inbound;
  if (laneLanded(lane) && !lane.seen) {
    return {
      description: `landed: ${laneTaskName(out) ?? status(out)} · say "check relay ${lane.n}"`,
      tooltip: out.path,
      icon: 'inbox',
      color: 'charts.green',
      file: out.path,
    };
  }
  const inName = laneTaskName(inb);
  if (inb.exists && inName && status(inb) !== 'EMPTY') {
    return { description: `in flight: ${inName}`, tooltip: inb.path, icon: 'sync', color: 'charts.blue', file: inb.path };
  }
  if (laneLanded(lane)) {
    return {
      description: `${status(out).toLowerCase()}: ${laneTaskName(out) ?? ''} (seen)`,
      tooltip: out.path,
      icon: 'inbox',
      file: out.path,
    };
  }
  return { description: 'empty', tooltip: lane.dir, icon: 'circle-outline', file: out.path };
}

export class RelayWatcher implements vscode.Disposable {
  readonly lanes: Lane[] = [];
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly changed = new vscode.EventEmitter<Lane | undefined>();
  private readonly landed = new vscode.EventEmitter<Lane>();
  readonly onDidChange = this.changed.event;
  readonly onDidLand = this.landed.event;

  constructor(dirs: string[], log: Log) {
    dirs.forEach((dir, i) => {
      const relay = path.join(dir, 'relay');
      const lane: Lane = {
        n: i + 1,
        dir,
        outbound: readLaneFile(path.join(relay, 'outbound.md')),
        inbound: readLaneFile(path.join(relay, 'inbound.md')),
        seen: true,
      };
      this.lanes.push(lane);
      try {
        const w = fs.watch(relay, () => this.schedule(lane));
        w.on('error', () => {});
        this.watchers.push(w);
      } catch (err) {
        log.warn(`relay lane ${lane.n}: cannot watch ${relay}: ${err}`);
      }
    });
  }

  markSeen(n: number): void {
    const lane = this.lanes.find((l) => l.n === n);
    if (lane) {
      lane.seen = true;
      this.changed.fire(lane);
    }
  }

  dispose(): void {
    for (const w of this.watchers) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.changed.dispose();
    this.landed.dispose();
  }

  private schedule(lane: Lane): void {
    clearTimeout(this.timers.get(lane.n));
    this.timers.set(lane.n, setTimeout(() => this.refresh(lane), 300));
  }

  private refresh(lane: Lane): void {
    const relay = path.join(lane.dir, 'relay');
    const prev = lane.outbound;
    lane.outbound = readLaneFile(path.join(relay, 'outbound.md'));
    lane.inbound = readLaneFile(path.join(relay, 'inbound.md'));
    const changed = lane.outbound.mtime !== prev.mtime || lane.outbound.fields.TASK_ID !== prev.fields.TASK_ID;
    if (changed && laneLanded(lane)) {
      lane.landedAt = Date.now();
      lane.seen = false;
      this.landed.fire(lane);
    }
    this.changed.fire(lane);
  }
}
