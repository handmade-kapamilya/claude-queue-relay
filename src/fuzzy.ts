const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'tab', 'fix', 'check', 'task', 'relay', 'lane', 'new', 'update', 'via', 'your', 'our']);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[«»"'…]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

function overlap(want: Set<string>, text: string): number {
  return [...tokens(text)].filter((w) => [...want].some((t) => t.startsWith(w) || w.startsWith(t))).length;
}

// A RETURN-TO name is often Claude's guess at its own tab title. Pick the one tab that shares at
// least two meaningful words with it, and only when no other tab comes close. A tab may be
// offered under several names (shortened label, full title); it is scored once, by its best name.
export function fuzzyPickKey(wanted: string, items: Array<{ key: string; text: string }>): string | undefined {
  const want = tokens(wanted);
  if (want.size < 2) return undefined;
  const best = new Map<string, number>();
  for (const { key, text } of items) best.set(key, Math.max(best.get(key) ?? 0, overlap(want, text)));
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (!top || top[1] < 2) return undefined;
  if (next && next[1] === top[1]) return undefined;
  return top[0];
}

export function fuzzyPick(wanted: string, candidates: string[]): string | undefined {
  return fuzzyPickKey(wanted, candidates.map((c) => ({ key: c, text: c })));
}
