// Tool definitions: improved tools + automatic passthrough of every other Studio tool.
import fsp from "node:fs/promises";
import path from "node:path";
import { Studio, LuauError, DM } from "./studio.js";
import { SyncEngine, PUSH_LUA_FOR_TOOLS } from "./sync/engine.js";
import { ToolResult, textOf, UpstreamTool } from "./upstream.js";
import { splitPath, cleanError } from "./luau.js";
import { diffConsole, ConsoleEntry, formatConsole, ConsoleCursor } from "./console.js";

type Args = Record<string, any>;
export interface ToolDef { name: string; description: string; inputSchema: any; handler: (a: Args) => Promise<ToolResult | string> }

const STUDIO_PROP = { studio: { type: "string", description: "Optional. Target Studio (name substring, place id or id). Only needed when several Studios are open and none was selected." } };
const CONTEXT_PROP = { context: { type: "string", enum: ["edit", "client", "server"], description: "Datamodel to run in. Default: edit when not playing, otherwise server." } };
const obj = (props: Args, required: string[] = []) => ({ type: "object", properties: { ...props, ...STUDIO_PROP }, required, additionalProperties: false });

/** Upstream tools that are superseded by better versions here. */
export const HIDDEN = new Set(["list_roblox_studios", "get_studio_state", "execute_luau", "get_console_output", "start_stop_play", "script_read", "multi_edit"]);

const fmtJson = (v: unknown) => { const s = JSON.stringify(v, null, 2); return s.length < 4000 ? s : JSON.stringify(v); };
const truncate = (s: string, n = 20_000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars truncated)` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const segsArg = (p: string) => { const s = splitPath(p); if (!s.length) throw new Error(`Empty path '${p}'. Use e.g. "Workspace.Model.Part" or "ServerScriptService/Main".`); return s; };

export function formatLuau(r: { ok: boolean; ms: number; output: string[]; dropped: number; result?: unknown; error?: string; dm: DM }): string {
  const out = [`${r.ok ? "✔ ok" : "✘ error"} · ${r.ms} ms · ${r.dm}`];
  if (r.output.length) out.push("--- output ---", truncate(r.output.join("\n")) + (r.dropped ? `\n… ${r.dropped} more lines dropped` : ""));
  if (r.ok && r.result !== undefined) out.push("--- result ---", truncate(typeof r.result === "string" ? r.result : fmtJson(r.result)));
  if (!r.ok) out.push("--- error ---", r.error ?? "unknown error");
  return out.join("\n");
}

// Converts JSON-friendly values into Luau values (used by set_props / create).
const VALUE_LUA = `
local function __val(v, cur)
 local tc = typeof(cur)
 local function n(t, i) return t[i] or 0 end
 if type(v) == "string" then
  if tc == "EnumItem" then local nm = string.match(v, "([^.]+)$") return cur.EnumType[nm] end
  if tc == "BrickColor" then return BrickColor.new(v) end
  if tc == "Color3" and string.sub(v, 1, 1) == "#" then return Color3.fromHex(v) end
  return v
 end
 if type(v) ~= "table" then return v end
 if #v > 0 then
  if tc == "Vector3" then return Vector3.new(n(v,1), n(v,2), n(v,3)) end
  if tc == "Vector2" then return Vector2.new(n(v,1), n(v,2)) end
  if tc == "Color3" then if v[1] > 1 or v[2] > 1 or v[3] > 1 then return Color3.fromRGB(n(v,1), n(v,2), n(v,3)) end return Color3.new(n(v,1), n(v,2), n(v,3)) end
  if tc == "CFrame" then v = { CFrame = v } end
  if tc == "UDim2" then return UDim2.new(n(v,1), n(v,2), n(v,3), n(v,4)) end
  if tc == "UDim" then return UDim.new(n(v,1), n(v,2)) end
  if tc == "NumberRange" then return NumberRange.new(n(v,1), v[2] or n(v,1)) end
 end
 if v.Vector3 then local t = v.Vector3 return Vector3.new(n(t,1), n(t,2), n(t,3)) end
 if v.Vector2 then local t = v.Vector2 return Vector2.new(n(t,1), n(t,2)) end
 if v.Color3 then local t = v.Color3 return Color3.new(n(t,1), n(t,2), n(t,3)) end
 if v.rgb then local t = v.rgb return Color3.fromRGB(n(t,1), n(t,2), n(t,3)) end
 if v.hex then return Color3.fromHex(v.hex) end
 if v.CFrame then local t = v.CFrame
  if #t == 6 then return CFrame.new(t[1], t[2], t[3]) * CFrame.Angles(math.rad(t[4]), math.rad(t[5]), math.rad(t[6])) end
  return CFrame.new(table.unpack(t)) end
 if v.UDim2 then local t = v.UDim2 return UDim2.new(n(t,1), n(t,2), n(t,3), n(t,4)) end
 if v.UDim then local t = v.UDim return UDim.new(n(t,1), n(t,2)) end
 if v.NumberRange then local t = v.NumberRange return NumberRange.new(n(t,1), t[2] or n(t,1)) end
 if v.Enum then local a, b = string.match(v.Enum, "^([^.]+)%.(.+)$") return Enum[a][b] end
 if v.BrickColor then return BrickColor.new(v.BrickColor) end
 if v.ref then return __need(v.ref) end
 if v.nil_ then return nil end
 error("unsupported value " .. __HS:JSONEncode(v), 0)
end
local function __apply(inst, props, attrs)
 local res = {}
 for k, v in props or {} do
  local ok, e = pcall(function() local cur = nil pcall(function() cur = inst[k] end) inst[k] = __val(v, cur) end)
  res[k] = ok and "ok" or tostring(e)
 end
 for k, v in attrs or {} do
  local ok, e = pcall(function() inst:SetAttribute(k, __val(v, inst:GetAttribute(k))) end)
  res["@" .. k] = ok and "ok" or tostring(e)
 end
 return res
end
local function __p(i) return table.concat(__segs(i), ".") end
`;

/** Turn {"ref":"Workspace.X"} into {"ref":[segs]} recursively. */
function prepValues(v: any): any {
  if (Array.isArray(v)) return v.map(prepValues);
  if (v && typeof v === "object") {
    if (typeof v.ref === "string") return { ref: segsArg(v.ref) };
    if (v.nil === true) return { nil_: true };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prepValues(x)]));
  }
  return v;
}

export function buildTools(studio: Studio, sync: SyncEngine): ToolDef[] {
  const cursors = new Map<string, ConsoleCursor>();

  async function fetchLog(o: { studio?: string; context?: string }): Promise<ConsoleEntry[]> {
    return (await studio.rpc<any[]>(`
local out = {}
for i, e in game:GetService("LogService"):GetLogHistory() do out[i] = { m = e.message, t = e.messageType.Name, ts = e.timestamp } end
return __HS:JSONEncode(out)`, undefined, { ...o, timeoutMs: 30_000 }).then((s: any) => JSON.parse(s))) as ConsoleEntry[];
  }

  async function readConsole(o: { studio?: string; context?: string; all?: boolean }) {
    const s = await studio.resolve(o.studio);
    const hist = await fetchLog(o);
    const { entries, cursor } = diffConsole(hist, o.all ? undefined : cursors.get(s.id));
    cursors.set(s.id, cursor);
    return entries;
  }

  async function waitFor(pred: (st: Awaited<ReturnType<Studio["state"]>>) => boolean, studioQ?: string, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const st = await studio.state(studioQ, true);
      if (pred(st)) return st;
      await sleep(500);
    }
    throw new Error(`Studio did not reach the expected play state within ${ms / 1000}s.`);
  }

  async function play(action: "start" | "stop", studioQ?: string) {
    const st = await studio.state(studioQ, true);
    const playing = st.mode.toLowerCase() !== "edit";
    if (action === "start" && playing) return { st, changed: false };
    if (action === "stop" && !playing) return { st, changed: false };
    const r = await studio.raw("start_stop_play", { is_start: action === "start" }, studioQ, 60_000);
    if (r.isError) throw new Error(cleanError(textOf(r)));
    const st2 = await waitFor((s) => action === "start" ? s.mode.toLowerCase() !== "edit" && s.available.some((d) => d !== "Edit") : s.mode.toLowerCase() === "edit", studioQ);
    studio.invalidate();
    return { st: st2, changed: true };
  }

  const tools: ToolDef[] = [
    {
      name: "studio_status",
      description: "START HERE. One call shows: connected Studio instances (and which one is targeted), play mode, available datamodels, script-sync state and recent sync activity.",
      inputSchema: obj({}),
      async handler(a) {
        const list = await studio.list(true);
        const lines: string[] = [];
        if (!list.length) return "No Roblox Studio instance connected. Open a place in Studio and enable 'Studio as MCP server' (Assistant → … → Manage MCP Servers).";
        let target: string | undefined;
        try { target = (await studio.resolve(a.studio)).id; } catch { /* several open, none selected */ }
        lines.push("Studios:");
        for (const s of list) lines.push(`  ${s.id === target ? "▶" : " "} ${s.name}  (id ${s.id})`);
        if (!target) lines.push("  Several studios open and none selected → call studio_select.");
        else {
          const st = await studio.state(a.studio, true);
          lines.push(`Mode: ${st.mode} · datamodels: ${st.available.join(", ") || "?"}${st.focused ? ` · focused: ${st.focused}` : ""}`);
          try { lines.push("", await sync.status({ studio: a.studio })); } catch (e: any) { lines.push("", `Sync: ${e.message}`); }
        }
        if (sync.log.length) lines.push("", "Recent sync activity:", ...sync.log.slice(-8).map((l) => "  " + l));
        return lines.join("\n");
      },
    },
    {
      name: "studio_select",
      description: "Choose which open Studio instance all following calls target (only needed when several are open).",
      inputSchema: { type: "object", properties: { studio: { type: "string", description: "Name substring, place id, or id from studio_status." } }, required: ["studio"] },
      async handler(a) {
        studio.selected = undefined;
        const s = await studio.resolve(a.studio);
        studio.selected = s.id;
        return `Now targeting: ${s.name} (id ${s.id})`;
      },
    },
    {
      name: "luau_run",
      description: "Run Luau in Studio and get back print/warn output, the return value (Instances, Vector3, tables… are serialized) and errors with line numbers. Use for queries and one-off edits; changes are undoable (history action=undo). Code runs on Studio's main thread: in long loops call task.wait() every ~1000 iterations. Top-level `return` works.",
      inputSchema: obj({
        code: { type: "string", description: "Luau source. Either code or file is required." },
        file: { type: "string", description: "Path to a local .luau file to run instead of inline code." },
        ...CONTEXT_PROP,
        timeout_s: { type: "number", description: "Default 60, max 600." },
      }),
      async handler(a) {
        let code: string = a.code ?? "";
        if (a.file) code = await fsp.readFile(path.resolve(a.file), "utf8");
        if (!code.trim()) throw new Error("Provide 'code' or 'file'.");
        const r = await studio.luau(code, { studio: a.studio, context: a.context, timeoutMs: Math.min(600, a.timeout_s ?? 60) * 1000 });
        return formatLuau(r);
      },
    },
    {
      name: "console",
      description: "Read Studio's Output window. By default returns only lines that are new since your previous console call. Errors are prefixed [E], warnings [W].",
      inputSchema: obj({
        since: { type: "string", enum: ["last", "all"], description: "last (default): only new lines since the previous call; all: the whole history." },
        level: { type: "string", enum: ["all", "warn", "error"], description: "Minimum level. Default all." },
        filter: { type: "string", description: "Case-insensitive substring, or /regex/." },
        tail: { type: "number", description: "Max lines returned (most recent). Default 200." },
        ...CONTEXT_PROP,
      }),
      async handler(a) {
        const entries = await readConsole({ studio: a.studio, context: a.context, all: a.since === "all" });
        return formatConsole(entries, { level: a.level, filter: a.filter, tail: a.tail ?? 200 }) || "(no new output)";
      },
    },
    {
      name: "play",
      description: "Start or stop a playtest (waits until Studio has actually switched), or report the current mode.",
      inputSchema: obj({ action: { type: "string", enum: ["start", "stop", "status"] } }, ["action"]),
      async handler(a) {
        if (a.action === "status") { const st = await studio.state(a.studio, true); return `Mode: ${st.mode} · datamodels: ${st.available.join(", ")}`; }
        const { st, changed } = await play(a.action, a.studio);
        return `${changed ? (a.action === "start" ? "Playtest started." : "Playtest stopped.") : "Already in that state."} Mode: ${st.mode} · datamodels: ${st.available.join(", ")}`;
      },
    },
    {
      name: "playtest",
      description: "One-shot verification: starts a playtest, optionally runs Luau in the server (or client), waits, collects every error/warning/print from the Output, then stops. Use after changes to check nothing breaks at runtime.",
      inputSchema: obj({
        code: { type: "string", description: "Optional Luau to run once the game is running (e.g. assertions; return a value to report)." },
        context: { type: "string", enum: ["server", "client"], description: "Where to run code. Default server." },
        duration_s: { type: "number", description: "How long to let the game run in total. Default 5, max 120." },
        stop_after: { type: "boolean", description: "Stop the playtest at the end. Default true." },
      }),
      async handler(a) {
        const dur = Math.min(120, Math.max(1, a.duration_s ?? 5)) * 1000;
        const want: DM = a.context === "client" ? "Client" : "Server";
        const t0 = Date.now();
        await readConsole({ studio: a.studio }).catch(() => {}); // move cursor to now
        await play("start", a.studio);
        await waitFor((s) => s.available.includes(want), a.studio, 30_000).catch(() => {});
        const parts: string[] = [];
        let ok = true;
        if (a.code) {
          const r = await studio.luau(a.code, { studio: a.studio, context: want, timeoutMs: dur + 60_000 }).catch((e) => ({ ok: false, ms: 0, output: [], dropped: 0, error: e.message, dm: want }));
          ok = r.ok;
          parts.push(formatLuau(r as any));
        }
        const left = dur - (Date.now() - t0);
        if (left > 0) await sleep(left);
        let entries: ConsoleEntry[] = [];
        try { entries = await readConsole({ studio: a.studio, context: want.toLowerCase() }); } catch (e: any) { parts.push(`(could not read console: ${e.message})`); }
        if (a.stop_after !== false) await play("stop", a.studio).catch((e) => parts.push(`(could not stop: ${e.message})`));
        const errs = entries.filter((e) => e.t === "MessageError").length, warns = entries.filter((e) => e.t === "MessageWarning").length;
        if (errs) ok = false;
        return [
          `${ok ? "✔ PASS" : "✘ FAIL"} · ran ${Math.round((Date.now() - t0) / 1000)}s · ${errs} error(s), ${warns} warning(s)${a.stop_after === false ? " · still playing" : ""}`,
          ...parts,
          "--- console ---",
          formatConsole(entries, { tail: 300 }) || "(empty)",
        ].join("\n");
      },
    },
    {
      name: "tree",
      description: "Compact view of the instance hierarchy (Name [Class] (+N hidden children)). With class/name filters, lists matching instances with full paths instead. Faster and terser than search_game_tree.",
      inputSchema: obj({
        path: { type: "string", description: "Start instance, e.g. Workspace.Map (default: whole game)." },
        depth: { type: "number", description: "Levels to expand. Default 2 (10 with filters)." },
        class: { type: "string", description: "Only instances where IsA(class), e.g. BasePart, BaseScript, GuiObject." },
        name: { type: "string", description: "Only instances whose name contains this (case-insensitive)." },
        max: { type: "number", description: "Max lines. Default 300." },
        ...CONTEXT_PROP,
      }),
      async handler(a) {
        const filtered = !!(a.class || a.name);
        const data = { path: a.path ? segsArg(a.path) : null, depth: a.depth ?? (filtered ? 10 : 2), cls: a.class ?? null, name: a.name ? String(a.name).toLowerCase() : null, max: a.max ?? 300, flat: filtered };
        const r = await studio.rpc<any>(`
local root = DATA.path and __need(DATA.path) or game
local lines, count, more, seen = {}, 0, 0, 0
local function kids(x) local ok, c = pcall(x.GetChildren, x) return ok and c or {} end
local function rec(x, d, ind)
 for _, c in kids(x) do
  seen += 1
  if seen % 3000 == 0 then task.wait() end
  local okn, nm = pcall(function() return c.Name end)
  if okn and not (x == game and __SKIP[nm]) then
   local isMatch = (not DATA.cls or c:IsA(DATA.cls)) and (not DATA.name or string.find(string.lower(c.Name), DATA.name, 1, true) ~= nil)
   local ch = kids(c)
   if DATA.flat then
    if isMatch then if count < DATA.max then count += 1 table.insert(lines, c:GetFullName() .. " [" .. c.ClassName .. "]") else more += 1 end end
    if d < DATA.depth then rec(c, d + 1, ind) end
   elseif not (x == game and #ch == 0) then
    if count < DATA.max then
     count += 1
     table.insert(lines, ind .. c.Name .. " [" .. c.ClassName .. "]" .. ((d >= DATA.depth and #ch > 0) and (" (+" .. #ch .. ")") or ""))
     if d < DATA.depth then rec(c, d + 1, ind .. "  ") end
    else more += 1 end
   end
  end
 end
end
rec(root, 1, "")
if more > 0 then table.insert(lines, "… " .. more .. " more (raise max or narrow path/filters)") end
return (root == game and "game" or root:GetFullName()) .. "\\n" .. table.concat(lines, "\\n")`, data, { studio: a.studio, context: a.context, timeoutMs: 60_000 });
        return r;
      },
    },
    {
      name: "inspect",
      description: "All properties, attributes and children summary of an instance (optionally only some properties).",
      inputSchema: obj({ path: { type: "string" }, props: { type: "array", items: { type: "string" }, description: "Only return these properties." } }, ["path"]),
      async handler(a) {
        const r = await studio.raw("inspect_instance", { path: "game." + segsArg(a.path).join(".") }, a.studio);
        if (r.isError || !a.props?.length) return r;
        try {
          const j = JSON.parse(textOf(r));
          const pick = (x: any) => ({ ...x, properties: Object.fromEntries(Object.entries(x.properties ?? {}).filter(([k]) => a.props.some((p: string) => k === p || k.startsWith(p + ".")))) });
          return fmtJson(j.matches ? { ...j, matches: j.matches.map(pick) } : pick(j));
        } catch { return r; }
      },
    },
    {
      name: "set_props",
      description: 'Set properties and/or attributes of an instance. Plain arrays/strings are converted from the property\'s current type: Size: [2,3,4], Color: [255,0,0] or "#ff0000", Material: "Neon", CFrame: [x,y,z] or [x,y,z,rx,ry,rz] (degrees). Explicit forms also work: numbers, booleans, strings, {"Vector3":[x,y,z]}, {"Color3":[r,g,b]} (0-1), {"rgb":[0-255,…]}, {"hex":"#ff0000"}, {"CFrame":[x,y,z]} or [x,y,z,rx,ry,rz] (degrees), {"UDim2":[xs,xo,ys,yo]}, {"Enum":"Material.Neon"}, {"BrickColor":"Bright red"}, {"ref":"Workspace.Other"}, {"nil":true}. Undoable.',
      inputSchema: obj({ path: { type: "string" }, props: { type: "object" }, attributes: { type: "object" } }, ["path"]),
      async handler(a) {
        const r = await studio.rpc(`${VALUE_LUA}
local inst = __need(DATA.path)
return __apply(inst, DATA.props, DATA.attrs)`, { path: segsArg(a.path), props: prepValues(a.props ?? {}), attrs: prepValues(a.attributes ?? {}) }, { studio: a.studio, context: "edit" });
        return fmtJson(r);
      },
    },
    {
      name: "instance",
      description: "Create, delete, move (reparent), clone or rename instances. Undoable. For scripts prefer script_write or the file sync.",
      inputSchema: obj({
        op: { type: "string", enum: ["create", "delete", "move", "clone", "rename"] },
        path: { type: "string", description: "Target instance (delete/move/clone/rename)." },
        class: { type: "string", description: "create: ClassName, e.g. Part, Folder, RemoteEvent." },
        parent: { type: "string", description: "create: parent path. move/clone: new parent." },
        name: { type: "string", description: "create/clone/rename: new name." },
        props: { type: "object", description: "create/clone: properties to set (same value format as set_props)." },
        attributes: { type: "object" },
      }, ["op"]),
      async handler(a) {
        const data = { op: a.op, path: a.path ? segsArg(a.path) : null, parent: a.parent ? (splitPath(a.parent).length ? splitPath(a.parent) : []) : null, cls: a.class ?? null, name: a.name ?? null, props: prepValues(a.props ?? {}), attrs: prepValues(a.attributes ?? {}) };
        const r = await studio.rpc(`${VALUE_LUA}
local op = DATA.op
local function parentOf() if not DATA.parent then error("parent is required", 0) end return #DATA.parent == 0 and game or __need(DATA.parent) end
if op == "create" then
 if not DATA.cls then error("class is required", 0) end
 local x = Instance.new(DATA.cls)
 if DATA.name then x.Name = DATA.name end
 local res = __apply(x, DATA.props, DATA.attrs)
 x.Parent = parentOf()
 return { created = __p(x), props = res }
end
local inst = __need(DATA.path or error("path is required", 0))
if op == "delete" then local p = __p(inst) inst.Parent = nil return { deleted = p, note = "undoable with history action=undo" } end
if op == "move" then inst.Parent = parentOf() return { moved = __p(inst) } end
if op == "rename" then inst.Name = DATA.name or error("name is required", 0) return { renamed = __p(inst) } end
if op == "clone" then
 local c = inst:Clone()
 if not c then error("instance is not Archivable", 0) end
 if DATA.name then c.Name = DATA.name end
 local res = __apply(c, DATA.props, DATA.attrs)
 c.Parent = DATA.parent and parentOf() or inst.Parent
 return { cloned = __p(c), props = res }
end
error("unknown op " .. tostring(op), 0)`, data, { studio: a.studio, context: "edit" });
        return fmtJson(r);
      },
    },
    {
      name: "script_read",
      description: "Read a script's source (includes unsaved editor changes), with line numbers. Prefer the local files if the place is synced (sync_pull).",
      inputSchema: obj({ path: { type: "string", description: "e.g. ServerScriptService.Main" }, start: { type: "number" }, end: { type: "number" } }, ["path"]),
      async handler(a) {
        const src: string = await studio.rpc(`local s = __need(DATA) if not s:IsA("LuaSourceContainer") then error(s:GetFullName() .. " is a " .. s.ClassName .. ", not a script", 0) end return __src(s)`, segsArg(a.path), { studio: a.studio, context: "edit" });
        const lines = src.split("\n");
        const st = Math.max(1, a.start ?? 1), en = Math.min(lines.length, a.end ?? lines.length);
        const w = String(en).length;
        return lines.slice(st - 1, en).map((l, i) => `${String(st + i).padStart(w)}│ ${l}`).join("\n") + (en < lines.length || st > 1 ? `\n(lines ${st}-${en} of ${lines.length})` : "");
      },
    },
    {
      name: "script_write",
      description: "Replace a script's whole source, creating the script (and missing parent Folders) if needed. Undoable.",
      inputSchema: obj({ path: { type: "string" }, source: { type: "string" }, class: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Class when creating. Default ModuleScript." } }, ["path", "source"]),
      async handler(a) {
        const r = await studio.rpc<any[]>(PUSH_LUA_FOR_TOOLS, [{ s: segsArg(a.path), src: String(a.source).replace(/\r\n/g, "\n"), create: true, cls: a.class ?? "ModuleScript", force: true }], { studio: a.studio, context: "edit" });
        const st = r?.[0]?.st;
        return st === "created" ? `Created ${a.path} (${a.class ?? "ModuleScript"}).` : st === "ok" ? `Updated ${a.path}.` : `Failed: ${fmtJson(r)}`;
      },
    },
    {
      name: "script_edit",
      description: "Exact search/replace edits in one script (atomic). Each `old` must match exactly once unless all=true.",
      inputSchema: obj({
        path: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["old", "new"] } },
      }, ["path", "edits"]),
      async handler(a) {
        return studio.raw("multi_edit", { file_path: "game." + segsArg(a.path).join("."), datamodel_type: "Edit", edits: a.edits.map((e: any) => ({ old_string: e.old, new_string: e.new, replace_all: !!e.all })) }, a.studio);
      },
    },
    {
      name: "script_check",
      description: "Compile every script (or those under given paths) and report syntax errors. Fast static check before a playtest.",
      inputSchema: obj({ paths: { type: "array", items: { type: "string" }, description: "Only scripts under these instance paths." } }),
      async handler(a) {
        const r = await studio.rpc<any[]>(`
local out = {}
for i, s in __scripts() do
 local p = __segs(s)
 local okp = #DATA == 0
 for _, pre in DATA do local m = true for k, v in pre do if p[k] ~= v then m = false break end end if m then okp = true break end end
 if okp then
  local f, e = loadstring(__src(s), "=" .. table.concat(p, "."))
  if not f then table.insert(out, e) end
 end
 if i % 40 == 0 then task.wait() end
end
return out`, (a.paths ?? []).map(segsArg), { studio: a.studio, context: "edit", timeoutMs: 120_000 });
        return r?.length ? `✘ ${r.length} script(s) with syntax errors:\n${r.join("\n")}` : "✔ All scripts compile.";
      },
    },
    {
      name: "selection",
      description: "Get the instances the user currently has selected in Studio (great for 'fix this'), or set the selection.",
      inputSchema: obj({ set: { type: "array", items: { type: "string" }, description: "Paths to select. Omit to just read the selection." } }),
      async handler(a) {
        const r = await studio.rpc(`
local S = game:GetService("Selection")
if DATA then local t = {} for _, p in DATA do table.insert(t, __need(p)) end S:Set(t) end
local out = {}
for _, x in S:Get() do table.insert(out, x:GetFullName() .. " [" .. x.ClassName .. "]") end
return out`, a.set ? a.set.map(segsArg) : undefined, { studio: a.studio, context: "edit" });
        const arr = (r as string[]) ?? [];
        return arr.length ? `Selected (${arr.length}):\n${arr.join("\n")}` : "Nothing selected.";
      },
    },
    {
      name: "history",
      description: "Undo or redo the last change(s) in Studio (every tool edit is recorded as an undo step).",
      inputSchema: obj({ action: { type: "string", enum: ["undo", "redo"] }, steps: { type: "number", description: "Default 1." } }, ["action"]),
      async handler(a) {
        const n = Math.max(1, Math.min(50, a.steps ?? 1));
        // Must run after the current recording ends, so schedule it on a deferred thread.
        if (a.action !== "undo" && a.action !== "redo") throw new Error("action must be undo or redo");
        await studio.rpc(`local CHS = game:GetService("ChangeHistoryService") task.delay(0.05, function() for _ = 1, DATA.n do if DATA.undo then CHS:Undo() else CHS:Redo() end end end) return true`, { n, undo: a.action === "undo" }, { studio: a.studio, context: "edit" });
        await sleep(300);
        return `${a.action === "undo" ? "Undid" : "Redid"} ${n} step(s).`;
      },
    },
    {
      name: "sync_pull",
      description: "Export the place's scripts to a local folder (Rojo-style: .server.luau / .client.luau / .luau) so you can read/edit/grep them with your normal file tools. Safe to re-run: only changed files are rewritten; files edited on both sides produce a <file>.studio conflict copy instead of being overwritten.",
      inputSchema: obj({
        dir: { type: "string", description: "Local folder. Default ./roblox-src (or RBX_SYNC_DIR)." },
        paths: { type: "array", items: { type: "string" }, description: "Only these subtrees, e.g. ['ServerScriptService']." },
        force: { type: "boolean", description: "Overwrite local edits / rebind folder to another place." },
      }),
      async handler(a) { return (await sync.pull(a)).lines.join("\n"); },
    },
    {
      name: "sync_push",
      description: "Send locally edited/new script files to Studio. Refuses to overwrite scripts that were also changed in Studio since the last sync (conflict) unless force. New files are created (class from suffix). Deleted files are only deleted in Studio with delete_missing.",
      inputSchema: obj({
        dir: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Only these files (relative to dir)." },
        force: { type: "boolean" },
        dry_run: { type: "boolean", description: "Only list what would be pushed." },
        delete_missing: { type: "boolean", description: "Delete in Studio the scripts whose files were deleted locally." },
      }),
      async handler(a) { return (await sync.push(a)).lines.join("\n"); },
    },
    {
      name: "sync_status",
      description: "What differs between the local folder and Studio: local edits, Studio edits, new/removed scripts, conflicts. Read-only.",
      inputSchema: obj({ dir: { type: "string" } }),
      async handler(a) { return sync.status(a); },
    },
    {
      name: "sync_watch",
      description: "Live two-way sync: local file saves are pushed to Studio automatically, and edits made in Studio are pulled every few seconds. Pulls first if the folder is not synced yet.",
      inputSchema: obj({ on: { type: "boolean" }, dir: { type: "string" }, interval_s: { type: "number", description: "Studio polling interval. Default 3." } }, ["on"]),
      async handler(a) { return sync.watch(a as any); },
    },
  ];
  return tools;
}

/** Re-expose an upstream tool without studio_id and with optional datamodel_type. */
export function passthrough(t: UpstreamTool, studio: Studio): ToolDef {
  const schema = JSON.parse(JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }));
  schema.properties ??= {};
  delete schema.properties.studio_id;
  const hasDM = !!schema.properties.datamodel_type;
  if (hasDM) schema.properties.datamodel_type.description = "Optional (auto: Edit when not playing, else Server). Edit, Client or Server.";
  schema.required = (schema.required ?? []).filter((r: string) => r !== "studio_id" && r !== "datamodel_type");
  Object.assign(schema.properties, STUDIO_PROP);
  const description = (t.description ?? "")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/studio_id|list_roblox_studios/i.test(s))
    .join(" ");
  return {
    name: t.name,
    description,
    inputSchema: schema,
    async handler(a) {
      const { studio: q, ...rest } = a;
      if (hasDM) rest.datamodel_type = rest.datamodel_type ? (await studio.pickDM(q, rest.datamodel_type)) : await studio.pickDM(q);
      const r = await studio.raw(t.name, rest, q, 300_000);
      if (r.isError) return { ...r, content: r.content.map((c) => (c.type === "text" ? { ...c, text: cleanError(c.text ?? "") } : c)) };
      return r;
    },
  };
}

export { LuauError };
