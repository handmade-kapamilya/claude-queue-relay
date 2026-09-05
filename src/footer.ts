export type SignalKind = 'done' | 'needs-you' | 'money' | 'background' | 'lane' | 'file' | 'failed';

export interface Signal {
  emoji: string;
  kind: SignalKind;
  label: string;
  action?: string;
  lane?: number;
}

// Alex's sessions end every message with a status footer (hk-ops CLAUDE.md):
// ❌ failed · 💸 money gate · ⚠️ needs Alex · 1️⃣2️⃣3️⃣ awaiting a relay lane · 📂 file · ⏳ background · 🤙 done.
const GATES: Array<[string, SignalKind, string]> = [
  ['❌', 'failed', 'failed, needs you'],
  ['💸', 'money', 'money / irreversible gate'],
  ['⚠', 'needs-you', 'needs you'],
];
const REST: Array<[string, SignalKind, string]> = [
  ['📂', 'file', 'file waiting for you'],
  ['⏳', 'background', 'still running in background'],
  ['🤙', 'done', 'done, close tab'],
];
const LANE_LINE = /([1-5])️?⃣[^\n]*?Lane (\d)(?: \(([^)]+)\))?/;
const NUMERAL = /([1-5])️?⃣/g;

export function classifyFooter(message: string | undefined): Signal | undefined {
  const lines = footerLines(message);
  if (!lines.length) return undefined;
  for (const [emoji, kind, label] of GATES) {
    const line = lines.find((l) => l.includes(emoji));
    if (line) return { emoji: emoji === '⚠' ? '⚠️' : emoji, kind, label, action: actionOn(line, emoji) };
  }
  const laneLine = lines.map((l) => LANE_LINE.exec(l)).find(Boolean);
  if (laneLine) {
    const n = Number(laneLine[2]);
    return { emoji: `${n}️⃣`, kind: 'lane', label: `awaiting relay lane ${n}`, lane: n, action: laneLine[3] };
  }
  const numeral = footerLanes(message)[0];
  if (numeral) return { emoji: `${numeral}️⃣`, kind: 'lane', label: `awaiting relay lane ${numeral}`, lane: numeral };
  for (const [emoji, kind, label] of REST) {
    const line = lines.find((l) => l.includes(emoji));
    if (line) return { emoji, kind, label, action: kind === 'file' ? actionOn(line, emoji) : undefined };
  }
  return undefined;
}

// Every relay-lane numeral in the footer, e.g. the sticky "1️⃣ Awaiting Lane 1 (…)" line.
export function footerLanes(message: string | undefined): number[] {
  const lanes = new Set<number>();
  for (const m of footerLines(message).join('\n').matchAll(NUMERAL)) lanes.add(Number(m[1]));
  return [...lanes].sort();
}

function footerLines(message: string | undefined): string[] {
  return message ? message.trim().split('\n').slice(-8) : [];
}

// The footer bolds the thing Alex has to do: "⚠️ **Paste the 2FA code** into …".
function actionOn(line: string, emoji: string): string | undefined {
  const bold = /\*\*(.+?)\*\*/.exec(line);
  const text = bold ? bold[1] : line.slice(line.indexOf(emoji) + emoji.length);
  const clean = text.replace(/[*_`️]/g, '').replace(/^[\s:—–-]+/, '').trim();
  return clean ? clean.slice(0, 60) : undefined;
}
