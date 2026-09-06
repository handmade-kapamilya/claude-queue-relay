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

// A RETURN-TO name is often Claude's guess at its own tab title; pick the one tab that shares
// at least two meaningful words with it, and only when no other tab comes close.
export function fuzzyPick(wanted: string, candidates: string[]): string | undefined {
  const want = tokens(wanted);
  if (want.size < 2) return undefined;
  const scored = candidates
    .map((c) => ({ c, score: [...tokens(c)].filter((w) => [...want].some((t) => t.startsWith(w) || w.startsWith(t))).length }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < 2) return undefined;
  if (next && next.score === best.score) return undefined;
  return best.c;
}
