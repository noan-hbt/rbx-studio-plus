// Script sync engine: Studio <-> local folder, with 3-way conflict detection via a manifest.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Studio } from "../studio.js";
import { fnv, splitPath } from "../luau.js";
import { StudioScript, ScriptClass, mapScripts, fileToTarget, isScriptFile, underPrefix } from "./mapping.js";

export interface ManifestEntry { segs: string[]; cls: ScriptClass; rc?: string; hash: string }
export interface Manifest { version: 1; place?: string; files: Record<string, ManifestEntry>; lastPull?: string; lastPush?: string }

export type PullDecision = "write" | "same" | "keep-local" | "conflict";
/** 3-way decision for one file on pull. local/base undefined = missing. */
export function decidePull(local: string | undefined, base: string | undefined, studio: string, force = false): PullDecision {
  if (local === undefined) return "write";
  if (local === studio) return "same";
  if (force || local === base) return "write";
  if (studio === base) return "keep-local";
  return "conflict";
}

export const normalize = (s: string) => s.replace(/\r\n/g, "\n");
const MANIFEST = ".rbxsync.json";
const MAX_ITEMS = 250;            // per Luau call (serializer caps arrays at 300)
const MAX_BYTES = 1_500_000;      // per Luau call

const LIST_LUA = `
local out = {}
for i, s in __scripts() do
 local ok, rc = pcall(function() return s.RunContext.Name end)
 table.insert(out, { s = __segs(s), c = s.ClassName, rc = ok and rc or nil, h = __fnv(__src(s)) })
 if i % 40 == 0 then task.wait() end
end
return out`;

const FETCH_LUA = `
local out = {}
for i, segs in DATA do local s = __find(segs) out[i] = s and __src(s) or false end
return out`;

const PUSH_LUA = `
local res = {}
for i, it in DATA do
 local inst = __find(it.s)
 if it.del then
  if inst then inst.Parent = nil res[i] = { st = "deleted" } else res[i] = { st = "missing" } end
 else
  if not inst and it.create then
   local x = game
   for j = 1, #it.s - 1 do
    local seg = it.s[j]
    local c = __find({ table.unpack(it.s, 1, j) })
    if not c then
     if j == 1 then local ok, svc = pcall(game.GetService, game, seg) c = ok and svc or nil end
     if not c then c = Instance.new("Folder") c.Name = seg c.Parent = x end
    end
    x = c
   end
   inst = Instance.new(it.cls)
   inst.Name = it.s[#it.s]
   inst.Parent = x
   __setsrc(inst, it.src)
   res[i] = { st = "created", h = __fnv(__src(inst)) }
  elseif not inst then
   res[i] = { st = "missing" }
  else
   local cur = __fnv(__src(inst))
   if it.base and not it.force and cur ~= it.base and cur ~= it.h then
    res[i] = { st = "conflict", h = cur }
   else
    __setsrc(inst, it.src)
    res[i] = { st = "ok", h = __fnv(__src(inst)) }
   end
  end
 end
 if i % 20 == 0 then task.wait() end
end
return res`;

export const PUSH_LUA_FOR_TOOLS = PUSH_LUA;

export interface SyncReport { lines: string[]; conflicts: string[]; changed: number }

export class SyncEngine {
  log: string[] = [];
  watching?: { dir: string; stop: () => void; interval: number };
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private studio: Studio) {}

  resolveDir(dir?: string): string { return path.resolve(dir ?? process.env.RBX_SYNC_DIR ?? "roblox-src"); }

  note(s: string) {
    const line = `${new Date().toLocaleTimeString()} ${s}`;
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    process.stderr.write(`[sync] ${s}\n`);
  }

  /** Serialize sync operations (watch + manual calls). */
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const p = this.busy.then(f, f);
    this.busy = p.catch(() => {});
    return p;
  }

  async loadManifest(dir: string): Promise<Manifest> {
    try { return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), "utf8")); } catch { return { version: 1, files: {} }; }
  }
  async saveManifest(dir: string, m: Manifest) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(m, null, 1));
  }

  async listStudio(studio?: string): Promise<StudioScript[]> {
    const raw = await this.studio.rpc<any[]>(LIST_LUA, undefined, { studio, context: "edit", timeoutMs: 120_000 });
    return (raw ?? []).map((x) => ({ segs: x.s, cls: x.c, rc: x.rc ?? undefined, hash: x.h }));
  }

  private async fetch(scripts: StudioScript[], studio?: string): Promise<(string | false)[]> {
    const out: (string | false)[] = [];
    let batch: StudioScript[] = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await this.studio.rpc<(string | false)[]>(FETCH_LUA, batch.map((b) => b.segs), { studio, context: "edit", timeoutMs: 120_000 });
      out.push(...batch.map((_, i) => r?.[i] ?? false));
      batch = []; bytes = 0;
    };
    for (const s of scripts) {
      const n = Number(s.hash.split(":")[0]) || 0;
      if (batch.length && (batch.length >= MAX_ITEMS || bytes + n > MAX_BYTES)) await flush();
      batch.push(s); bytes += n;
    }
    await flush();
    return out;
  }

  private async localHash(file: string): Promise<string | undefined> {
    try { return fnv(normalize(await fsp.readFile(file, "utf8"))); } catch { return undefined; }
  }

  private async placeName(studio?: string) { return (await this.studio.resolve(studio)).name; }

  private checkPlace(m: Manifest, place: string, force?: boolean) {
    if (m.place && m.place !== place && !force)
      throw new Error(`This folder is synced with '${m.place}' but the target studio is '${place}'. Use another dir, or force: true to rebind it.`);
  }

  pull(o: { dir?: string; paths?: string[]; force?: boolean; studio?: string } = {}): Promise<SyncReport> {
    return this.exclusive(async () => {
      const dir = this.resolveDir(o.dir);
      const m = await this.loadManifest(dir);
      const place = await this.placeName(o.studio);
      this.checkPlace(m, place, o.force);
      const prefixes = o.paths?.map(splitPath);
      const map = mapScripts(await this.listStudio(o.studio));
      const rep: SyncReport = { lines: [], conflicts: [], changed: 0 };
      const toFetch: [string, StudioScript][] = [];
      const decisions = new Map<string, PullDecision>();
      for (const [rel, s] of map) {
        if (!underPrefix(s.segs, prefixes)) continue;
        const lh = await this.localHash(path.join(dir, rel));
        const d = decidePull(lh, m.files[rel]?.hash, s.hash, o.force);
        decisions.set(rel, d);
        if (d === "same") m.files[rel] = { segs: s.segs, cls: s.cls, rc: s.rc, hash: s.hash };
        else if (d === "keep-local") rep.lines.push(`local changes not pushed yet: ${rel}`);
        else toFetch.push([rel, s]);
      }
      const sources = await this.fetch(toFetch.map((x) => x[1]), o.studio);
      for (let i = 0; i < toFetch.length; i++) {
        const [rel, s] = toFetch[i];
        const src = sources[i];
        if (src === false) { rep.lines.push(`vanished during pull: ${rel}`); continue; }
        const file = path.join(dir, rel);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        if (decisions.get(rel) === "conflict") {
          await fsp.writeFile(file + ".studio", src);
          rep.conflicts.push(rel);
          rep.lines.push(`CONFLICT ${rel}: changed both locally and in Studio. Studio version saved as ${rel}.studio — merge into ${rel}, delete the .studio file, then sync_push with force: true.`);
          continue;
        }
        await fsp.writeFile(file, src);
        await fsp.rm(file + ".studio", { force: true });
        m.files[rel] = { segs: s.segs, cls: s.cls, rc: s.rc, hash: fnv(src) };
        rep.changed++;
      }
      // Scripts gone from Studio.
      for (const rel of Object.keys(m.files)) {
        if (map.has(rel) || !underPrefix(m.files[rel].segs, prefixes)) continue;
        const file = path.join(dir, rel);
        const lh = await this.localHash(file);
        if (lh === undefined || lh === m.files[rel].hash) {
          await fsp.rm(file, { force: true });
          await removeEmptyDirs(path.dirname(file), dir);
          delete m.files[rel];
          rep.lines.push(`deleted locally (removed in Studio): ${rel}`);
        } else rep.lines.push(`removed in Studio but modified locally (kept): ${rel}`);
      }
      m.place = place;
      m.lastPull = new Date().toISOString();
      await this.saveManifest(dir, m);
      await writeReadme(dir);
      if (rep.changed || rep.conflicts.length) this.note(`pull: ${rep.changed} file(s) updated${rep.conflicts.length ? `, ${rep.conflicts.length} conflict(s)` : ""}`);
      rep.lines.unshift(`Pulled ${map.size} script(s) from '${place}' into ${dir}: ${rep.changed} written, ${rep.conflicts.length} conflict(s).`);
      return rep;
    });
  }

  async scanLocal(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      let ents: fs.Dirent[];
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (isScriptFile(e.name)) out.push(path.relative(dir, p).split(path.sep).join("/"));
      }
    };
    await walk(dir);
    return out;
  }

  /** Local view: which files changed since last sync, which are new, which were deleted. */
  async localChanges(dir: string, m: Manifest) {
    const files = await this.scanLocal(dir);
    const modified: string[] = [], added: string[] = [], deleted: string[] = [];
    const set = new Set(files);
    for (const rel of files) {
      const e = m.files[rel];
      if (!e) { added.push(rel); continue; }
      if ((await this.localHash(path.join(dir, rel))) !== e.hash) modified.push(rel);
    }
    for (const rel of Object.keys(m.files)) if (!set.has(rel)) deleted.push(rel);
    return { modified, added, deleted };
  }

  push(o: { dir?: string; files?: string[]; force?: boolean; dry_run?: boolean; delete_missing?: boolean; studio?: string } = {}): Promise<SyncReport> {
    return this.exclusive(async () => {
      const dir = this.resolveDir(o.dir);
      const m = await this.loadManifest(dir);
      const place = await this.placeName(o.studio);
      if (!m.place && !Object.keys(m.files).length && !(await this.scanLocal(dir)).length)
        throw new Error(`Nothing to push: ${dir} is empty. Run sync_pull first.`);
      this.checkPlace(m, place, o.force);
      let { modified, added, deleted } = await this.localChanges(dir, m);
      if (o.files?.length) {
        const want = new Set(o.files.map((f) => path.relative(dir, path.resolve(dir, f)).split(path.sep).join("/")));
        modified = modified.filter((f) => want.has(f)); added = added.filter((f) => want.has(f)); deleted = deleted.filter((f) => want.has(f));
      }
      const rep: SyncReport = { lines: [], conflicts: [], changed: 0 };
      const items: any[] = [], rels: string[] = [];
      for (const rel of modified) {
        const e = m.files[rel];
        const src = normalize(await fsp.readFile(path.join(dir, rel), "utf8"));
        items.push({ s: e.segs, src, base: e.hash, h: fnv(src), force: !!o.force }); rels.push(rel);
      }
      for (const rel of added) {
        const t = fileToTarget(rel);
        if (!t) { rep.lines.push(`skipped ${rel}: a new script file must be inside a service folder, e.g. ServerScriptService/MyScript.server.luau`); continue; }
        const src = normalize(await fsp.readFile(path.join(dir, rel), "utf8"));
        items.push({ s: t.segs, cls: t.cls, src, create: true, h: fnv(src) }); rels.push(rel);
      }
      if (o.delete_missing) for (const rel of deleted) { items.push({ s: m.files[rel].segs, del: true }); rels.push(rel); }
      else if (deleted.length) rep.lines.push(`${deleted.length} file(s) deleted locally but kept in Studio (pass delete_missing: true to delete them in Studio): ${deleted.join(", ")}`);
      if (o.dry_run) {
        rep.lines.unshift(`Dry run — would push ${items.length} change(s):`, ...rels.map((r, i) => `  ${items[i].del ? "delete" : items[i].create ? "create" : "update"} ${r}`));
        return rep;
      }
      // Batch by size.
      let i = 0;
      while (i < items.length) {
        let j = i, bytes = 0;
        while (j < items.length && j - i < MAX_ITEMS && (j === i || bytes + (items[j].src?.length ?? 0) < MAX_BYTES)) { bytes += items[j].src?.length ?? 0; j++; }
        const res = await this.studio.rpc<any[]>(PUSH_LUA, items.slice(i, j), { studio: o.studio, context: "edit", timeoutMs: 120_000 });
        for (let k = i; k < j; k++) {
          const r = res?.[k - i] ?? { st: "missing" }, rel = rels[k], it = items[k];
          if (r.st === "ok" || r.st === "created") {
            const t = it.create ? fileToTarget(rel)! : undefined;
            m.files[rel] = { ...(m.files[rel] ?? { segs: t!.segs, cls: t!.cls }), hash: r.h };
            if (r.h !== it.h) rep.lines.push(`note: Studio altered ${rel} on write (hash differs); run sync_pull to refresh`);
            rep.changed++;
            rep.lines.push(`${r.st === "created" ? "created" : "updated"} ${rel}`);
          } else if (r.st === "deleted") { delete m.files[rel]; rep.changed++; rep.lines.push(`deleted in Studio: ${rel}`); }
          else if (r.st === "conflict") {
            rep.conflicts.push(rel);
            rep.lines.push(`CONFLICT ${rel}: the script also changed in Studio since the last sync. Run sync_pull (writes ${rel}.studio) to merge, or push again with force: true to overwrite Studio.`);
          } else rep.lines.push(`missing in Studio: ${rel} (renamed or deleted there?). Run sync_pull.`);
        }
        i = j;
      }
      m.place = place;
      m.lastPush = new Date().toISOString();
      await this.saveManifest(dir, m);
      if (rep.changed || rep.conflicts.length) this.note(`push: ${rep.changed} change(s)${rep.conflicts.length ? `, ${rep.conflicts.length} conflict(s)` : ""}`);
      rep.lines.unshift(items.length ? `Pushed ${rep.changed}/${items.length} change(s) to '${place}'.` : "Nothing to push: no local changes since last sync.");
      return rep;
    });
  }

  async status(o: { dir?: string; studio?: string } = {}): Promise<string> {
    const dir = this.resolveDir(o.dir);
    const m = await this.loadManifest(dir);
    if (!m.place) return `Not synced yet: ${dir}. Run sync_pull to export the place's scripts there.`;
    const { modified, added, deleted } = await this.localChanges(dir, m);
    const map = mapScripts(await this.listStudio(o.studio));
    const studioMod: string[] = [], studioNew: string[] = [], studioGone: string[] = [];
    for (const [rel, s] of map) { const e = m.files[rel]; if (!e) studioNew.push(rel); else if (e.hash !== s.hash) studioMod.push(rel); }
    for (const rel of Object.keys(m.files)) if (!map.has(rel)) studioGone.push(rel);
    const conflicts = modified.filter((f) => studioMod.includes(f));
    const pending = (await this.scanAll(dir)).filter((f) => f.endsWith(".studio"));
    const sec = (t: string, a: string[]) => (a.length ? [`${t} (${a.length}):`, ...a.slice(0, 50).map((x) => "  " + x), ...(a.length > 50 ? [`  … ${a.length - 50} more`] : [])] : []);
    const lines = [
      `Sync dir: ${dir}  ↔  '${m.place}'   (${Object.keys(m.files).length} tracked, last pull ${m.lastPull ?? "never"}, last push ${m.lastPush ?? "never"}${this.watching ? ", WATCH ON" : ""})`,
      ...sec("Modified locally → sync_push", modified.filter((f) => !conflicts.includes(f))),
      ...sec("New local files → sync_push creates them", added),
      ...sec("Deleted locally (push with delete_missing to delete in Studio)", deleted),
      ...sec("Changed in Studio → sync_pull", studioMod.filter((f) => !conflicts.includes(f))),
      ...sec("New in Studio → sync_pull", studioNew),
      ...sec("Removed in Studio → sync_pull", studioGone),
      ...sec("CONFLICTS (changed on both sides)", conflicts),
      ...sec("Unresolved .studio conflict files", pending),
    ];
    if (lines.length === 1) lines.push("Everything in sync.");
    return lines.join("\n");
  }

  private async scanAll(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      let ents: fs.Dirent[];
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(path.relative(dir, p).split(path.sep).join("/")); }
    };
    await walk(dir);
    return out;
  }

  /** Two-way live sync: local edits are pushed (debounced), Studio edits are pulled (polling). */
  async watch(o: { dir?: string; on: boolean; interval_s?: number; studio?: string }): Promise<string> {
    if (!o.on) {
      if (!this.watching) return "Watch was not running.";
      this.watching.stop(); const d = this.watching.dir; this.watching = undefined;
      this.note("watch off");
      return `Watch stopped for ${d}.`;
    }
    const dir = this.resolveDir(o.dir);
    if (this.watching) { this.watching.stop(); this.watching = undefined; }
    const m = await this.loadManifest(dir);
    const first = !m.place ? await this.pull({ dir, studio: o.studio }) : undefined;
    const interval = Math.max(1, o.interval_s ?? 3) * 1000;
    let pending = new Set<string>(), timer: NodeJS.Timeout | undefined, stopped = false;
    const fire = () => {
      const files = [...pending]; pending = new Set();
      this.push({ dir, files, studio: o.studio }).then((r) => { if (r.changed || r.conflicts.length) this.note(r.lines.join(" | ")); }).catch((e) => this.note(`push failed: ${e.message}`));
    };
    const w = fs.watch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = name.toString().split(path.sep).join("/");
      if (!isScriptFile(rel) || rel.split("/").some((p) => p.startsWith("."))) return;
      pending.add(rel);
      clearTimeout(timer); timer = setTimeout(fire, 300);
    });
    let polling = false;
    const poll = setInterval(async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const mm = await this.loadManifest(dir);
        const map = mapScripts(await this.listStudio(o.studio));
        let changed = false;
        for (const [rel, s] of map) if (mm.files[rel]?.hash !== s.hash) { changed = true; break; }
        if (!changed) for (const rel of Object.keys(mm.files)) if (!map.has(rel)) { changed = true; break; }
        if (changed) { const r = await this.pull({ dir, studio: o.studio }); if (r.conflicts.length) this.note(r.lines.join(" | ")); }
      } catch (e: any) { this.note(`poll failed: ${e.message}`); }
      finally { polling = false; }
    }, interval);
    this.watching = { dir, interval, stop: () => { stopped = true; w.close(); clearInterval(poll); clearTimeout(timer); } };
    this.note(`watch on (${dir}, every ${interval / 1000}s)`);
    return `Watch ON: edits under ${dir} are pushed to Studio automatically, and Studio edits are pulled every ${interval / 1000}s. Conflicts are reported in sync_status / studio_status.${first ? "\n" + first.lines.join("\n") : ""}`;
  }
}

async function removeEmptyDirs(d: string, root: string) {
  while (path.resolve(d) !== path.resolve(root) && d.startsWith(root)) {
    try { if ((await fsp.readdir(d)).length) return; await fsp.rmdir(d); } catch { return; }
    d = path.dirname(d);
  }
}

const README = `# Roblox scripts (synced by rbx-studio-plus)

This folder mirrors the scripts of a Roblox Studio place. Edit the files here, then
run the MCP tool \`sync_push\` (or turn on \`sync_watch\`) to send changes to Studio.

- \`X.server.luau\` = Script, \`X.client.luau\` = LocalScript, \`X.luau\` = ModuleScript
- A script that contains other scripts is \`X/init.*.luau\` with its children inside \`X/\`
- Folders mirror the instance hierarchy (\`ServerScriptService/Combat/Damage.server.luau\`)
- New files are created in Studio on push (intermediate Folders are created too)
- Duplicate sibling names get a \`~N\` suffix; special characters are %-encoded
- \`*.studio\` files are the Studio side of a conflict: merge, delete it, push with force
- \`.rbxsync.json\` is the sync state — do not edit it
`;

async function writeReadme(dir: string) {
  const f = path.join(dir, "README.md");
  if (!fs.existsSync(f)) await fsp.writeFile(f, README);
}
