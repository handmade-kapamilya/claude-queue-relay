import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SESSIONS = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');

interface CoworkSession {
  sessionId: string;
  title?: string;
  isArchived?: boolean;
  lastActivityAt?: number;
}

// Cowork keeps one JSON per session two folders deep (org/user); lane sessions are titled "🔌 HK-RELAY-N".
export function coworkSessionFor(n: number): string | undefined {
  const wanted = new RegExp(`HK-RELAY-${n}(?!\\d)`);
  const hits: CoworkSession[] = [];
  for (const file of sessionFiles()) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8')) as CoworkSession;
      if (s.sessionId && !s.isArchived && wanted.test(s.title ?? '')) hits.push(s);
    } catch {
      // half-written; skip
    }
  }
  hits.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return hits[0]?.sessionId;
}

function sessionFiles(): string[] {
  const dirs = (p: string): string[] => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
    } catch {
      return [];
    }
  };
  const files: string[] = [];
  for (const org of dirs(SESSIONS)) {
    for (const user of dirs(org)) {
      try {
        for (const f of fs.readdirSync(user)) if (f.startsWith('local_') && f.endsWith('.json')) files.push(path.join(user, f));
      } catch {
        // unreadable user dir
      }
    }
  }
  return files;
}

// Undocumented but verified 2026-09-04: the app routes claude://claude.ai/cowork/<id> to that session and focuses it.
export function openCowork(n: number): boolean {
  const id = coworkSessionFor(n);
  execFile('open', id ? [`claude://claude.ai/cowork/${id}`] : ['-a', 'Claude'], () => {});
  return !!id;
}
