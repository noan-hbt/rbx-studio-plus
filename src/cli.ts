// CLI: `rbx-studio-plus sync|run|status|sourcemap|init|doctor|install`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Upstream, upstreamBridgePath } from "./upstream.js";
import { Studio } from "./studio.js";
import { SyncEngine } from "./sync/engine.js";
import { formatLuau } from "./tools.js";

const HELP = `rbx-studio-plus — agent-friendly MCP server for Roblox Studio

  rbx-studio-plus                                      run the MCP server on stdio (what MCP clients launch)
  rbx-studio-plus install [--claude] [--codex] [--cursor] [--project] [--print]
                                                       register "roblox-plus" in Claude Code / Codex / Cursor / ./.mcp.json
  rbx-studio-plus doctor                               check Studio bridge, open Studios, Luau tools & MCP registrations
  rbx-studio-plus init [--dir D] [--studio S]          pull scripts, generate sourcemap.json + .luaurc + AGENTS.md
  rbx-studio-plus sourcemap [--dir D] [--out F] [--luaurc]
                                                       generate Rojo-compatible sourcemap.json
  rbx-studio-plus status                               connected studios + sync state
  rbx-studio-plus sync pull|push|status|watch [--dir D] [--studio S] [--force] [--dry-run] [--delete-missing] [--sourcemap]
  rbx-studio-plus run <file.luau> [--context edit|server|client]

Env: RBX_STUDIO (default target), RBX_SYNC_DIR, RBX_TIMEOUT_MS, RBX_UPSTREAM_CMD (JSON array)`;

const VALUE_FLAGS = new Set(["dir", "studio", "context", "interval", "out"]);

function flags(argv: string[]) {
  const f: Record<string, string | boolean> = {}, pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--") && VALUE_FLAGS.has(k)) { f[k] = v; i++; }
      else f[k] = true;
    } else pos.push(a);
  }
  return { f, pos };
}

export function tomlString(s: string): string {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

function hasBinary(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

export async function runCli(argv: string[]): Promise<number> {
  const { f, pos } = flags(argv);
  const cmd = pos[0];
  if (cmd === "install") {
    const explicit = !!(f.claude || f.codex || f.cursor || f.project || f.print);
    return install({
      claude: !!f.claude || !explicit,
      codex: !!f.codex || !explicit,
      cursor: !!f.cursor,
      project: !!f.project,
      print: !!f.print,
    });
  }
  if (!cmd || cmd === "help" || f.help) { console.log(HELP); return 0; }
  if (cmd === "doctor") return doctor();

  const up = new Upstream();
  const studio = new Studio(up);
  const sync = new SyncEngine(studio);
  const s = f.studio as string | undefined, dir = f.dir as string | undefined;
  try {
    if (cmd === "status") {
      const list = await studio.list(true);
      console.log(list.map((x) => `${x.name}  (id ${x.id})`).join("\n") || "No studio connected.");
      if (list.length) console.log("\n" + (await sync.status({ dir, studio: s })));
    } else if (cmd === "run") {
      const code = fs.readFileSync(path.resolve(pos[1] ?? ""), "utf8");
      const r = await studio.luau(code, { studio: s, context: f.context as string });
      console.log(formatLuau(r));
      await up.close();
      return r.ok ? 0 : 1;
    } else if (cmd === "sourcemap") {
      const r = await sync.sourcemap({ dir, out: f.out as string | undefined, studio: s, luaurc: !!f.luaurc });
      console.log(`✔ Generated ${r.outFile} (${r.nodes} nodes, ${r.scriptsMapped} scripts mapped${r.luaurcCreated ? ", created .luaurc" : ""}).`);
    } else if (cmd === "init") {
      const syncDir = sync.resolveDir(dir);
      const rep = await sync.pull({ dir: syncDir, studio: s, force: !!f.force, sourcemap: true });
      console.log(rep.lines.join("\n"));
      const sm = await sync.sourcemap({ dir: syncDir, studio: s, luaurc: true });
      if (sm.luaurcCreated) console.log("✔ Created .luaurc");
      const agentsPath = path.resolve("AGENTS.md");
      if (!fs.existsSync(agentsPath)) {
        fs.writeFileSync(agentsPath, agentsTemplate(path.relative(process.cwd(), syncDir).split(path.sep).join("/")));
        console.log("✔ Created AGENTS.md");
      }
      const claudePath = path.resolve("CLAUDE.md");
      if (!fs.existsSync(claudePath)) {
        fs.writeFileSync(claudePath, `@AGENTS.md\n`);
        console.log("✔ Created CLAUDE.md (references AGENTS.md)");
      }
    } else if (cmd === "sync") {
      const sub = pos[1];
      if (sub === "pull") console.log((await sync.pull({ dir, studio: s, force: !!f.force, sourcemap: !!f.sourcemap })).lines.join("\n"));
      else if (sub === "push") console.log((await sync.push({ dir, studio: s, force: !!f.force, dry_run: !!f["dry-run"], delete_missing: !!f["delete-missing"], sourcemap: !!f.sourcemap })).lines.join("\n"));
      else if (sub === "status") console.log(await sync.status({ dir, studio: s }));
      else if (sub === "watch") {
        console.log(await sync.watch({ dir, studio: s, on: true, interval_s: f.interval ? Number(f.interval) : undefined, sourcemap: !!f.sourcemap }));
        console.log("Watching… Ctrl+C to stop.");
        await new Promise(() => {});
      } else { console.log(HELP); return 1; }
    } else { console.log(HELP); return 1; }
    await up.close();
    return 0;
  } catch (e: any) {
    console.error(`✘ ${e.message}`);
    await up.close();
    return 1;
  }
}

async function doctor(): Promise<number> {
  console.log(`Node.js: ${process.version}`);
  const bridge = upstreamBridgePath();
  if (bridge) {
    console.log(`${fs.existsSync(bridge) ? "✔" : "✘"} Studio MCP bridge: ${bridge}`);
  } else {
    console.log(`• RBX_UPSTREAM_CMD: ${process.env.RBX_UPSTREAM_CMD}`);
  }

  for (const bin of ["luau-analyze", "selene", "stylua", "rojo", "claude", "codex"]) {
    console.log(`${hasBinary(bin) ? "✔" : "·"} ${bin}${hasBinary(bin) ? "" : " (not on PATH)"}`);
  }

  const codexFile = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  const cursorFile = path.join(os.homedir(), ".cursor", "mcp.json");
  const projFile = path.resolve(".mcp.json");
  for (const [label, f] of [["Codex config", codexFile], ["Cursor config", cursorFile], ["Project .mcp.json", projFile]] as const) {
    if (fs.existsSync(f)) {
      const has = fs.readFileSync(f, "utf8").includes("roblox-plus");
      console.log(`${has ? "✔" : "·"} ${label}: ${f}${has ? " (roblox-plus configured)" : ""}`);
    }
  }

  const up = new Upstream();
  const studio = new Studio(up);
  try {
    const list = await studio.list(true);
    console.log(list.length ? `✔ Connected Studio(s):\n${list.map((s) => `    - ${s.name} (id ${s.id})`).join("\n")}` : "⚠ Studio bridge responded, but 0 Studios are connected.");
  } catch (e: any) {
    console.log(`⚠ Studio connection: ${e.message}`);
  } finally {
    await up.close();
  }
  return 0;
}

function upsertMcpJson(file: string, name: string, command: string, args: string[]) {
  let doc: any = {};
  if (fs.existsSync(file)) {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  doc.mcpServers ??= {};
  doc.mcpServers[name] = { command, args };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

function install(opts: { claude: boolean; codex: boolean; cursor: boolean; project: boolean; print: boolean }): number {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const node = process.execPath;
  const NAME = "roblox-plus";

  if (opts.print) {
    console.log("JSON (.mcp.json / Cursor / Claude Desktop):\n" + JSON.stringify({ mcpServers: { [NAME]: { command: node, args: [entry] } } }, null, 2));
    console.log(`\nTOML (~/.codex/config.toml):\n[mcp_servers.${NAME}]\ncommand = ${tomlString(node)}\nargs = [${tomlString(entry)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 600`);
  }

  if (opts.claude) {
    const win = process.platform === "win32";
    const q = (s: string) => (win && /\s/.test(s) ? `"${s}"` : s);
    try {
      try { execFileSync("claude", ["mcp", "remove", "-s", "user", NAME], { stdio: "ignore", shell: win }); } catch { /* not present */ }
      execFileSync("claude", ["mcp", "add", "-s", "user", NAME, "--", q(node), q(entry)], { stdio: "inherit", shell: win });
      console.log(`✔ Claude Code: '${NAME}' registered (user scope).`);
    } catch (e: any) { console.error(`✘ Claude Code: ${e.message}\n  Manual: claude mcp add -s user ${NAME} -- "${node}" "${entry}"`); }
  }
  if (opts.codex) {
    const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
    try {
      let toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      toml = removeTomlTable(toml, `mcp_servers.${NAME}`);
      toml = toml.replace(/\s*$/, "\n") + `\n[mcp_servers.${NAME}]\ncommand = ${tomlString(node)}\nargs = [${tomlString(entry)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 600\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toml.replace(/^\n+/, ""));
      console.log(`✔ Codex: '${NAME}' written to ${file}.`);
    } catch (e: any) { console.error(`✘ Codex: ${e.message}`); }
  }
  if (opts.cursor) {
    const file = path.join(os.homedir(), ".cursor", "mcp.json");
    try {
      upsertMcpJson(file, NAME, node, [entry]);
      console.log(`✔ Cursor: '${NAME}' written to ${file}.`);
    } catch (e: any) { console.error(`✘ Cursor: ${e.message}`); }
  }
  if (opts.project) {
    const file = path.resolve(".mcp.json");
    try {
      upsertMcpJson(file, NAME, node, [entry]);
      console.log(`✔ Project .mcp.json: '${NAME}' written to ${file}.`);
    } catch (e: any) { console.error(`✘ Project .mcp.json: ${e.message}`); }
  }
  return 0;
}

function agentsTemplate(syncRelDir: string): string {
  return `# Roblox Studio Development Guide

This project is connected to Roblox Studio via **rbx-studio-plus** MCP tools.

## Workflow
1. Inspect state with \`studio_status\` and \`game_overview\` first.
2. Scripts are synced under \`${syncRelDir}/\` (\`*.server.luau\`, \`*.client.luau\`, \`*.luau\`).
   - Edit local files with your normal file tools, then run \`sync_push\` (or enable \`sync_watch\`).
   - Use \`sync_pull\` if edits were made inside Studio.
   - Use \`sync_sourcemap\` when instances/scripts are added or moved so \`sourcemap.json\` stays accurate.
3. For instances, UI, lighting, or properties, use \`tree\`, \`inspect\`, \`instance\` (supports nested \`children\`), \`set_props\` (supports batch \`paths\`/\`tag\` & \`CollectionService\` tags), or \`luau_run\`.
4. Always verify changes before finishing:
   - \`script_check\` (syntax + static \`require()\` cycle/path checks)
   - \`playtest\` (runs Server + Client, supports \`wait_for_player: true\`, \`server_code\`, \`client_code\`, and reports errors/warnings cleanly).
`;
}

/** Remove a [table] (and its sub-tables) from TOML text. */
export function removeTomlTable(toml: string, table: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let skip = false;
  for (const l of lines) {
    const m = l.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (m) skip = m[1] === table || m[1].startsWith(table + ".");
    if (!skip) out.push(l);
  }
  return out.join("\n");
}
