import { test } from "node:test";
import assert from "node:assert/strict";
import { longString, fnv, cleanError, splitPath, wrap } from "../src/luau.js";
import { encodeSeg, decodeSeg, mapScripts, fileToTarget, underPrefix } from "../src/sync/mapping.js";
import { decidePull } from "../src/sync/engine.js";
import { diffConsole, formatConsole } from "../src/console.js";
import { parseState } from "../src/studio.js";
import { removeTomlTable } from "../src/cli.js";

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
