// End-to-end test through MCP against a running Studio. Writes only under ServerStorage.__rbxplus_test (deleted at the end).
// usage: node scripts/live-e2e.mjs <syncDir> [--playtest]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "e2e-sync");
fs.rmSync(dir, { recursive: true, force: true });
const c = new Client({ name: "e2e", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/src/index.js"], stderr: "inherit" }));
const tools = (await c.listTools()).tools;
console.log(`tools: ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
let fails = 0;
const call = async (name, args = {}, expect) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const text = r.content.map((x) => x.text ?? `<${x.type}>`).join("\n");
  const bad = r.isError || (expect && !expect.test(text));
  if (bad) fails++;
  console.log(`\n${bad ? "✘" : "✔"} ${name} ${JSON.stringify(args).slice(0, 120)} (${Date.now() - t0}ms)\n${text.slice(0, 900)}`);
  return text;
};
const T = "ServerStorage/__rbxplus_test";
try {
  await call("studio_status", {}, /Mode: Edit/);
  await call("luau_run", { code: "print('hello', 42)\nreturn workspace:GetChildren()[1], Vector3.new(1,2,3)" }, /hello 42/);
  await call("luau_run", { code: "local a = nil\nreturn a.b" }, /line 2/).catch(() => {});
  await call("luau_run", { code: "local = 3" }, /Syntax error/);
  await call("tree", { depth: 1 }, /Workspace \[Workspace\]/);
  await call("tree", { class: "BaseScript", max: 5 }, /\[/);
  await call("instance", { op: "create", class: "Folder", parent: "ServerStorage", name: "__rbxplus_test" }, /created/);
  await call("instance", { op: "create", class: "Part", parent: T, name: "P", props: { Anchored: true, Size: { Vector3: [2, 3, 4] }, Color: { rgb: [255, 0, 0] }, Material: { Enum: "Material.Neon" } } }, /"ok"/);
  await call("set_props", { path: `${T}/P`, props: { Transparency: 0.5, CFrame: [0, 10, 0, 0, 45, 0] }, attributes: { Hp: 100 } }, /"@Hp": "ok"/);
  await call("inspect", { path: `${T}.P`, props: ["Size", "Transparency"] }, /Transparency/);
  await call("script_write", { path: `${T}/Mod`, source: "local M = {}\nfunction M.f() return 1 end\nreturn M\n" }, /Created/);
  await call("script_read", { path: `${T}.Mod` }, /M\.f/);
  await call("script_edit", { path: `${T}.Mod`, edits: [{ old: "return 1", new: "return 2" }] });
  await call("script_read", { path: `${T}.Mod`, start: 2, end: 2 }, /return 2/);
  await call("script_check", { paths: [T] }, /compile/);
  await call("selection", { set: [`${T}/P`] }, /Selected \(1\)/);
  await call("selection", { set: [] });
  await call("console", { since: "all", tail: 5 });
  await call("luau_run", { code: "print('marker-xyz') warn('warn-xyz')" });
  await call("console", { filter: "xyz" }, /marker-xyz[\s\S]*\[W\] warn-xyz/);
  // Sync
  await call("sync_pull", { dir }, /Pulled/);
  const modFile = path.join(dir, "ServerStorage/__rbxplus_test/Mod.luau");
  console.log("mod file exists:", fs.existsSync(modFile));
  await call("sync_status", { dir }, /Everything in sync/);
  fs.writeFileSync(modFile, fs.readFileSync(modFile, "utf8").replace("return 2", "return 3"));
  fs.writeFileSync(path.join(dir, "ServerStorage/__rbxplus_test/New.server.luau"), "print('new script')\n");
  await call("sync_push", { dir, dry_run: true }, /update[\s\S]*create/);
  await call("sync_push", { dir }, /Pushed 2\/2/);
  await call("script_read", { path: `${T}.Mod` }, /return 3/);
  // Conflict: change both sides
  await call("script_edit", { path: `${T}.Mod`, edits: [{ old: "return 3", new: "return 4" }] });
  fs.writeFileSync(modFile, fs.readFileSync(modFile, "utf8").replace("return 3", "return 5"));
  await call("sync_status", { dir }, /CONFLICTS/);
  await call("sync_push", { dir }, /CONFLICT/);
  await call("sync_pull", { dir }, /conflict/);
  console.log(".studio exists:", fs.existsSync(modFile + ".studio"));
  fs.rmSync(modFile + ".studio");
  await call("sync_push", { dir, force: true }, /Pushed 1\/1/);
  // Watch
  await call("sync_watch", { dir, on: true, interval_s: 1 }, /Watch ON/);
  fs.writeFileSync(modFile, fs.readFileSync(modFile, "utf8").replace("return 5", "return 6"));
  await new Promise((r) => setTimeout(r, 2500));
  await call("script_read", { path: `${T}.Mod` }, /return 6/);
  await call("script_edit", { path: `${T}.Mod`, edits: [{ old: "return 6", new: "return 7" }] });
  await new Promise((r) => setTimeout(r, 3500));
  console.log("watch pulled studio edit:", /return 7/.test(fs.readFileSync(modFile, "utf8")));
  await call("sync_watch", { on: false });
  // Delete via sync
  fs.rmSync(path.join(dir, "ServerStorage/__rbxplus_test/New.server.luau"));
  await call("sync_push", { dir, delete_missing: true }, /deleted in Studio/);
  await call("history", { action: "undo" });
  await call("tree", { path: T }, /New/);
  await call("history", { action: "redo" });
  if (process.argv.includes("--playtest")) {
    await call("playtest", { code: "print('in game', #game:GetService('Players'):GetPlayers()) return game:GetService('RunService'):IsServer()", duration_s: 6 }, /--- console ---/);
    await call("play", { action: "status" }, /Edit/);
  }
  // passthrough
  await call("search_game_tree", { path: "ServerStorage", max_depth: 1 }, /__rbxplus_test/);
} finally {
  await call("instance", { op: "delete", path: T }).catch(() => {});
  await c.close();
  console.log(`\n${fails ? `✘ ${fails} failure(s)` : "✔ all passed"}`);
  process.exit(fails ? 1 : 0);
}
