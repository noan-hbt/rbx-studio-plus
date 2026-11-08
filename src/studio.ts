// Studio session: automatic studio/datamodel selection, Luau execution with paging & uploads.
import { Upstream, ToolResult, textOf, UpstreamError } from "./upstream.js";
import { wrap, pageCode, uploadCode, jsonExpr, cleanError, longString } from "./luau.js";

export type DM = "Edit" | "Client" | "Server";
export interface StudioInfo { id: string; name: string }
export interface StudioState { mode: string; available: DM[]; focused?: string; raw: string }
export interface LuauResult { ok: boolean; ms: number; output: string[]; dropped: number; result?: unknown; error?: string }

export class LuauError extends Error {
  constructor(msg: string, public output: string[] = []) { super(msg); }
}

const CODE_INLINE_LIMIT = 150_000; // chars of data embedded directly in a call
const DMS: DM[] = ["Edit", "Client", "Server"];

export function parseState(raw: string): StudioState {
  const get = (k: string) => raw.match(new RegExp(`${k}:\\s*(.*)`, "i"))?.[1]?.trim() ?? "";
  const avail = get("Available DataModels").split(/[,\s]+/).map((x) => DMS.find((d) => d.toLowerCase() === x.toLowerCase())).filter(Boolean) as DM[];
  return { mode: get("Current Studio Mode") || "Unknown", available: avail, focused: get("Focused DataModel[^:]*") || undefined, raw };
}

export function normDM(s?: string): DM | undefined {
  if (!s) return undefined;
  const d = DMS.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!d) throw new UpstreamError(`Unknown context '${s}'. Use edit, client or server.`);
  return d;
}

export class Studio {
  selected?: string;
  private listCache?: { at: number; list: StudioInfo[] };
  private stateCache = new Map<string, { at: number; st: StudioState }>();

  constructor(public up: Upstream) {}

  async list(fresh = false): Promise<StudioInfo[]> {
    if (!fresh && this.listCache && Date.now() - this.listCache.at < 5000) return this.listCache.list;
    const r = await this.up.call("list_roblox_studios", {}, 20_000);
    const t = textOf(r);
    let list: StudioInfo[] = [];
    try { list = JSON.parse(t).studios ?? []; } catch { throw new UpstreamError(`Unexpected answer from list_roblox_studios: ${t.slice(0, 300)}`); }
    this.listCache = { at: Date.now(), list };
    return list;
  }

  /** Resolve which Studio to talk to. */
  async resolve(studio?: string): Promise<StudioInfo> {
    const list = await this.list();
    const fmt = () => list.map((s) => `  - ${s.name}  (id ${s.id})`).join("\n");
    if (!list.length) throw new UpstreamError("No Roblox Studio instance is connected. Open a place in Studio and make sure 'Enable Studio as MCP server' is on (Assistant → … → Manage MCP Servers).");
    const match = (q: string) => {
      const ql = q.toLowerCase();
      const byId = list.find((s) => s.id === q);
      if (byId) return [byId];
      return list.filter((s) => s.name.toLowerCase().includes(ql));
    };
    for (const q of [studio, process.env.RBX_STUDIO]) {
      if (!q) continue;
      const m = match(q);
      if (m.length === 1) return m[0];
      throw new UpstreamError(m.length ? `'${q}' matches several studios:\n${fmt()}\nBe more specific.` : `No open studio matches '${q}'. Open studios:\n${fmt()}`);
    }
    if (this.selected) {
      const s = list.find((x) => x.id === this.selected);
      if (s) return s;
      this.selected = undefined;
    }
    if (list.length === 1) return list[0];
    throw new UpstreamError(`Several Studio instances are open — call studio_select first (or pass 'studio'):\n${fmt()}`);
  }

  async state(studio?: string, fresh = false): Promise<StudioState> {
    const s = await this.resolve(studio);
    const c = this.stateCache.get(s.id);
    if (!fresh && c && Date.now() - c.at < 1000) return c.st;
    const st = parseState(textOf(await this.up.call("get_studio_state", { studio_id: s.id }, 20_000)));
    this.stateCache.set(s.id, { at: Date.now(), st });
    return st;
  }

  invalidate() { this.stateCache.clear(); }

  /** Pick a datamodel: requested one if available, else Edit > Server > Client. */
  async pickDM(studio?: string, want?: string): Promise<DM> {
    const st = await this.state(studio);
    const w = normDM(want);
    if (w) {
      if (st.available.includes(w) || !st.available.length) return w;
      throw new UpstreamError(`The ${w} datamodel is not available (Studio mode: ${st.mode}, available: ${st.available.join(", ") || "none"}). ${w === "Edit" ? "Stop the playtest first (play action=stop)." : "Start a playtest first (play action=start)."}`);
    }
    for (const d of ["Edit", "Server", "Client"] as DM[]) if (st.available.includes(d)) return d;
    return "Edit";
  }

  /** Call any upstream tool with studio_id injected. */
  async raw(tool: string, args: Record<string, unknown>, studio?: string, timeoutMs?: number): Promise<ToolResult> {
    const s = await this.resolve(studio);
    return this.up.call(tool, { ...args, studio_id: s.id }, timeoutMs);
  }

  private async exec(code: string, dm: DM, studio?: string, timeoutMs?: number): Promise<string> {
    const r = await this.raw("execute_luau", { code, datamodel_type: dm }, studio, timeoutMs);
    const t = textOf(r);
    if (r.isError || /^Error:/.test(t)) throw new LuauError(cleanError(t));
    return t;
  }

  /** Run code through the capture wrapper; returns the structured result (never throws on Luau runtime errors). */
  async luau(code: string, o: { studio?: string; context?: string; timeoutMs?: number; lib?: boolean } = {}): Promise<LuauResult & { dm: DM }> {
    const dm = await this.pickDM(o.studio, o.context);
    let text: string;
    try {
      text = await this.exec(wrap(code, { lib: o.lib }), dm, o.studio, o.timeoutMs);
    } catch (e) {
      // Studio only says "Failed to parse command code": ask loadstring for the real syntax error.
      if (e instanceof LuauError && /Failed to parse/i.test(e.message)) {
        const diag = await this.exec(`local f, e = loadstring(${longString(code.replace(/\r\n?/g, "\n"))}, "=code") return e or "syntax error"`, dm, o.studio).catch(() => "syntax error");
        return { ok: false, ms: 0, output: [], dropped: 0, error: `Syntax error: ${diag.replace(/^code:(\d+):/, "line $1:")}`, dm };
      }
      throw e;
    }
    const pm = text.match(/^@@PAGE (\S+) (\d+) (\d+)\n/);
    if (pm) {
      const [, id, totalS, endS] = pm;
      const total = Number(totalS);
      const parts = [text.slice(pm[0].length)];
      let next = Number(endS) + 1;
      while (next <= total) {
        const t = await this.exec(pageCode(id, next), dm, o.studio, o.timeoutMs);
        if (t === "@@GONE") throw new LuauError("Paged result expired before it was fully read.");
        const nl = t.indexOf("\n");
        parts.push(t.slice(nl + 1));
        next = Number(t.slice(0, nl)) + 1;
      }
      text = parts.join("");
      if (Buffer.byteLength(text, "utf8") !== total) throw new LuauError(`Paged result corrupted (${Buffer.byteLength(text, "utf8")}/${total} bytes).`);
    }
    let res: LuauResult;
    try { res = JSON.parse(text); } catch { return { ok: true, ms: 0, output: [], dropped: 0, result: text, dm }; }
    if (res.error) res.error = cleanError(res.error);
    return { ...res, output: res.output ?? [], dm };
  }

  /** Internal RPC: run library code with DATA available; throws on error, returns the result. */
  async rpc<T = any>(code: string, data?: unknown, o: { studio?: string; context?: string; timeoutMs?: number } = {}): Promise<T> {
    let header = "";
    if (data !== undefined) {
      const json = JSON.stringify(data);
      if (json.length <= CODE_INLINE_LIMIT) header = `local DATA = ${jsonExpr(data)}\n`;
      else {
        const dm = await this.pickDM(o.studio, o.context);
        const id = `u${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        let i = 0, first = true;
        while (i < json.length) {
          let j = Math.min(json.length, i + CODE_INLINE_LIMIT);
          const cc = json.charCodeAt(j - 1);
          if (j < json.length && cc >= 0xd800 && cc <= 0xdbff) j--; // never split a surrogate pair
          await this.exec(uploadCode(id, json.slice(i, j), first), dm, o.studio, o.timeoutMs);
          first = false; i = j;
        }
        header = `local DATA = __data(${JSON.stringify(id)})\n`;
      }
    }
    const r = await this.luau(header + code, { ...o, lib: true });
    if (!r.ok) throw new LuauError(r.error ?? "Luau error", r.output);
    return r.result as T;
  }
}
