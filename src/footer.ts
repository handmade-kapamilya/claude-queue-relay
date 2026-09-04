export type SignalKind = 'done' | 'needs-you' | 'money' | 'background' | 'lane' | 'file' | 'failed';

export interface Signal {
  emoji: string;
  kind: SignalKind;
  label: string;
  lane?: number;
}

// Alex's sessions end every message with a status footer (see hk-ops CLAUDE.md):
// 🤙 done · ⚠️ needs Alex · 💸 money gate · ⏳ background · 1️⃣2️⃣3️⃣ relay lane · 📂 file · ❌ failed.
export function classifyFooter(message: string | undefined): Signal | undefined {
  if (!message) return undefined;
  const tail = message.trim().split('\n').slice(-8).join('\n');
  if (tail.includes('❌')) return { emoji: '❌', kind: 'failed', label: 'failed, needs you' };
  if (tail.includes('💸')) return { emoji: '💸', kind: 'money', label: 'money / irreversible gate' };
  if (tail.includes('⚠')) return { emoji: '⚠️', kind: 'needs-you', label: 'needs you' };
  const lane = /([123])️?⃣/.exec(tail);
  if (lane) {
    const n = Number(lane[1]);
    return { emoji: `${n}️⃣`, kind: 'lane', label: `awaiting relay lane ${n}`, lane: n };
  }
  if (tail.includes('📂')) return { emoji: '📂', kind: 'file', label: 'file waiting for you' };
  if (tail.includes('⏳')) return { emoji: '⏳', kind: 'background', label: 'still running in background' };
  if (tail.includes('🤙')) return { emoji: '🤙', kind: 'done', label: 'done, close tab' };
  return undefined;
}

// Every relay-lane numeral in the footer, e.g. the sticky "1️⃣ Awaiting Lane 1 (…)" line.
export function footerLanes(message: string | undefined): number[] {
  if (!message) return [];
  const tail = message.trim().split('\n').slice(-8).join('\n');
  const lanes = new Set<number>();
  for (const m of tail.matchAll(/([1-5])️?⃣/g)) lanes.add(Number(m[1]));
  return [...lanes].sort();
}
