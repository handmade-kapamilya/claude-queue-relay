import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Log } from './log';
import { labelMatches } from './tabs';

export interface LaneFile {
  path: string;
  exists: boolean;
  mtime: number;
  fields: Record<string, string>;
}

export type TaskRole = 'result' | 'current' | 'queued';

export interface LaneTask {
  role: TaskRole;
  file: string;
  taskId?: string;
  taskName?: string;
  status: string;
  returnTo?: string;
  position?: number;
}

// Lane lifecycle (lane CLAUDE.md): READY → RUNNING → COMPLETE | PARTIAL | BLOCKED → CONSUMED.
export type LaneStage = 'empty' | 'queued' | 'ready' | 'running' | 'complete' | 'partial' | 'blocked' | 'abandoned';

export interface Lane {
  n: number;
  dir: string;
  outbound: LaneFile;
  inbound: LaneFile;
  queue: LaneTask[];
  result?: LaneTask;
  current?: LaneTask;
  stage: LaneStage;
  landedAt?: number;
  seen: boolean;
  lastLandedKey?: string;
}

export interface Look {
  description: string;
  icon: string;
  color?: string;
}

const FIELD = /^\s*[-*]?\s*\**([A-Z][A-Z_-]+)\**\s*:\s*(.+?)\s*$/;
const RESULT_STAGES: Record<string, LaneStage> = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  BLOCKED: 'blocked',
  ABANDONED: 'abandoned',
  CANCELLED: 'abandoned',
  FAILED: 'abandoned',
};

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
function statusWord(f: LaneFile): string {
  return (f.fields.STATUS ?? '').trim().toUpperCase().split(/\s+/)[0] ?? '';
}

// RETURN-TO carries the VS Code thread name the task came from, e.g. «Evaluate 5X Dashboard».
function cleanReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[«»"']/g, '').trim();
  return cleaned || undefined;
}

function toTask(role: TaskRole, f: LaneFile, position?: number): LaneTask {
  return {
    role,
    file: f.path,
    taskId: f.fields.TASK_ID,
    taskName: f.fields.TASK_NAME,
    status: statusWord(f),
    returnTo: cleanReturnTo(f.fields['RETURN-TO']),
    position,
  };
}

export function laneTaskLabel(t: LaneTask): string {
  return t.taskName ?? t.taskId ?? path.basename(t.file);
}

// Only bare .md files are live queue entries; drain.sh leaves .done/.promoted behind.
function readQueue(relayDir: string): LaneTask[] {
  const q = path.join(relayDir, 'queue');
  let names: string[];
  try {
    names = fs.readdirSync(q).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return names.map((n, i) => toTask('queued', readLaneFile(path.join(q, n)), i + 1));
}

function compute(lane: Lane): void {
  const inb = lane.inbound;
  const out = lane.outbound;
  const inStatus = statusWord(inb);
  const inActive = inb.exists && (inStatus === 'READY' || inStatus === 'RUNNING');
  const outStage = out.exists ? RESULT_STAGES[statusWord(out)] : undefined;
  lane.result = outStage ? toTask('result', out) : undefined;
  lane.current = inActive ? toTask('current', inb) : undefined;
  const newerTask = inActive && inb.fields.TASK_ID !== out.fields.TASK_ID;
  if (inActive && (newerTask || !outStage)) lane.stage = inStatus === 'RUNNING' ? 'running' : 'ready';
  else if (outStage) lane.stage = outStage;
  else if (lane.queue.length) lane.stage = 'queued';
  else lane.stage = 'empty';
}

export function laneIsResult(lane: Lane): boolean {
  return lane.stage === 'complete' || lane.stage === 'partial' || lane.stage === 'blocked' || lane.stage === 'abandoned';
}

function landedKey(lane: Lane): string | undefined {
  if (!lane.result || !laneIsResult(lane)) return undefined;
  return `${lane.result.taskId ?? ''}|${lane.result.status}`;
}

const STAGE_LOOK: Record<LaneStage, [string, string?]> = {
  empty: ['circle-outline'],
  queued: ['clock'],
  ready: ['clock', 'charts.blue'],
  running: ['sync~spin', 'charts.blue'],
  complete: ['check', 'charts.green'],
  partial: ['warning', 'charts.orange'],
  blocked: ['warning', 'charts.yellow'],
  abandoned: ['error', 'charts.red'],
};

export function laneLook(lane: Lane): Look {
  const [icon, color] = STAGE_LOOK[lane.stage];
  const muted = lane.stage === 'complete' && lane.seen;
  return { description: laneDescription(lane), icon, color: muted ? undefined : color };
}

function laneDescription(lane: Lane): string {
  const queued = lane.queue.length ? ` · ${lane.queue.length} queued` : '';
  const say = `say "check relay ${lane.n}"`;
  const name = laneIsResult(lane) && lane.result ? laneTaskLabel(lane.result) : lane.current ? laneTaskLabel(lane.current) : '';
  switch (lane.stage) {
    case 'running':
      return `in flight: ${name}${queued}`;
    case 'ready':
      return `waiting for Cowork to start: ${name}${queued}`;
    case 'complete':
      return `landed COMPLETE: ${name} · ${say}${queued}`;
    case 'partial':
      return `landed PARTIAL: ${name} · ${say}${queued}`;
    case 'blocked':
      return `BLOCKED, needs you: ${name} · ${say}${queued}`;
    case 'abandoned':
      return `${lane.result?.status.toLowerCase() ?? 'abandoned'}: ${name}${queued}`;
    case 'queued':
      return `${lane.queue.length} queued, nothing in flight`;
    default:
      return 'empty';
  }
}

function taskStage(task: LaneTask): LaneStage {
  if (task.role === 'queued') return 'queued';
  if (task.role === 'current') return task.status === 'RUNNING' ? 'running' : 'ready';
  return RESULT_STAGES[task.status] ?? 'empty';
}

export function taskLook(task: LaneTask): Look {
  const [icon, color] = STAGE_LOOK[taskStage(task)];
  const to = task.returnTo ? ` → «${task.returnTo}»` : '';
  const description = task.role === 'queued' ? `queued #${task.position}${to}` : `${task.status}${to}`;
  return { description, icon, color };
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
        queue: readQueue(relay),
        stage: 'empty',
        seen: true,
      };
      compute(lane);
      lane.lastLandedKey = landedKey(lane);
      this.lanes.push(lane);
      for (const d of [relay, path.join(relay, 'queue')]) {
        try {
          const w = fs.watch(d, () => this.schedule(lane));
          w.on('error', () => {});
          this.watchers.push(w);
        } catch (err) {
          log.warn(`relay lane ${lane.n}: cannot watch ${d}: ${err}`);
        }
      }
    });
  }

  // Lanes with a task in flight or queued whose RETURN-TO names one of these tab labels / titles.
  lanesFor(labels: Array<string | undefined>): number[] {
    const names = labels.filter((l): l is string => !!l);
    const out: number[] = [];
    for (const lane of this.lanes) {
      const tasks = [...lane.queue];
      if (lane.current) tasks.push(lane.current);
      const hit = tasks.some((t) => !!t.returnTo && names.some((l) => l === t.returnTo || labelMatches(l, t.returnTo!)));
      if (hit) out.push(lane.n);
    }
    return out;
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
    lane.outbound = readLaneFile(path.join(relay, 'outbound.md'));
    lane.inbound = readLaneFile(path.join(relay, 'inbound.md'));
    lane.queue = readQueue(relay);
    compute(lane);
    const key = landedKey(lane);
    // outbound.md is written twice within seconds; only a new task/status counts as a landing
    if (key && key !== lane.lastLandedKey) {
      lane.lastLandedKey = key;
      lane.landedAt = Date.now();
      lane.seen = false;
      this.landed.fire(lane);
    } else if (!key) {
      lane.lastLandedKey = undefined;
    }
    this.changed.fire(lane);
  }
}

export function taskNameIn(file: string): string | undefined {
  const f = readLaneFile(file);
  return f.exists ? (f.fields.TASK_NAME ?? f.fields.TASK_ID) : undefined;
}
