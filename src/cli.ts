// CLI: `rbx-studio-plus sync pull|push|status|watch`, `run <file>`, `status`, `install`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Upstream } from "./upstream.js";
import { Studio } from "./studio.js";
import { SyncEngine } from "./sync/engine.js";
import { formatLuau } from "./tools.js";

const HELP = `rbx-studio-plus — agent-friendly MCP server for Roblox Studio

  rbx-studio-plus                      run the MCP server on stdio (what MCP clients launch)
  rbx-studio-plus install [--claude] [--codex]   register it in Claude Code / Codex (default: both)
  rbx-studio-plus status               connected studios + sync state
  rbx-studio-plus sync pull|push|status|watch [--dir D] [--studio S] [--force] [--dry-run] [--delete-missing]
  rbx-studio-plus run <file.luau> [--context edit|server|client]

Env: RBX_STUDIO (default target), RBX_SYNC_DIR, RBX_TIMEOUT_MS, RBX_UPSTREAM_CMD (JSON array)`;

function flags(argv: string[]) {
  const f: Record<string, string | boolean> = {}, pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1]; if (v && !v.startsWith("--") && ["dir", "studio", "context", "interval"].includes(k)) { f[k] = v; i++; } else f[k] = true; }
    else pos.push(a);
  }
  return { f, pos };
}

export async function runCli(argv: string[]): Promise<number> {
  const { f, pos } = flags(argv);
  const cmd = pos[0];
  if (cmd === "install") return install(!!f.claude || !f.codex, !!f.codex || !f.claude);
  if (!cmd || cmd === "help" || f.help) { console.log(HELP); return 0; }
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
    } else if (cmd === "sync") {
      const sub = pos[1];
      if (sub === "pull") console.log((await sync.pull({ dir, studio: s, force: !!f.force })).lines.join("\n"));
      else if (sub === "push") console.log((await sync.push({ dir, studio: s, force: !!f.force, dry_run: !!f["dry-run"], delete_missing: !!f["delete-missing"] })).lines.join("\n"));
      else if (sub === "status") console.log(await sync.status({ dir, studio: s }));
      else if (sub === "watch") {
        console.log(await sync.watch({ dir, studio: s, on: true, interval_s: f.interval ? Number(f.interval) : undefined }));
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

function install(claude: boolean, codex: boolean): number {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const node = process.execPath;
  const NAME = "roblox-plus";
  if (claude) {
    // On Windows `claude` may be a .cmd shim, which needs a shell; quote args with spaces then.
    const win = process.platform === "win32";
    const q = (s: string) => (win && /\s/.test(s) ? `"${s}"` : s);
    try {
      try { execFileSync("claude", ["mcp", "remove", "-s", "user", NAME], { stdio: "ignore", shell: win }); } catch { /* not present */ }
      execFileSync("claude", ["mcp", "add", "-s", "user", NAME, "--", q(node), q(entry)], { stdio: "inherit", shell: win });
      console.log(`✔ Claude Code: '${NAME}' registered (user scope).`);
    } catch (e: any) { console.error(`✘ Claude Code: ${e.message}\n  Manual: claude mcp add -s user ${NAME} -- "${node}" "${entry}"`); }
  }
  if (codex) {
    const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
    try {
      let toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      toml = removeTomlTable(toml, `mcp_servers.${NAME}`);
      const lit = (s: string) => `'${s}'`;
      toml = toml.replace(/\s*$/, "\n") + `\n[mcp_servers.${NAME}]\ncommand = ${lit(node)}\nargs = [${lit(entry)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 600\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toml.replace(/^\n+/, ""));
      console.log(`✔ Codex: '${NAME}' written to ${file}.`);
    } catch (e: any) { console.error(`✘ Codex: ${e.message}`); }
  }
  return 0;
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
