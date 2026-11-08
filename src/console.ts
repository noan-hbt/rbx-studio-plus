// Output log helpers: incremental reads and formatting.

export interface ConsoleEntry { m: string; t: string; ts: number }
export interface ConsoleCursor { n: number; key?: string }

const key = (e: ConsoleEntry) => `${e.ts}\u0000${e.t}\u0000${e.m}`;

/** Return entries after the cursor. The history is a capped ring, so re-locate the last seen entry by content. */
export function diffConsole(hist: ConsoleEntry[], cur?: ConsoleCursor): { entries: ConsoleEntry[]; cursor: ConsoleCursor } {
  const next: ConsoleCursor = { n: hist.length, key: hist.length ? key(hist[hist.length - 1]) : undefined };
  if (!cur || !cur.key) return { entries: cur ? hist : hist, cursor: next };
  let start = -1;
  if (cur.n <= hist.length && cur.n > 0 && key(hist[cur.n - 1]) === cur.key) start = cur.n;
  else for (let i = hist.length - 1; i >= 0; i--) if (key(hist[i]) === cur.key) { start = i + 1; break; }
  return { entries: start === -1 ? hist : hist.slice(start), cursor: next };
}

// Studio plugin scripts are named cloud_<assetId>… / user_<file>… / builtin_…; their stack frames follow the error as [i] lines.
const PLUGIN_FRAME = /Script '(cloud_\d+|user_|builtin_|sabuiltin_)/;
const PLUGIN_MSG = /^(le )?plugin\b|\bplugin\b.*\bpermission\b/i;

/** Entries caused by installed Studio plugins (not the game): the error/warning plus its stack lines. */
export function pluginNoise(entries: ConsoleEntry[]): Set<ConsoleEntry> {
  const out = new Set<ConsoleEntry>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.t !== "MessageError" && e.t !== "MessageWarning") continue;
    // Collect the stack block that follows ("Stack Begin" … "Stack End").
    const stack: ConsoleEntry[] = [];
    let j = i + 1;
    if (entries[j]?.t === "MessageInfo" && /^Stack Begin/.test(entries[j].m)) {
      for (; j < entries.length && entries[j].t === "MessageInfo"; j++) { stack.push(entries[j]); if (/^Stack End/.test(entries[j].m)) break; }
    }
    const frames = stack.filter((s) => /^Script '/.test(s.m));
    const fromPlugin = PLUGIN_MSG.test(e.m) || PLUGIN_FRAME.test(e.m) || (frames.length > 0 && frames.every((s) => PLUGIN_FRAME.test(s.m)));
    if (fromPlugin) { out.add(e); stack.forEach((s) => out.add(s)); }
  }
  return out;
}

const TAG: Record<string, string> = { MessageError: "[E] ", MessageWarning: "[W] ", MessageInfo: "[i] ", MessageOutput: "" };
const RANK: Record<string, number> = { MessageOutput: 0, MessageInfo: 0, MessageWarning: 1, MessageError: 2 };

export function formatConsole(entries: ConsoleEntry[], o: { level?: string; filter?: string; tail?: number } = {}): string {
  const min = o.level === "error" ? 2 : o.level === "warn" ? 1 : 0;
  let re: RegExp | undefined;
  if (o.filter) {
    const m = o.filter.match(/^\/(.*)\/([a-z]*)$/);
    re = m ? new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i") : new RegExp(o.filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  let list = entries.filter((e) => (RANK[e.t] ?? 0) >= min && (!re || re.test(e.m)));
  const tail = o.tail ?? 200;
  const dropped = Math.max(0, list.length - tail);
  if (dropped) list = list.slice(-tail);
  const body = list.map((e) => (TAG[e.t] ?? "") + e.m).join("\n");
  return (dropped ? `… ${dropped} earlier line(s) omitted\n` : "") + body;
}
