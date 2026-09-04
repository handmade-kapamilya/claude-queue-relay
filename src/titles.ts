import * as fs from 'fs/promises';

const MAX_READ = 16 * 1024 * 1024;

// The Claude Code CLI appends {"type":"ai-title","aiTitle":"..."} lines to the
// session transcript; the VS Code extension uses that text as the tab label.
export async function readSessionTitle(transcriptPath: string): Promise<string | undefined> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(transcriptPath, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await fh.stat();
    for (const chunk of [256 * 1024, 4 * 1024 * 1024, MAX_READ]) {
      const len = Math.min(chunk, size);
      if (len <= 0) return undefined;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const title = lastTitle(buf.toString('utf8'));
      if (title) return title;
      if (len >= size) return undefined;
    }
  } finally {
    await fh.close();
  }
  return undefined;
}

function lastTitle(text: string): string | undefined {
  let best: { idx: number; title: string } | undefined;
  for (const key of ['"type":"custom-title"', '"type":"ai-title"']) {
    let idx = text.lastIndexOf(key);
    while (idx >= 0) {
      const start = text.lastIndexOf('\n', idx) + 1;
      const end = text.indexOf('\n', idx);
      const line = text.slice(start, end < 0 ? undefined : end);
      try {
        const obj = JSON.parse(line);
        const t = obj.customTitle ?? obj.aiTitle ?? obj.title;
        if (typeof t === 'string' && t.trim()) {
          if (!best || idx > best.idx) best = { idx, title: t.trim() };
          break;
        }
      } catch {
        // partial line at the chunk boundary; keep looking backwards
      }
      idx = idx > 0 ? text.lastIndexOf(key, idx - 1) : -1;
    }
  }
  return best?.title;
}
