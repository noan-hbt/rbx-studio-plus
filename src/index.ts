#!/usr/bin/env node
// rbx-studio-plus: MCP stdio server (default) or CLI (sync / install / init / doctor).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Upstream, ToolResult, withTimeout } from "./upstream.js";
import { Studio } from "./studio.js";
import { SyncEngine } from "./sync/engine.js";
import { buildTools, passthrough, HIDDEN, ToolDef } from "./tools.js";
import { runCli } from "./cli.js";

export const VERSION = "0.2.0";

const INSTRUCTIONS = `Roblox Studio bridge (rbx-studio-plus). No studio_id needed: the open Studio is picked automatically.
Workflow:
1. studio_status & game_overview — see connected Studio, mode, services, scripts, Remotes, and tags in 1 call.
2. Scripts: sync_pull once (pass sourcemap=true for Luau LSP / luau-analyze), then read/edit/grep local files under ./roblox-src and sync_push (or sync_watch on=true). script_read / script_write / script_edit / script_grep also work directly.
3. World & UI: tree / inspect / set_props (supports batch paths, tag selector, ColorSequence, NumberSequence, Font, Rect, CollectionService tags) / instance (supports nested children trees) / luau_run. selection = what the user selected.
4. Verify: script_check (syntax + require() cycle/path/GetService checks), then playtest (captures BOTH Server and Client errors, supports wait_for_player, server_code, client_code).
5. console shows new Output lines per datamodel (plugin noise filtered). history undo reverts mistakes.
Other Studio tools (save_place, generate_*, insert_asset, screen_capture, input simulation, …) are available with the same names.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length && argv[0] !== "--stdio") { process.exit(await runCli(argv)); }

  const up = new Upstream();
  const studio = new Studio(up);
  const sync = new SyncEngine(studio);
  const own = buildTools(studio, sync);
  const ownNames = new Set(own.map((t) => t.name));
  let passCache: ToolDef[] | undefined;

  async function allTools(): Promise<ToolDef[]> {
    if (!passCache) {
      try {
        const ups = await withTimeout(up.listTools(), 20_000, "timeout");
        passCache = ups.filter((t) => !HIDDEN.has(t.name) && !ownNames.has(t.name)).map((t) => passthrough(t, studio));
      } catch (e: any) {
        process.stderr.write(`[rbx-studio-plus] could not list Studio tools: ${e.message}\n`);
        return own;
      }
    }
    return [...own, ...passCache];
  }

  const server = new Server(
    { name: "rbx-studio-plus", version: VERSION },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await allTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let tool = own.find((t) => t.name === name) ?? passCache?.find((t) => t.name === name);
    if (!tool) tool = (await allTools()).find((t) => t.name === name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool '${name}'.` }], isError: true };
    try {
      const r = await tool.handler(args);
      return (typeof r === "string" ? { content: [{ type: "text", text: r }] } : r) as any;
    } catch (e: any) {
      const out = e?.output?.length ? `\n--- output before error ---\n${e.output.join("\n")}` : "";
      return { content: [{ type: "text", text: `✘ ${e?.message ?? e}${out}` }], isError: true } as ToolResult as any;
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "rbx://studio/status", name: "Studio status", mimeType: "text/plain", description: "Connected studios, play mode, sync state" },
      { uri: "rbx://game/overview", name: "Game overview", mimeType: "text/plain", description: "Services, script counts, Remotes, tags, Lighting & StarterPlayer" },
      { uri: "rbx://game/console", name: "Console output", mimeType: "text/plain", description: "Recent Studio Output log (plugin noise filtered)" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const map: Record<string, { tool: string; args: Record<string, unknown> }> = {
      "rbx://studio/status": { tool: "studio_status", args: {} },
      "rbx://game/overview": { tool: "game_overview", args: {} },
      "rbx://game/console": { tool: "console", args: { since: "all", tail: 100 } },
    };
    const spec = map[uri];
    if (!spec) throw new Error(`Unknown resource '${uri}'`);
    const t = own.find((x) => x.name === spec.tool)!;
    let text: string;
    try { text = String(await t.handler(spec.args)); } catch (e: any) { text = e.message; }
    return { contents: [{ uri, mimeType: "text/plain", text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: "roblox-workflow", description: "Orient yourself on the connected Roblox Studio project and sync scripts." },
      { name: "verify-and-playtest", description: "Run static checks and a Server+Client playtest to verify the game." },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name === "roblox-workflow") {
      return {
        description: "Orient on the Roblox project",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "Call studio_status and game_overview, then run sync_pull (with sourcemap: true) if scripts are not synced locally yet, and summarize the game's architecture.",
          },
        }],
      };
    }
    if (req.params.name === "verify-and-playtest") {
      return {
        description: "Check syntax, static require graph, and run a Server+Client playtest",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "Run script_check first. If there are no blockers, run playtest with wait_for_player: true and duration_s: 6, and report any Server or Client errors or warnings.",
          },
        }],
      };
    }
    throw new Error(`Unknown prompt '${req.params.name}'`);
  });

  await server.connect(new StdioServerTransport());
  // Warm up the Studio bridge so the tool list is complete; tell the client if it grew.
  allTools().then((t) => { if (t.length > own.length) server.sendToolListChanged().catch(() => {}); });
  const bye = async () => {
    if (sync.watching) sync.watching.stop();
    await up.close();
    process.exit(0);
  };
  process.stdin.on("close", bye);
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((e) => { process.stderr.write(`[rbx-studio-plus] fatal: ${e?.stack ?? e}\n`); process.exit(1); });
