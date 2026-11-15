import { test } from "node:test";
import assert from "node:assert/strict";
import { longString, fnv, cleanError, splitPath, wrap } from "../src/luau.js";
import { encodeSeg, decodeSeg, mapScripts, fileToTarget, underPrefix, isIgnored } from "../src/sync/mapping.js";
import { decidePull, parseRunContextHint } from "../src/sync/engine.js";
import { buildSourcemap } from "../src/sync/sourcemap.js";
import { diffConsole, formatConsole, stripPluginNoise } from "../src/console.js";
import { parseState } from "../src/studio.js";
import { removeTomlTable, tomlString } from "../src/cli.js";
import { analyzeScripts } from "../src/analysis.js";

/** Minimal Lua long-string parser to check round-trips. */
function parseLong(lit: string): string {
  const m = lit.match(/^\[(=*)\[/)!;
  const close = "]" + m[1] + "]";
  let body = lit.slice(m[0].length);
  if (body.startsWith("\n")) body = body.slice(1);
  const end = body.indexOf(close);
  assert.equal(end, body.length - close.length, "closing bracket must be the last one");
  return body.slice(0, end);
}

test("longString round-trips tricky content", () => {
  for (const s of ["", "a", "]]", "x]", "]=]", "a]==]b]]", "\nlead", "[[nested]]", '["a","b"]', "é]"]) assert.equal(parseLong(longString(s)), s, JSON.stringify(s));
});

test("fnv matches known FNV-1a values with length prefix", () => {
  assert.equal(fnv(""), "0:811c9dc5");
  assert.equal(fnv("a"), "1:e40c292c");
  assert.equal(fnv("é").split(":")[0], "2");
});

test("cleanError strips plugin noise and maps lines", () => {
  assert.equal(cleanError("sabuiltin_Assistant.rbxm.X.ExecuteLuauTool:125: sabuiltin_Y.CommandExecution:54: AssistantCommand:1: boom"), "line 1: boom");
  assert.equal(cleanError("sabuiltin_A.Tool:125: sabuiltin_B.Cmd:54: Failed to parse command code"), "Failed to parse command code");
  assert.equal(cleanError("not found: 'X' under game\nAssistantCommand:1 function __need\nAssistantCommand:5"), "not found: 'X' under game");
  assert.equal(cleanError("AssistantCommand:3: bad\nAssistantCommand:3 function foo"), "line 3: bad\nline 3: function foo");
});

test("splitPath", () => {
  assert.deepEqual(splitPath("game.Workspace.A"), ["Workspace", "A"]);
  assert.deepEqual(splitPath("ServerScriptService/My.Script"), ["ServerScriptService", "My.Script"]);
  assert.deepEqual(splitPath("game"), []);
});

test("wrap keeps user code on line 1", () => {
  const w = wrap("return 1");
  assert.equal(w.split("\n")[0].endsWith("local function __user(...) return 1"), true);
});

test("segment encoding is reversible and filesystem-safe", () => {
  for (const n of ["a:b", "CON", "init", "x.", "50%", "a/b\\c", "normal", "con.txt"]) {
    const e = encodeSeg(n);
    assert.doesNotMatch(e, /[<>:"/\\|?*]|[. ]$/);
    assert.equal(decodeSeg(e), n);
  }
});

test("mapScripts: suffixes, init containers, case collisions", () => {
  const m = mapScripts([
    { segs: ["ServerScriptService", "Main"], cls: "Script", hash: "1" },
    { segs: ["ServerScriptService", "Main", "Helper"], cls: "ModuleScript", hash: "2" },
    { segs: ["StarterPlayer", "StarterPlayerScripts", "Client"], cls: "LocalScript", hash: "3" },
    { segs: ["Workspace", "RC"], cls: "Script", rc: "Client", hash: "4" },
    { segs: ["ReplicatedStorage", "Foo"], cls: "ModuleScript", hash: "5" },
    { segs: ["ReplicatedStorage", "foo"], cls: "ModuleScript", hash: "6" },
  ]);
  assert.deepEqual([...m.keys()], [
    "ServerScriptService/Main/init.server.luau",
    "ServerScriptService/Main/Helper.luau",
    "StarterPlayer/StarterPlayerScripts/Client.client.luau",
    "Workspace/RC.client.luau",
    "ReplicatedStorage/Foo.luau",
    "ReplicatedStorage/foo~c2.luau",
  ]);
});

test("fileToTarget", () => {
  assert.deepEqual(fileToTarget("ServerScriptService/A.server.luau"), { segs: ["ServerScriptService", "A"], cls: "Script" });
  assert.deepEqual(fileToTarget("StarterGui/X/init.client.luau"), { segs: ["StarterGui", "X"], cls: "LocalScript" });
  assert.deepEqual(fileToTarget("ReplicatedStorage/a%3Ab.lua"), { segs: ["ReplicatedStorage", "a:b"], cls: "ModuleScript" });
  assert.equal(fileToTarget("Top.luau"), undefined);
});

test("underPrefix ignores ~N suffixes", () => {
  assert.equal(underPrefix(["A", "B~2", "C"], [["A", "B"]]), true);
  assert.equal(underPrefix(["A", "X"], [["A", "B"]]), false);
  assert.equal(underPrefix(["A"], undefined), true);
});

test("decidePull 3-way logic", () => {
  assert.equal(decidePull(undefined, undefined, "s"), "write");
  assert.equal(decidePull("s", "b", "s"), "same");
  assert.equal(decidePull("b", "b", "s"), "write");
  assert.equal(decidePull("l", "b", "b"), "keep-local");
  assert.equal(decidePull("l", "b", "s"), "conflict");
  assert.equal(decidePull("l", "b", "s", true), "write");
});

test("diffConsole returns only new entries, survives ring rotation", () => {
  const e = (i: number) => ({ m: "m" + i, t: "MessageOutput", ts: i });
  const h1 = [e(1), e(2), e(3)];
  const r1 = diffConsole(h1);
  assert.equal(r1.entries.length, 3);
  const r2 = diffConsole([...h1, e(4)], r1.cursor);
  assert.deepEqual(r2.entries.map((x) => x.m), ["m4"]);
  const r3 = diffConsole([e(3), e(4), e(5)], r2.cursor); // oldest dropped
  assert.deepEqual(r3.entries.map((x) => x.m), ["m5"]);
});

test("formatConsole levels and filters", () => {
  const es = [{ m: "a", t: "MessageOutput", ts: 1 }, { m: "warn b", t: "MessageWarning", ts: 2 }, { m: "err c", t: "MessageError", ts: 3 }];
  assert.equal(formatConsole(es, { level: "warn" }), "[W] warn b\n[E] err c");
  assert.equal(formatConsole(es, { filter: "/^err/" }), "[E] err c");
  assert.equal(formatConsole(es, { tail: 1 }), "… 2 earlier line(s) omitted\n[E] err c");
});

test("parseState", () => {
  const s = parseState("- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client");
  assert.equal(s.mode, "Play");
  assert.deepEqual(s.available, ["Client", "Server"]);
});

test("removeTomlTable", () => {
  const t = "a = 1\n[mcp_servers.x]\ncommand = 'y'\n[mcp_servers.x.env]\nK = 1\n[other]\nb = 2\n";
  assert.equal(removeTomlTable(t, "mcp_servers.x"), "a = 1\n[other]\nb = 2\n");
});

test("tomlString safely quotes paths with or without single quotes", () => {
  assert.equal(tomlString("C:\\Users\\a\\node.exe"), "'C:\\Users\\a\\node.exe'");
  assert.equal(tomlString("C:\\Users\\O'Brien\\node.exe"), '"C:\\\\Users\\\\O\'Brien\\\\node.exe"');
});

test("stripPluginNoise removes plugin errors and stacks, keeps game errors", () => {
  const es = [
    { m: "Plugin error", t: "MessageError", ts: 1 },
    { m: "Stack Begin", t: "MessageInfo", ts: 1 },
    { m: "Script 'cloud_12345.Main', Line 10", t: "MessageInfo", ts: 1 },
    { m: "Stack End", t: "MessageInfo", ts: 1 },
    { m: "Game broke", t: "MessageError", ts: 2, src: "Client" },
  ];
  const { clean, ignored } = stripPluginNoise(es);
  assert.equal(ignored, 1);
  assert.equal(clean.length, 1);
  assert.equal(formatConsole(clean), "[Client] [E] Game broke");
});

test("isIgnored matches .rbxsyncignore patterns", () => {
  const pats = ["# comment", "ReplicatedStorage/Packages", "**/Vendor/**", "*.spec"];
  assert.equal(isIgnored(["ReplicatedStorage", "Packages", "Roact"], pats), true);
  assert.equal(isIgnored(["ServerScriptService", "Vendor", "Lib"], pats), true);
  assert.equal(isIgnored(["ReplicatedStorage", "Shared", "Math.spec"], pats), true);
  assert.equal(isIgnored(["ServerScriptService", "Main"], pats), false);
});

test("parseRunContextHint detects header directive", () => {
  assert.equal(parseRunContextHint("--!runcontext client\nprint(1)"), "Client");
  assert.equal(parseRunContextHint("-- !runcontext server\nprint(1)"), "Server");
  assert.equal(parseRunContextHint("print(1)"), undefined);
});

test("buildSourcemap attaches filePaths to Rojo tree", () => {
  const sm = buildSourcemap(
    "TestPlace",
    [
      {
        name: "ServerScriptService",
        seg: "ServerScriptService",
        className: "ServerScriptService",
        children: [{ name: "Main", seg: "Main", className: "Script" }],
      },
    ],
    new Map([["ServerScriptService\u0000Main", "ServerScriptService/Main.server.luau"]]),
    "roblox-src",
  );
  assert.equal(sm.name, "TestPlace");
  assert.equal(sm.className, "DataModel");
  assert.deepEqual(sm.children?.[0].children?.[0].filePaths, ["roblox-src/ServerScriptService/Main.server.luau"]);
});

test("analyzeScripts catches cycles, broken requires, and bad GetService", () => {
  const diags = analyzeScripts([
    {
      segs: ["ServerScriptService", "Main"],
      cls: "Script",
      source: [
        'local Rep = game:GetService("ReplicatedStroage")', // typo
        'local A = require(game:GetService("ReplicatedStorage").A)',
        'local Missing = require(script.Parent.DoesNotExist)',
        '-- local Ignored = require(script.Parent.CommentedOut)',
      ].join("\n"),
    },
    {
      segs: ["ReplicatedStorage", "A"],
      cls: "ModuleScript",
      source: "local B = require(script.Parent.B)\nreturn B",
    },
    {
      segs: ["ReplicatedStorage", "B"],
      cls: "ModuleScript",
      source: "local A = require(script.Parent.A)\nreturn A",
    },
  ]);
  const kinds = diags.map((d) => d.kind);
  assert.ok(kinds.includes("bad-service"));
  assert.ok(kinds.includes("broken-require"));
  assert.ok(kinds.includes("cycle"));
  assert.equal(diags.some((d) => d.message.includes("CommentedOut")), false);
});
