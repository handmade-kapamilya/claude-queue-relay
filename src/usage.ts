import { execFile } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { BASE_DIR } from './hooks';

export interface Meter {
  label: string;
  percent: number;
  resetsAt?: number;
  severity: string;
}

export interface Usage {
  meters: Meter[];
  spend?: string;
  fetchedAt: number;
  error?: string;
}

const CACHE = path.join(BASE_DIR, 'usage.json');
const TTL = 5 * 60_000;

// Same call the CLI's /usage makes, with the OAuth token Claude Code keeps in the Keychain.
export async function currentUsage(): Promise<Usage> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL) return cached;
  try {
    const usage = parse(await fetchUsage(await token()));
    fs.writeFileSync(CACHE, JSON.stringify(usage));
    return usage;
  } catch (err) {
    return { meters: cached?.meters ?? [], spend: cached?.spend, fetchedAt: Date.now(), error: String(err) };
  }
}

export function resetsIn(at: number | undefined): string | undefined {
  if (!at) return undefined;
  const hours = Math.max(0, Math.floor((at - Date.now()) / 3_600_000));
  if (hours < 1) return 'under 1h';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function readCache(): Usage | undefined {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Usage;
  } catch {
    return undefined;
  }
}

function token(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, out) => {
      if (err) return reject(new Error('no Claude Code login in Keychain'));
      try {
        const t = JSON.parse(out.trim()).claudeAiOauth?.accessToken;
        t ? resolve(t) : reject(new Error('Keychain entry has no OAuth token'));
      } catch {
        reject(new Error('unreadable Keychain entry'));
      }
    });
  });
}

function fetchUsage(bearer: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://api.anthropic.com/api/oauth/usage',
      { headers: { Authorization: `Bearer ${bearer}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-tab-queue' }, timeout: 15_000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('unreadable usage response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Response carries a limits[] list (session = 5h, weekly_all = 7d, weekly_scoped = one model) plus
// legacy five_hour / seven_day blocks; either shape becomes a Meter.
function parse(raw: any): Usage {
  const meters: Meter[] = [];
  const limits: any[] = Array.isArray(raw.limits) ? raw.limits : [];
  const meter = (label: string, l: any): Meter => ({
    label,
    percent: Number(l.percent ?? l.utilization ?? 0),
    resetsAt: l.resets_at ? Date.parse(l.resets_at) : undefined,
    severity: l.severity ?? 'normal',
  });
  const session = limits.find((l) => l.kind === 'session') ?? raw.five_hour;
  const weekly = limits.find((l) => l.kind === 'weekly_all') ?? raw.seven_day;
  if (session) meters.push(meter('5h', session));
  if (weekly) meters.push(meter('7d', weekly));
  for (const l of limits.filter((l) => l.kind === 'weekly_scoped')) meters.push(meter(l.scope?.model?.display_name ?? 'model', l));
  const spend = raw.spend?.used?.amount_minor;
  const cap = raw.spend?.limit?.amount_minor;
  return {
    meters,
    spend: typeof spend === 'number' && cap ? `$${(spend / 100).toFixed(2)} of $${(cap / 100).toFixed(0)} credits` : undefined,
    fetchedAt: Date.now(),
  };
}
