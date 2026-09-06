import * as fs from 'fs/promises';

const MAX_READ = 16 * 1024 * 1024;

export interface Titles {
  ai?: string;
  custom?: string;
}

// The Claude Code CLI appends {"type":"ai-title","aiTitle":"..."} lines to the session
// transcript and rewrites them as the conversation moves; a rename appends
// {"type":"custom-title","customTitle":"..."}. The tab shows the custom title whenever
// one exists, however old, so both are read and the caller lets custom win.
export async function readTitles(transcriptPath: string): Promise<Titles> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(transcriptPath, 'r');
  } catch {
    return {};
  }
  try {
    const { size } = await fh.stat();
    for (const chunk of [256 * 1024, 4 * 1024 * 1024, MAX_READ]) {
      const len = Math.min(chunk, size);
      if (len <= 0) return {};
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const titles = lastTitles(buf.toString('utf8'));
      if (titles.ai || titles.custom || len >= size) return titles;
    }
  } finally {
    await fh.close();
  }
  return {};
}

export async function readSessionTitle(transcriptPath: string): Promise<string | undefined> {
  const { ai, custom } = await readTitles(transcriptPath);
  return custom ?? ai;
}

function lastTitles(text: string): Titles {
  return { custom: lastOf(text, '"type":"custom-title"'), ai: lastOf(text, '"type":"ai-title"') };
}

function lastOf(text: string, key: string): string | undefined {
  let idx = text.lastIndexOf(key);
  while (idx >= 0) {
    const start = text.lastIndexOf('\n', idx) + 1;
    const end = text.indexOf('\n', idx);
    try {
      const obj = JSON.parse(text.slice(start, end < 0 ? undefined : end));
      const t = obj.customTitle ?? obj.aiTitle ?? obj.title;
      if (typeof t === 'string' && t.trim()) return t.trim();
    } catch {
      // partial line at the chunk boundary; keep looking backwards
    }
    idx = idx > 0 ? text.lastIndexOf(key, idx - 1) : -1;
  }
  return undefined;
}
