// Luau code generation: output capture wrapper, safe serializer, paging, helpers.
// The prelude is emitted on ONE line so user code keeps its own line numbers.

export const PAGE_BYTES = 60_000; // upstream truncates tool output at ~100k chars
export const MAX_LINES = 2000;

const PRELUDE = `
local __HS = game:GetService("HttpService")
local __out, __cnt, __t0 = {}, 0, os.clock()
local __rp, __rw = print, warn
local __G = _G.__rbxplus or { pages = {}, pageOrder = {}, up = {}, seq = 0 }
_G.__rbxplus = __G
__G.pageOrder = __G.pageOrder or {}
local function __fmt(...) local t = table.pack(...) for i = 1, t.n do t[i] = tostring(t[i]) end return table.concat(t, " ") end
local function print(...) __cnt += 1 if __cnt <= ${MAX_LINES} then table.insert(__out, __fmt(...)) end __rp(...) end
local function warn(...) __cnt += 1 if __cnt <= ${MAX_LINES} then table.insert(__out, "[warn] " .. __fmt(...)) end __rw(...) end
local function __ser(v, d, seen)
 local tv = typeof(v)
 if tv == "number" then if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end return v end
 if tv == "boolean" or tv == "string" or tv == "nil" then return v end
 if tv == "Instance" then return "<" .. v.ClassName .. "> " .. v:GetFullName() end
 if tv == "EnumItem" then return tostring(v) end
 if tv == "buffer" then return "buffer(" .. buffer.len(v) .. " bytes)" end
 if tv == "table" then
  if seen[v] then return "<cycle>" end
  if d > 6 then return "<table>" end
  seen[v] = true
  local n, isArr = 0, true
  for k in v do n += 1 if typeof(k) ~= "number" or k ~= math.floor(k) or k < 1 then isArr = false end end
  if isArr and n ~= #v then isArr = false end
  local o, i = {}, 0
  for k, x in v do
   i += 1
   if i > 300 then if isArr then table.insert(o, "<" .. (n - 300) .. " more>") else o["…"] = "<" .. (n - 300) .. " more>" end break end
   if isArr then o[k] = __ser(x, d + 1, seen) else o[tostring(k)] = __ser(x, d + 1, seen) end
  end
  seen[v] = nil
  return o
 end
 return tv .. "(" .. tostring(v) .. ")"
end
local function __cut(s, a) local e = math.min(#s, a + ${PAGE_BYTES - 1}) while e < #s and e > a do local b = string.byte(s, e + 1) if b >= 128 and b < 192 then e -= 1 else break end end return e end
__G.cut = __cut
local function __emit(s)
 if #s <= ${PAGE_BYTES} then return s end
 __G.seq += 1
 local id = tostring(__G.seq)
 __G.pages[id] = s
 table.insert(__G.pageOrder, id)
 while #__G.pageOrder > 12 do local old = table.remove(__G.pageOrder, 1) if old then __G.pages[old] = nil end end
 local e = __cut(s, 1)
 return "@@PAGE " .. id .. " " .. #s .. " " .. e .. "\\n" .. string.sub(s, 1, e)
end
`;

// Helpers for internal tools (not needed by user code, but harmless).
const LIB = `
local function __fnv(s)
 local h = 2166136261
 local b = buffer.fromstring(s)
 for i = 0, buffer.len(b) - 1 do
  h = bit32.bxor(h, buffer.readu8(b, i))
  h = (h * 403 + bit32.lshift(h, 24)) % 4294967296
  if i % 400000 == 399999 then task.wait() end
 end
 return #s .. ":" .. string.format("%08x", h)
end
local function __seg(inst)
 local p = inst.Parent
 if not p or p == game then return inst.Name end
 local same, idx = 0, 0
 for _, c in p:GetChildren() do if c.Name == inst.Name then same += 1 if c == inst then idx = same end end end
 if same > 1 then return inst.Name .. "~" .. idx end
 return inst.Name
end
local function __segs(inst) local t = {} local x = inst while x and x ~= game do table.insert(t, 1, __seg(x)) x = x.Parent end return t end
local function __find(segs0)
 local x = game
 local segs = table.clone(segs0)
 local i = 0
 while i < #segs do
  i += 1
  local s = segs[i]
  local m, cnt = nil, 0
  for _, c in x:GetChildren() do if c.Name == s then cnt += 1 m = c end end
  if cnt ~= 1 then
   m = nil
   local base, k = string.match(s, "^(.*)~(%d+)$")
   if base then local i = 0 for _, c in x:GetChildren() do if c.Name == base then i += 1 if i == tonumber(k) then m = c break end end end end
   if not m and cnt > 1 then return nil, "ambiguous: " .. cnt .. " children named '" .. s .. "' under " .. x:GetFullName() .. " (use '" .. s .. "~N' to pick the Nth)" end
  end
  if not m and cnt == 0 and string.find(s, ".", 1, true) then
   local parts = string.split(s, ".")
   table.remove(segs, i)
   for k = #parts, 1, -1 do table.insert(segs, i, parts[k]) end
   i -= 1
   m = x
  end
  if not m then
   local near = {}
   for _, c in x:GetChildren() do if #near < 8 and string.find(string.lower(c.Name), string.lower(string.sub(s, 1, 3)), 1, true) then table.insert(near, c.Name) end end
   return nil, "not found: '" .. s .. "' under " .. (x == game and "game" or x:GetFullName()) .. (#near > 0 and (" (similar: " .. table.concat(near, ", ") .. ")") or "")
  end
  x = m
 end
 return x
end
local function __need(segs) local x, e = __find(segs) if not x then error(e, 0) end return x end
local __SKIP = { CoreGui = true, CorePackages = true, RobloxPluginGuiService = true, PluginGuiService = true, PluginDebugService = true, RobloxReplicatedStorage = true, Visit = true, StudioData = true, MemStorageService = true, DebuggerManager = true, StylingService = true, VisualizationModeService = true, ScriptEditorService = true, NetworkClient = true, InsertService = true, GuiService = true, Stats = true, ControllerService = true }
local function __scripts()
 local list = {}
 for _, svc in game:GetChildren() do
  local okn, nm = pcall(function() return svc.Name end)
  if okn and not __SKIP[nm] then
   local ok2, desc = pcall(svc.GetDescendants, svc)
   if ok2 then for _, d in desc do if (d:IsA("BaseScript") or d:IsA("ModuleScript")) then table.insert(list, d) end end end
  end
 end
 return list
end
local __SES = game:GetService("ScriptEditorService")
local __CS = game:GetService("CollectionService")
local function __src(s) local ok, r = pcall(__SES.GetEditorSource, __SES, s) if ok and r then return r end return s.Source end
local function __setsrc(s, src)
 local ok = pcall(function() __SES:UpdateSourceAsync(s, function() return src end) end)
 if not ok then s.Source = src end
end
local function __data(id) local d = __G.up[id] __G.up[id] = nil return __HS:JSONDecode(table.concat(d)) end
`;

/** Luau helper converting JSON-friendly values into Roblox datatypes and applying props/attributes/tags. */
export const VALUE_LUA = `
local function __color3(v)
 if type(v) == "string" then
  if string.sub(v, 1, 1) == "#" then return Color3.fromHex(v) end
  return BrickColor.new(v).Color
 end
 if type(v) == "table" then
  if v.hex then return Color3.fromHex(v.hex) end
  if v.rgb then return Color3.fromRGB(v.rgb[1] or 0, v.rgb[2] or 0, v.rgb[3] or 0) end
  if v.Color3 then return Color3.new(v.Color3[1] or 0, v.Color3[2] or 0, v.Color3[3] or 0) end
  local r, g, b = v[1] or 0, v[2] or 0, v[3] or 0
  if r > 1 or g > 1 or b > 1 then return Color3.fromRGB(r, g, b) end
  return Color3.new(r, g, b)
 end
 error("invalid Color3", 0)
end
local function __val(v, cur)
 local tc = typeof(cur)
 local function n(t, i) return t[i] or 0 end
 if type(v) == "string" then
  if tc == "EnumItem" then local nm = string.match(v, "([^.]+)$") return cur.EnumType[nm] end
  if tc == "BrickColor" then return BrickColor.new(v) end
  if tc == "Color3" then return __color3(v) end
  if tc == "Font" then local ok, f = pcall(Font.fromEnum, Enum.Font[v]) if ok then return f end return Font.new(v) end
  return v
 end
 if type(v) ~= "table" then
  if tc == "NumberRange" and type(v) == "number" then return NumberRange.new(v, v) end
  if tc == "NumberSequence" and type(v) == "number" then return NumberSequence.new(v) end
  return v
 end
 if #v > 0 then
  if tc == "Vector3" then return Vector3.new(n(v,1), n(v,2), n(v,3)) end
  if tc == "Vector2" then return Vector2.new(n(v,1), n(v,2)) end
  if tc == "Color3" then return __color3(v) end
  if tc == "CFrame" then v = { CFrame = v } end
  if tc == "UDim2" then return UDim2.new(n(v,1), n(v,2), n(v,3), n(v,4)) end
  if tc == "UDim" then return UDim.new(n(v,1), n(v,2)) end
  if tc == "NumberRange" then return NumberRange.new(n(v,1), v[2] or n(v,1)) end
  if tc == "Rect" then return Rect.new(n(v,1), n(v,2), n(v,3), n(v,4)) end
  if tc == "PhysicalProperties" then return PhysicalProperties.new(n(v,1), n(v,2), n(v,3), v[4] or 1, v[5] or 1) end
  if tc == "ColorSequence" then
   if type(v[1]) == "string" or (type(v[1]) == "table" and not v[1].color) then
    if #v == 1 then return ColorSequence.new(__color3(v[1])) end
    local kps = {}
    for i, c in v do table.insert(kps, ColorSequenceKeypoint.new((i - 1) / (#v - 1), __color3(c))) end
    return ColorSequence.new(kps)
   end
   local kps = {}
   for _, kp in v do table.insert(kps, ColorSequenceKeypoint.new(kp.t or kp.time or 0, __color3(kp.color or kp.c or kp.value))) end
   return ColorSequence.new(kps)
  end
  if tc == "NumberSequence" then
   if type(v[1]) == "number" then
    if #v == 1 then return NumberSequence.new(v[1]) end
    local kps = {}
    for i, num in v do table.insert(kps, NumberSequenceKeypoint.new((i - 1) / (#v - 1), num)) end
    return NumberSequence.new(kps)
   end
   local kps = {}
   for _, kp in v do table.insert(kps, NumberSequenceKeypoint.new(kp.t or kp.time or 0, kp.v or kp.value or 0, kp.env or kp.envelope or 0)) end
   return NumberSequence.new(kps)
  end
  if tc == "Faces" then local args = {} for _, f in v do table.insert(args, Enum.NormalId[f]) end return Faces.new(table.unpack(args)) end
  if tc == "Axes" then local args = {} for _, a in v do table.insert(args, Enum.Axis[a]) end return Axes.new(table.unpack(args)) end
 end
 if v.Vector3 then local t = v.Vector3 return Vector3.new(n(t,1), n(t,2), n(t,3)) end
 if v.Vector2 then local t = v.Vector2 return Vector2.new(n(t,1), n(t,2)) end
 if v.Color3 or v.rgb or v.hex then return __color3(v) end
 if v.CFrame then local t = v.CFrame
  if #t == 6 then return CFrame.new(t[1], t[2], t[3]) * CFrame.Angles(math.rad(t[4]), math.rad(t[5]), math.rad(t[6])) end
  return CFrame.new(table.unpack(t)) end
 if v.UDim2 then local t = v.UDim2 return UDim2.new(n(t,1), n(t,2), n(t,3), n(t,4)) end
 if v.UDim then local t = v.UDim return UDim.new(n(t,1), n(t,2)) end
 if v.NumberRange then local t = v.NumberRange return NumberRange.new(n(t,1), t[2] or n(t,1)) end
 if v.Rect then local t = v.Rect return Rect.new(n(t,1), n(t,2), n(t,3), n(t,4)) end
 if v.ColorSequence then return __val(v.ColorSequence, ColorSequence.new(Color3.new())) end
 if v.NumberSequence then return __val(v.NumberSequence, NumberSequence.new(0)) end
 if v.Font then local t = v.Font
  if type(t) == "string" then local ok, f = pcall(Font.fromEnum, Enum.Font[t]) return ok and f or Font.new(t) end
  return Font.new(t.family or "rbxasset://fonts/families/SourceSansPro.json", t.weight and Enum.FontWeight[t.weight] or Enum.FontWeight.Regular, t.style and Enum.FontStyle[t.style] or Enum.FontStyle.Normal) end
 if v.PhysicalProperties then local t = v.PhysicalProperties return PhysicalProperties.new(n(t,1), n(t,2), n(t,3), t[4] or 1, t[5] or 1) end
 if v.Enum then local a, b = string.match(v.Enum, "^([^.]+)%.(.+)$") return Enum[a][b] end
 if v.BrickColor then return BrickColor.new(v.BrickColor) end
 if v.ref then return __need(v.ref) end
 if v.nil_ then return nil end
 error("unsupported value " .. __HS:JSONEncode(v), 0)
end
local function __apply(inst, props, attrs, tags)
 local res = {}
 for k, v in props or {} do
  local ok, e = pcall(function() local cur = nil pcall(function() cur = inst[k] end) inst[k] = __val(v, cur) end)
  res[k] = ok and "ok" or tostring(e)
 end
 for k, v in attrs or {} do
  local ok, e = pcall(function() inst:SetAttribute(k, __val(v, inst:GetAttribute(k))) end)
  res["@" .. k] = ok and "ok" or tostring(e)
 end
 if tags then
  if #tags > 0 then
   for _, t in tags do __CS:AddTag(inst, t) res["#" .. t] = "added" end
  else
   for _, t in tags.add or {} do __CS:AddTag(inst, t) res["#" .. t] = "added" end
   for _, t in tags.remove or {} do __CS:RemoveTag(inst, t) res["#" .. t] = "removed" end
  end
 end
 return res
end
local function __p(i) return table.concat(__segs(i), ".") end
`;

const oneLine = (s: string) => s.trim().split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
const PRELUDE_1 = oneLine(PRELUDE);
const LIB_1 = oneLine(LIB);

/** Wrap user/internal code: captures print/warn, catches errors, serializes return values, pages big output. */
export function wrap(code: string, opts: { lib?: boolean; header?: string } = {}): string {
  const head = PRELUDE_1 + (opts.lib ? " " + LIB_1 : "") + (opts.header ? " " + oneLine(opts.header) : "");
  return `${head} local function __user(...) ${code}
end
local __r = table.pack(xpcall(__user, function(e) return debug.traceback(tostring(e), 2) end))
local __res = { ok = __r[1], ms = math.floor((os.clock() - __t0) * 1000), output = __out, dropped = math.max(0, __cnt - ${MAX_LINES}) }
if __r[1] then
 if __r.n == 2 then __res.result = __ser(__r[2], 0, {}) elseif __r.n > 2 then local a = {} for i = 2, __r.n do a[i - 1] = __ser(__r[i], 0, {}) end __res.result = a end
else __res.error = tostring(__r[2]) end
local __okj, __j = pcall(__HS.JSONEncode, __HS, __res)
if not __okj then __res.result = "<unencodable result: " .. tostring(__j) .. ">" __j = __HS:JSONEncode(__res) end
return __emit(__j)
`;
}

/** Code to fetch the next page of a paged result. */
export function pageCode(id: string, from: number): string {
  return `local G = _G.__rbxplus local s = G and G.pages[${JSON.stringify(id)}] if not s then return "@@GONE" end local e = G.cut(s, ${from}) if e >= #s then G.pages[${JSON.stringify(id)}] = nil end return e .. "\\n" .. string.sub(s, ${from}, e)`;
}

/** Code to append a piece to an upload buffer. */
export function uploadCode(id: string, piece: string, first: boolean): string {
  return `local G = _G.__rbxplus or { pages = {}, up = {}, seq = 0 } _G.__rbxplus = G ${first ? `G.up[${JSON.stringify(id)}] = {}` : ""} table.insert(G.up[${JSON.stringify(id)}], ${longString(piece)}) return "ok"`;
}

/** Lua long-bracket string literal that reproduces `s` exactly (s must contain no \r). */
export function longString(s: string): string {
  let level = 0;
  // The first closing bracket must be the one we append (content ending in "]" would close early).
  const ok = (l: number) => { const c = "]" + "=".repeat(l) + "]"; return (s + c).indexOf(c) === s.length; };
  while (!ok(level)) level++;
  const eq = "=".repeat(level);
  // A newline directly after the opening bracket is skipped by the lexer, so always add one.
  return `[${eq}[\n${s}]${eq}]`;
}

/** Luau expression evaluating to a JSON-decoded value (data embedded as a JSON long string). */
export function jsonExpr(v: unknown): string {
  return `__HS:JSONDecode(${longString(JSON.stringify(v))})`;
}

/** Same FNV-1a 32 hash as Luau's __fnv, over UTF-8 bytes; returns "len:hex". */
export function fnv(s: string | Buffer): string {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
  return `${b.length}:${h.toString(16).padStart(8, "0")}`;
}

/** Make Studio's error text readable: strip internal plugin paths, map chunk lines. */
export function cleanError(msg: string): string {
  return msg.replace(/^Error:\s*/, "")
    .split("\n")
    // "sabuiltin_…ExecuteLuauTool:125: sabuiltin_…:54: real message" → "real message"
    .map((l) => l.replace(/^.*sabuiltin_\S*:\d+:\s*/, "").replace(/AssistantCommand:(\d+):?/g, "line $1:"))
    .filter((l) => !/sabuiltin_|^\s*$|^Stack Begin|^Stack End|^line \d+:\s*$|^line \d+: function __\w+$/.test(l))
    .join("\n")
    .replace(/(lacking capability \w+\)?)/, "$1 — Studio's MCP sandbox can't access this member; wrap it in pcall or skip it")
    .trim();
}

/** Split an instance path given by an agent into segments. Accepts "game.A.B", "A.B", "A/B". */
export function splitPath(p: string): string[] {
  const s = p.trim();
  const parts = (s.includes("/") ? s.split("/") : s.split(".")).map((x) => x.trim()).filter(Boolean);
  if (parts[0]?.toLowerCase() === "game") parts.shift();
  return parts;
}
