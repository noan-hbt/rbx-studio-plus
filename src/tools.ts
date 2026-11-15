// Tool definitions: improved tools + automatic passthrough of every other Studio tool.
import fsp from "node:fs/promises";
import path from "node:path";
import { Studio, LuauError, DM } from "./studio.js";
import { SyncEngine, PUSH_LUA_FOR_TOOLS, normalize } from "./sync/engine.js";
import { ToolResult, textOf, UpstreamTool } from "./upstream.js";
import { splitPath, cleanError, VALUE_LUA } from "./luau.js";
import { diffConsole, ConsoleEntry, formatConsole, ConsoleCursor, stripPluginNoise } from "./console.js";
import { analyzeScripts, runExternalAnalyzers } from "./analysis.js";

type Args = Record<string, any>;
export interface ToolDef { name: string; description: string; inputSchema: any; handler: (a: Args) => Promise<ToolResult | string> }

const STUDIO_PROP = { studio: { type: "string", description: "Optional. Target Studio (name substring, place id or id). Only needed when several Studios are open and none was selected." } };
const CONTEXT_PROP = { context: { type: "string", enum: ["edit", "client", "server"], description: "Datamodel to run in. Default: edit when not playing, otherwise server." } };
const obj = (props: Args, required: string[] = []) => ({ type: "object", properties: { ...props, ...STUDIO_PROP }, required, additionalProperties: false });

/** Upstream tools that are superseded by better versions here. */
export const HIDDEN = new Set([
  "list_roblox_studios",
  "get_studio_state",
  "execute_luau",
  "get_console_output",
  "start_stop_play",
  "script_read",
  "multi_edit",
  "script_grep",
]);

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

function prepTree(node: any): any {
  if (!node || typeof node !== "object") return node;
  return {
    cls: node.class ?? node.cls,
    name: node.name ?? null,
    props: prepValues(node.props ?? {}),
    attrs: prepValues(node.attributes ?? {}),
    tags: Array.isArray(node.tags) ? node.tags : null,
    children: Array.isArray(node.children) ? node.children.map(prepTree) : null,
  };
}

export function buildTools(studio: Studio, sync: SyncEngine): ToolDef[] {
  const cursors = new Map<string, ConsoleCursor>();

  async function fetchLog(o: { studio?: string; context?: string }): Promise<{ entries: ConsoleEntry[]; dm: DM }> {
    const dm = await studio.pickDM(o.studio, o.context);
    const json = await studio.rpc<string>(`
local out = {}
for i, e in game:GetService("LogService"):GetLogHistory() do out[i] = { m = e.message, t = e.messageType.Name, ts = e.timestamp } end
return __HS:JSONEncode(out)`, undefined, { studio: o.studio, context: dm, timeoutMs: 30_000 });
    return { entries: JSON.parse(json || "[]") as ConsoleEntry[], dm };
  }

  async function readConsole(o: { studio?: string; context?: string; all?: boolean; srcLabel?: string }) {
    const s = await studio.resolve(o.studio);
    const { entries: hist, dm } = await fetchLog(o);
    const cursorKey = `${s.id}:${dm}`;
    const { entries, cursor } = diffConsole(hist, o.all ? undefined : cursors.get(cursorKey));
    cursors.set(cursorKey, cursor);
    if (o.srcLabel) return entries.map((e) => ({ ...e, src: o.srcLabel }));
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
      description: "START HERE. One call shows: connected Studio instances (and which one is targeted), play mode, available datamodels, PlaceId, script-sync state and recent sync activity.",
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
          let infoLine = `Mode: ${st.mode} · datamodels: ${st.available.join(", ") || "?"}${st.focused ? ` · focused: ${st.focused}` : ""}`;
          try {
            const meta = await studio.rpc<{ placeId: number; gameId: number; scripts: number }>(
              `return { placeId = game.PlaceId, gameId = game.GameId, scripts = #__scripts() }`,
              undefined,
              { studio: a.studio, timeoutMs: 15_000 },
            );
            infoLine += ` · PlaceId: ${meta.placeId} · GameId: ${meta.gameId} · Scripts: ${meta.scripts}`;
          } catch { /* ignore if busy */ }
          lines.push(infoLine);
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
      name: "game_overview",
      description: "One-call architectural overview of the place: PlaceId, services with script/child counts, all Remotes & Bindables, all CollectionService tags, Lighting & StarterPlayer settings.",
      inputSchema: obj({ ...CONTEXT_PROP }),
      async handler(a) {
        const res = await studio.rpc<string>(`
local svcs = { "Workspace", "ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "Teams" }
local svcStats = {}
local remotes = {}
for _, name in svcs do
 local ok, svc = pcall(game.GetService, game, name)
 if ok and svc then
  local sc, ls, ms, ch = 0, 0, 0, #svc:GetChildren()
  for i, d in svc:GetDescendants() do
   if d:IsA("LocalScript") then ls += 1
   elseif d:IsA("Script") then if d.RunContext == Enum.RunContext.Client then ls += 1 else sc += 1 end
   elseif d:IsA("ModuleScript") then ms += 1
   elseif d:IsA("RemoteEvent") or d:IsA("RemoteFunction") or d:IsA("UnreliableRemoteEvent") or d:IsA("BindableEvent") or d:IsA("BindableFunction") then
    table.insert(remotes, table.concat(__segs(d), ".") .. " [" .. d.ClassName .. "]")
   end
   if i % 2000 == 0 then task.wait() end
  end
  table.insert(svcStats, { name = name, children = ch, server = sc, client = ls, modules = ms })
 end
end
local tags = {}
for _, tag in __CS:GetAllTags() do
 table.insert(tags, { tag = tag, count = #__CS:GetTagged(tag) })
end
table.sort(tags, function(a, b) return a.count > b.count end)
local L = game:GetService("Lighting")
local SP = game:GetService("StarterPlayer")
local lighting = { ClockTime = L.ClockTime, Brightness = L.Brightness, Ambient = tostring(L.Ambient), OutdoorAmbient = tostring(L.OutdoorAmbient) }
pcall(function() lighting.Technology = L.Technology.Name end)
local starterPlayer = { WalkSpeed = SP.CharacterWalkSpeed, JumpPower = SP.CharacterJumpPower, UseJumpPower = SP.CharacterUseJumpPower, CameraMode = SP.CameraMode.Name }
return __HS:JSONEncode({ placeId = game.PlaceId, gameId = game.GameId, services = svcStats, remotes = remotes, tags = tags, lighting = lighting, starterPlayer = starterPlayer })`, undefined, { studio: a.studio, context: a.context, timeoutMs: 60_000 });
        const ov = JSON.parse(res);
        const lines = [
          `PlaceId: ${ov.placeId} · GameId: ${ov.gameId}`,
          "",
          "Services:",
          ...ov.services.map((s: any) => `  ${s.name.padEnd(20)} children:${String(s.children).padStart(4)}  scripts(S:${s.server} C:${s.client} M:${s.modules})`),
          "",
          `Remotes & Bindables (${ov.remotes.length}):`,
          ...(ov.remotes.length ? ov.remotes.slice(0, 80).map((r: string) => `  ${r}`) : ["  (none)"]),
          ...(ov.remotes.length > 80 ? [`  … ${ov.remotes.length - 80} more`] : []),
          "",
          `CollectionService Tags (${ov.tags.length}):`,
          ...(ov.tags.length ? ov.tags.slice(0, 40).map((t: any) => `  #${t.tag} (${t.count})`) : ["  (none)"]),
          "",
          `Lighting: ${fmtJson(ov.lighting)}`,
          `StarterPlayer: ${fmtJson(ov.starterPlayer)}`,
        ];
        return lines.join("\n");
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
        if (a.file) code = normalize(await fsp.readFile(path.resolve(a.file), "utf8"));
        if (!code.trim()) throw new Error("Provide 'code' or 'file'.");
        const r = await studio.luau(code, { studio: a.studio, context: a.context, timeoutMs: Math.min(600, a.timeout_s ?? 60) * 1000 });
        return formatLuau(r);
      },
    },
    {
      name: "console",
      description: "Read Studio's Output window. By default returns only lines that are new since your previous console call (tracked per datamodel). Errors are prefixed [E], warnings [W]. Studio plugin noise is hidden by default.",
      inputSchema: obj({
        since: { type: "string", enum: ["last", "all"], description: "last (default): only new lines since the previous call; all: the whole history." },
        level: { type: "string", enum: ["all", "warn", "error"], description: "Minimum level. Default all." },
        filter: { type: "string", description: "Case-insensitive substring, or /regex/." },
        tail: { type: "number", description: "Max lines returned (most recent). Default 200." },
        include_plugin_noise: { type: "boolean", description: "Include errors/warnings from installed Studio plugins. Default false." },
        ...CONTEXT_PROP,
      }),
      async handler(a) {
        let entries = await readConsole({ studio: a.studio, context: a.context, all: a.since === "all" });
        if (!a.include_plugin_noise) entries = stripPluginNoise(entries).clean;
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
      description: "One-shot verification: starts a playtest, optionally waits for player/character spawn, runs optional server and/or client Luau assertions, waits, collects errors/warnings/prints from BOTH Server and Client Output, then stops. Use after changes to verify runtime behaviour.",
      inputSchema: obj({
        code: { type: "string", description: "Optional Luau to run in `context` (default server) once the game is running." },
        context: { type: "string", enum: ["server", "client"], description: "Where to run `code`. Default server." },
        server_code: { type: "string", description: "Optional Luau to run on the Server datamodel." },
        client_code: { type: "string", description: "Optional Luau to run on the Client datamodel." },
        wait_for_player: { type: "boolean", description: "Wait up to 15s for the local Player and Character to spawn before running code. Default false." },
        duration_s: { type: "number", description: "How long to let the game run in total. Default 5, max 120." },
        stop_after: { type: "boolean", description: "Stop the playtest at the end. Default true." },
      }),
      async handler(a) {
        const dur = Math.min(120, Math.max(1, a.duration_s ?? 5)) * 1000;
        const want: DM = a.context === "client" ? "Client" : "Server";
        const t0 = Date.now();
        const pre = await fetchLog({ studio: a.studio }).catch(() => ({ entries: [] as ConsoleEntry[] }));
        const preCursor = diffConsole(pre.entries).cursor;
        await play("start", a.studio);
        const parts: string[] = [];
        let ok = true;
        let allEntries: ConsoleEntry[] = [];
        let ignoredPlugins = 0;

        try {
          const stPlay = await waitFor((s) => s.available.includes(want), a.studio, 30_000).catch(() => undefined);
          // Reset server/client cursors at play start? No, capture everything since play began (all: true on fresh play DM!).
          if (a.wait_for_player) {
            await studio.luau(
              `local P = game:GetService("Players") local t = os.clock() while #P:GetPlayers() == 0 and os.clock() - t < 15 do task.wait(0.1) end local plr = P:GetPlayers()[1] if plr and not plr.Character then local t2 = os.clock() while not plr.Character and os.clock() - t2 < 10 do task.wait(0.1) end end return plr and plr.Name or nil`,
              { studio: a.studio, context: "Server", timeoutMs: 25_000 },
            ).catch(() => {});
          }

          const serverSnippet = a.server_code ?? (want === "Server" ? a.code : undefined);
          const clientSnippet = a.client_code ?? (want === "Client" ? a.code : undefined);

          if (serverSnippet) {
            const r = await studio.luau(serverSnippet, { studio: a.studio, context: "Server", timeoutMs: dur + 60_000 }).catch((e) => ({ ok: false, ms: 0, output: [], dropped: 0, error: e.message, dm: "Server" as DM }));
            if (!r.ok) ok = false;
            parts.push(formatLuau(r as any));
          }
          if (clientSnippet) {
            await waitFor((s) => s.available.includes("Client"), a.studio, 15_000).catch(() => {});
            const r = await studio.luau(clientSnippet, { studio: a.studio, context: "Client", timeoutMs: dur + 60_000 }).catch((e) => ({ ok: false, ms: 0, output: [], dropped: 0, error: e.message, dm: "Client" as DM }));
            if (!r.ok) ok = false;
            parts.push(formatLuau(r as any));
          }

          const left = dur - (Date.now() - t0);
          if (left > 0) await sleep(left);

          const avail = (stPlay ?? (await studio.state(a.studio, true).catch(() => ({ available: [want] as DM[] })))).available;
          const collectFrom: DM[] = avail.includes("Server") && avail.includes("Client") ? ["Server", "Client"] : [want];
          const seenKeys = new Set<string>();
          for (const dm of collectFrom) {
            try {
              const { entries: hist } = await fetchLog({ studio: a.studio, context: dm.toLowerCase() });
              const raw = diffConsole(hist, preCursor).entries.map((e) => (collectFrom.length > 1 ? { ...e, src: dm } : e));
              const stripped = stripPluginNoise(raw);
              ignoredPlugins += stripped.ignored;
              for (const e of stripped.clean) {
                const k = `${e.ts}\u0000${e.t}\u0000${e.m}`;
                if (!seenKeys.has(k)) { seenKeys.add(k); allEntries.push(e); }
              }
            } catch (e: any) {
              parts.push(`(could not read ${dm} console: ${e.message})`);
            }
          }
          allEntries.sort((x, y) => x.ts - y.ts);
        } finally {
          if (a.stop_after !== false) {
            await play("stop", a.studio).catch((e) => parts.push(`(could not stop: ${e.message})`));
          }
        }

        const errs = allEntries.filter((e) => e.t === "MessageError").length;
        const warns = allEntries.filter((e) => e.t === "MessageWarning").length;
        if (errs) ok = false;
        return [
          `${ok ? "✔ PASS" : "✘ FAIL"} · ran ${Math.round((Date.now() - t0) / 1000)}s · ${errs} error(s), ${warns} warning(s)${ignoredPlugins ? ` (+${ignoredPlugins} from Studio plugins, ignored)` : ""}${a.stop_after === false ? " · still playing" : ""}`,
          ...parts,
          "--- console ---",
          formatConsole(allEntries, { tail: 300 }) || "(empty)",
        ].join("\n");
      },
    },
    {
      name: "tree",
      description: "Compact view of the instance hierarchy (Name [Class] (+N hidden children)). With class/name/tag filters, lists matching instances with full ~N-disambiguated paths. Faster and terser than search_game_tree.",
      inputSchema: obj({
        path: { type: "string", description: "Start instance, e.g. Workspace.Map (default: whole game)." },
        depth: { type: "number", description: "Levels to expand. Default 2 (10 with filters)." },
        class: { type: "string", description: "Only instances where IsA(class), e.g. BasePart, BaseScript, GuiObject." },
        name: { type: "string", description: "Only instances whose name contains this (case-insensitive)." },
        tag: { type: "string", description: "Only instances with this CollectionService tag." },
        script_info: { type: "boolean", description: "Annotate scripts with RunContext / Disabled state. Default false." },
        max: { type: "number", description: "Max lines. Default 300." },
        ...CONTEXT_PROP,
      }),
      async handler(a) {
        const filtered = !!(a.class || a.name || a.tag);
        const data = {
          path: a.path ? segsArg(a.path) : null,
          depth: a.depth ?? (filtered ? 10 : 2),
          cls: a.class ?? null,
          name: a.name ? String(a.name).toLowerCase() : null,
          tag: a.tag ?? null,
          sinfo: !!a.script_info,
          max: a.max ?? 300,
          flat: filtered,
        };
        const r = await studio.rpc<any>(`
local root = DATA.path and __need(DATA.path) or game
local lines, count, more, seen = {}, 0, 0, 0
local function kids(x) local ok, c = pcall(x.GetChildren, x) return ok and c or {} end
local function badge(c)
 local b = " [" .. c.ClassName
 if DATA.sinfo and (c:IsA("BaseScript") or c:IsA("ModuleScript")) then
  if c:IsA("Script") then local ok, rc = pcall(function() return c.RunContext.Name end) if ok and rc ~= "Legacy" then b ..= " · " .. rc end end
  if c:IsA("BaseScript") and c.Disabled then b ..= " · Disabled" end
 end
 return b .. "]"
end
local function rec(x, d, ind)
 for _, c in kids(x) do
  seen += 1
  if seen % 3000 == 0 then task.wait() end
  local okn, nm = pcall(function() return c.Name end)
  if okn and not (x == game and __SKIP[nm]) then
   local isMatch = (not DATA.cls or c:IsA(DATA.cls))
    and (not DATA.name or string.find(string.lower(c.Name), DATA.name, 1, true) ~= nil)
    and (not DATA.tag or __CS:HasTag(c, DATA.tag))
   local ch = kids(c)
   if DATA.flat then
    if isMatch then if count < DATA.max then count += 1 table.insert(lines, table.concat(__segs(c), ".") .. badge(c)) else more += 1 end end
    if d < DATA.depth then rec(c, d + 1, ind) end
   elseif not (x == game and #ch == 0) then
    if count < DATA.max then
     count += 1
     table.insert(lines, ind .. __seg(c) .. badge(c) .. ((d >= DATA.depth and #ch > 0) and (" (+" .. #ch .. ")") or ""))
     if d < DATA.depth then rec(c, d + 1, ind .. "  ") end
    else more += 1 end
   end
  end
 end
end
rec(root, 1, "")
if more > 0 then table.insert(lines, "… " .. more .. " more (raise max or narrow path/filters)") end
return (root == game and "game" or table.concat(__segs(root), ".")) .. "\\n" .. table.concat(lines, "\\n")`, data, { studio: a.studio, context: a.context, timeoutMs: 60_000 });
        return r;
      },
    },
    {
      name: "inspect",
      description: "Properties, attributes, CollectionService tags, and children summary of an instance (supports ~N disambiguation, dots in names, and playtest datamodels).",
      inputSchema: obj({
        path: { type: "string" },
        props: { type: "array", items: { type: "string" }, description: "Only return these properties." },
        ...CONTEXT_PROP,
      }, ["path"]),
      async handler(a) {
        const segs = segsArg(a.path);
        const hasSpecial = segs.some((s) => s.includes(".") || /~\d+$/.test(s));
        const dm = await studio.pickDM(a.studio, a.context);

        // If in Edit mode with a plain dot-path, enrich upstream inspect_instance with CollectionService tags.
        if (dm === "Edit" && !hasSpecial) {
          const r = await studio.raw("inspect_instance", { path: "game." + segs.join(".") }, a.studio);
          if (!r.isError) {
            try {
              const j = JSON.parse(textOf(r));
              const tags = await studio.rpc<string[]>(`local x = __find(DATA) return x and __CS:GetTags(x) or {}`, segs, { studio: a.studio, context: "edit" }).catch(() => []);
              const pick = (x: any) => ({
                ...x,
                ...(tags?.length ? { tags } : {}),
                properties: a.props?.length
                  ? Object.fromEntries(Object.entries(x.properties ?? {}).filter(([k]) => a.props.some((p: string) => k === p || k.startsWith(p + "."))))
                  : x.properties,
              });
              return fmtJson(j.matches ? { ...j, matches: j.matches.map(pick) } : pick(j));
            } catch { /* fall through to Luau inspector */ }
          }
        }

        // Luau inspector: works in Server/Client playtest and with ~N / dot-in-name paths.
        const out = await studio.rpc<string>(`
local inst = __need(DATA.segs)
local props = {}
local candidates = DATA.props or {
 "Name","Parent","Archivable","Anchored","CanCollide","CanTouch","CanQuery","CastShadow","Massless",
 "Size","Position","Orientation","CFrame","Color","BrickColor","Material","Transparency","Reflectance","Shape",
 "Enabled","Disabled","RunContext","Value","Text","TextColor3","BackgroundColor3","BackgroundTransparency",
 "Visible","ZIndex","LayoutOrder","Active","Image","ImageColor3","ImageTransparency",
 "Volume","Playing","Looped","SoundId","MaxHealth","Health","WalkSpeed","JumpPower"
}
for _, k in candidates do
 local ok, v = pcall(function() return inst[k] end)
 if ok and v ~= nil then props[k] = __ser(v, 0, {}) end
end
local kids = {}
for i, c in inst:GetChildren() do
 if i > 50 then break end
 table.insert(kids, { name = __seg(c), className = c.ClassName, path = table.concat(__segs(c), ".") })
end
local attrs = {}
for k, v in inst:GetAttributes() do attrs[k] = __ser(v, 0, {}) end
return __HS:JSONEncode({
 name = inst.Name,
 className = inst.ClassName,
 path = table.concat(__segs(inst), "."),
 tags = __CS:GetTags(inst),
 properties = props,
 attributes = attrs,
 children = { immediateChildren = kids, childrenCount = #inst:GetChildren(), totalDescendants = #inst:GetDescendants() }
})`, { segs, props: a.props?.length ? a.props : null }, { studio: a.studio, context: dm });
        return fmtJson(JSON.parse(out));
      },
    },
    {
      name: "set_props",
      description: 'Set properties, attributes, and/or CollectionService tags on one instance (`path`), several (`paths`), or all instances with a `tag`. Supports: Size:[2,3,4], Color:[255,0,0] or "#ff0000", Material:"Neon", CFrame:[x,y,z] or [x,y,z,rx,ry,rz] (deg), UDim2:[xs,xo,ys,yo], Rect:[x0,y0,x1,y1], ColorSequence:["#f00","#00f"], NumberSequence:[0,1], Font:"GothamBold", PhysicalProperties:[d,f,e], {"Enum":"Material.Neon"}, {"ref":"Workspace.Other"}, {"nil":true}. Undoable.',
      inputSchema: obj({
        path: { type: "string", description: "Single target instance path." },
        paths: { type: "array", items: { type: "string" }, description: "Multiple target instance paths." },
        tag: { type: "string", description: "Update every instance having this CollectionService tag." },
        props: { type: "object" },
        attributes: { type: "object" },
        tags: { description: 'Array of tags to add, or {"add":[...], "remove":[...]}.' },
      }),
      async handler(a) {
        if (!a.path && !a.paths?.length && !a.tag) throw new Error("Provide 'path', 'paths', or 'tag'.");
        const r = await studio.rpc(`${VALUE_LUA}
local targets = {}
if DATA.path then table.insert(targets, __need(DATA.path)) end
for _, p in DATA.paths or {} do table.insert(targets, __need(p)) end
if DATA.tag then for _, x in __CS:GetTagged(DATA.tag) do table.insert(targets, x) end end
if #targets == 1 and DATA.path and not DATA.paths and not DATA.tag then
 return __apply(targets[1], DATA.props, DATA.attrs, DATA.tags)
end
local out = {}
for i, inst in targets do
 out[__p(inst)] = __apply(inst, DATA.props, DATA.attrs, DATA.tags)
 if i % 50 == 0 then task.wait() end
end
return { count = #targets, results = out }`, {
          path: a.path ? segsArg(a.path) : null,
          paths: a.paths?.length ? a.paths.map(segsArg) : null,
          tag: a.tag ?? null,
          props: prepValues(a.props ?? {}),
          attrs: prepValues(a.attributes ?? {}),
          tags: a.tags ?? null,
        }, { studio: a.studio, context: "edit" });
        return fmtJson(r);
      },
    },
    {
      name: "instance",
      description: "Create (with optional recursive `children` tree & `tags`), delete, move (reparent), clone or rename instances. Undoable. For scripts prefer script_write or file sync.",
      inputSchema: obj({
        op: { type: "string", enum: ["create", "delete", "move", "clone", "rename"] },
        path: { type: "string", description: "Target instance (delete/move/clone/rename)." },
        class: { type: "string", description: "create: ClassName, e.g. Part, Folder, RemoteEvent, ScreenGui." },
        parent: { type: "string", description: "create: parent path. move/clone: new parent." },
        name: { type: "string", description: "create/clone/rename: new name." },
        props: { type: "object", description: "create/clone: properties to set (same value format as set_props)." },
        attributes: { type: "object" },
        tags: { type: "array", items: { type: "string" }, description: "CollectionService tags to add on create/clone." },
        children: {
          type: "array",
          description: "create: optional nested child specs { class, name?, props?, attributes?, tags?, children? } built in one atomic call.",
          items: { type: "object" },
        },
      }, ["op"]),
      async handler(a) {
        const data = {
          op: a.op,
          path: a.path ? segsArg(a.path) : null,
          parent: a.parent ? (splitPath(a.parent).length ? splitPath(a.parent) : []) : null,
          cls: a.class ?? null,
          name: a.name ?? null,
          props: prepValues(a.props ?? {}),
          attrs: prepValues(a.attributes ?? {}),
          tags: Array.isArray(a.tags) ? a.tags : null,
          children: Array.isArray(a.children) ? a.children.map(prepTree) : null,
        };
        const r = await studio.rpc(`${VALUE_LUA}
local op = DATA.op
local function parentOf() if not DATA.parent then error("parent is required", 0) end return #DATA.parent == 0 and game or __need(DATA.parent) end
local function buildNode(spec, par)
 if not spec.cls then error("class is required", 0) end
 local x = Instance.new(spec.cls)
 if spec.name then x.Name = spec.name end
 local res = __apply(x, spec.props, spec.attrs, spec.tags)
 local kidsCount = 0
 for _, ch in spec.children or {} do
  local built = buildNode(ch, x)
  kidsCount += 1 + built.kids
 end
 x.Parent = par
 return { node = x, res = res, kids = kidsCount }
end
if op == "create" then
 local built = buildNode({ cls = DATA.cls, name = DATA.name, props = DATA.props, attrs = DATA.attrs, tags = DATA.tags, children = DATA.children }, parentOf())
 return { created = __p(built.node), childrenCreated = built.kids, props = built.res }
end
local inst = __need(DATA.path or error("path is required", 0))
if op == "delete" then local p = __p(inst) inst.Parent = nil return { deleted = p, note = "undoable with history action=undo" } end
if op == "move" then inst.Parent = parentOf() return { moved = __p(inst) } end
if op == "rename" then inst.Name = DATA.name or error("name is required", 0) return { renamed = __p(inst) } end
if op == "clone" then
 local c = inst:Clone()
 if not c then error("instance is not Archivable", 0) end
 if DATA.name then c.Name = DATA.name end
 local res = __apply(c, DATA.props, DATA.attrs, DATA.tags)
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
      inputSchema: obj({
        path: { type: "string" },
        source: { type: "string" },
        class: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Class when creating. Default ModuleScript." },
        run_context: { type: "string", enum: ["Legacy", "Server", "Client"], description: "Optional RunContext when creating a Script." },
      }, ["path", "source"]),
      async handler(a) {
        const r = await studio.rpc<any[]>(PUSH_LUA_FOR_TOOLS, [{ s: segsArg(a.path), src: normalize(String(a.source)), create: true, cls: a.class ?? "ModuleScript", rc: a.run_context, force: true }], { studio: a.studio, context: "edit" });
        const st = r?.[0]?.st;
        return st === "created" ? `Created ${a.path} (${a.class ?? "ModuleScript"}).` : st === "ok" ? `Updated ${a.path}.` : `Failed: ${fmtJson(r)}`;
      },
    },
    {
      name: "script_edit",
      description: "Exact search/replace edits in one script (atomic, supports ~N & dots in names). Each `old` must match exactly once unless all=true. Undoable.",
      inputSchema: obj({
        path: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["old", "new"] } },
      }, ["path", "edits"]),
      async handler(a) {
        const segs = segsArg(a.path);
        const edits = (a.edits ?? []).map((e: any) => ({ old: normalize(String(e.old)), new: normalize(String(e.new)), all: !!e.all }));
        if (!edits.length) throw new Error("Provide at least one edit.");
        const src: string = await studio.rpc(`local s = __need(DATA) if not s:IsA("LuaSourceContainer") then error(s:GetFullName() .. " is a " .. s.ClassName .. ", not a script", 0) end return __src(s)`, segs, { studio: a.studio, context: "edit" });

        let cur = normalize(src);
        const summary: string[] = [];
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          if (!e.old) throw new Error(`Edit #${i + 1}: 'old' cannot be empty.`);
          if (e.old === e.new) throw new Error(`Edit #${i + 1}: 'old' and 'new' are identical.`);
          const parts = cur.split(e.old);
          const count = parts.length - 1;
          if (count === 0) throw new Error(`Edit #${i + 1}: 'old' text not found in ${a.path}.`);
          if (count > 1 && !e.all) throw new Error(`Edit #${i + 1}: 'old' matched ${count} times in ${a.path}. Include more context or pass all: true.`);
          const firstIdx = cur.indexOf(e.old);
          const line = cur.slice(0, firstIdx).split("\n").length;
          cur = e.all ? parts.join(e.new) : parts[0] + e.new + parts.slice(1).join(e.old);
          summary.push(`edit #${i + 1}: replaced ${e.all ? count : 1} occurrence(s) starting at line ${line}`);
        }
        await studio.rpc(`local s = __need(DATA.s) __setsrc(s, DATA.src) return true`, { s: segs, src: cur }, { studio: a.studio, context: "edit" });
        return `Updated ${a.path}:\n  ${summary.join("\n  ")}`;
      },
    },
    {
      name: "script_grep",
      description: "Search across all scripts in Studio (or under `paths`) for a substring or /regex/. Returns ~N-safe paths, line numbers, and matching lines.",
      inputSchema: obj({
        query: { type: "string", description: "Substring or /regex/flags." },
        paths: { type: "array", items: { type: "string" }, description: "Only search scripts under these instance paths." },
        max: { type: "number", description: "Max matches returned. Default 100." },
      }, ["query"]),
      async handler(a) {
        const m = String(a.query).match(/^\/(.*)\/([a-z]*)$/);
        const re = m ? new RegExp(m[1], m[2].replace(/g/g, "")) : new RegExp(String(a.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const prefixes = (a.paths ?? []).map(segsArg);
        const raw = await studio.rpc<string>(`
local out = {}
for i, s in __scripts() do
 local p = __segs(s)
 local okp = #DATA == 0
 for _, pre in DATA do local m = true for k, v in pre do if p[k] ~= v then m = false break end end if m then okp = true break end end
 if okp then table.insert(out, { p = table.concat(p, "."), src = __src(s) }) end
 if i % 40 == 0 then task.wait() end
end
return __HS:JSONEncode(out)`, prefixes, { studio: a.studio, context: "edit", timeoutMs: 120_000 });
        const scripts = JSON.parse(raw || "[]") as { p: string; src: string }[];
        const max = a.max ?? 100;
        const hits: string[] = [];
        let total = 0;
        for (const sc of scripts) {
          const lines = sc.src.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              total++;
              if (hits.length < max) hits.push(`${sc.p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        }
        if (!hits.length) return `No matches for ${a.query} across ${scripts.length} script(s).`;
        return `${total} match(es) across ${scripts.length} script(s)${total > max ? ` (showing first ${max})` : ""}:\n${hits.join("\n")}`;
      },
    },
    {
      name: "script_check",
      description: "Compile every script (or those under given paths) for syntax errors AND statically check require() cycles, broken require() paths, and GetService() typos. Optionally runs local luau-analyze/selene if synced.",
      inputSchema: obj({
        paths: { type: "array", items: { type: "string" }, description: "Only scripts under these instance paths." },
        mode: { type: "string", enum: ["full", "syntax"], description: "full (default): syntax + require/GetService static checks; syntax: syntax only." },
        dir: { type: "string", description: "Optional local sync directory for luau-analyze / selene checks." },
      }),
      async handler(a) {
        const mode = a.mode ?? "full";
        const prefixes = (a.paths ?? []).map(segsArg);
        const raw = await studio.rpc<string>(`
local syntaxErrs, scripts = {}, {}
for i, s in __scripts() do
 local p = __segs(s)
 local okp = #DATA.pre == 0
 for _, pre in DATA.pre do local m = true for k, v in pre do if p[k] ~= v then m = false break end end if m then okp = true break end end
 if okp then
  local src = __src(s)
  local f, e = loadstring(src, "=" .. table.concat(p, "."))
  if not f then table.insert(syntaxErrs, e) end
  if DATA.full then table.insert(scripts, { segs = p, cls = s.ClassName, source = src }) end
 end
 if i % 40 == 0 then task.wait() end
end
return __HS:JSONEncode({ syntax = syntaxErrs, scripts = scripts })`, { pre: prefixes, full: mode === "full" }, { studio: a.studio, context: "edit", timeoutMs: 120_000 });
        const parsed = JSON.parse(raw || "{}") as { syntax: string[]; scripts: { segs: string[]; cls: string; source: string }[] };
        const syntaxErrs = parsed.syntax ?? [];
        const lines: string[] = [];

        if (syntaxErrs.length) lines.push(`✘ ${syntaxErrs.length} script(s) with syntax errors:\n${syntaxErrs.join("\n")}`);
        else lines.push(`✔ All ${parsed.scripts?.length ?? ""} scripts compile cleanly.`);

        if (mode === "full" && parsed.scripts?.length) {
          const diags = analyzeScripts(parsed.scripts);
          if (diags.length) {
            lines.push("", `⚠ ${diags.length} static issue(s):`, ...diags.slice(0, 60).map((d) => `  [${d.kind}] ${d.script}:${d.line}: ${d.message}`));
            if (diags.length > 60) lines.push(`  … ${diags.length - 60} more`);
          }
        }

        if (a.dir) {
          const ext = await runExternalAnalyzers(sync.resolveDir(a.dir), path.resolve("sourcemap.json"));
          if (ext.length) lines.push("", ...ext);
        }
        return lines.join("\n");
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
for _, x in S:Get() do table.insert(out, table.concat(__segs(x), ".") .. " [" .. x.ClassName .. "]") end
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
        sourcemap: { type: "boolean", description: "Also generate Rojo-compatible sourcemap.json for Luau LSP / luau-analyze." },
      }),
      async handler(a) { return (await sync.pull(a)).lines.join("\n"); },
    },
    {
      name: "sync_push",
      description: "Send locally edited/new script files to Studio. Refuses to overwrite scripts that were also changed in Studio since the last sync (conflict) unless force. New files are created (class from suffix, optional `--!runcontext client|server`). Deleted files are only deleted in Studio with delete_missing.",
      inputSchema: obj({
        dir: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Only these files (relative to dir)." },
        force: { type: "boolean" },
        dry_run: { type: "boolean", description: "Only list what would be pushed." },
        delete_missing: { type: "boolean", description: "Delete in Studio the scripts whose files were deleted locally." },
        sourcemap: { type: "boolean", description: "Update sourcemap.json after pushing." },
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
      inputSchema: obj({
        on: { type: "boolean" },
        dir: { type: "string" },
        interval_s: { type: "number", description: "Studio polling interval. Default 3." },
        sourcemap: { type: "boolean", description: "Update sourcemap.json on pull/push." },
      }, ["on"]),
      async handler(a) { return sync.watch(a as any); },
    },
    {
      name: "sync_sourcemap",
      description: "Generate a Rojo-compatible sourcemap.json (and optional .luaurc) from Studio so Luau LSP, luau-analyze, and coding agents resolve require() paths and instances.",
      inputSchema: obj({
        dir: { type: "string", description: "Synced scripts folder. Default ./roblox-src." },
        out: { type: "string", description: "Output path. Default ./sourcemap.json." },
        max_depth: { type: "number", description: "Instance hierarchy depth. Default 6." },
        luaurc: { type: "boolean", description: "Create .luaurc if missing. Default false." },
      }),
      async handler(a) {
        const r = await sync.sourcemap(a);
        return `Generated ${r.outFile} (${r.nodes} nodes, ${r.scriptsMapped} scripts mapped${r.luaurcCreated ? ", created .luaurc" : ""}).`;
      },
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
