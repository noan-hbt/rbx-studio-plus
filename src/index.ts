#!/usr/bin/env node
// rbx-studio-plus: MCP stdio server (default) or CLI (sync / install).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Upstream, ToolResult, withTimeout } from "./upstream.js";
import { Studio } from "./studio.js";
import { SyncEngine } from "./sync/engine.js";
import { buildTools, passthrough, HIDDEN, ToolDef } from "./tools.js";
import { runCli } from "./cli.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Roblox Studio bridge (rbx-studio-plus). No studio_id needed: the open Studio is picked automatically.
Workflow:
1. studio_status — see what's connected, play mode, sync state.
2. Scripts: sync_pull once, then read/edit/grep the files under ./roblox-src with your normal file tools and sync_push (or sync_watch on=true for automatic two-way sync). script_read / script_write / script_edit also work directly.
3. Queries and one-off changes: luau_run (returns print output + return value). tree / inspect / set_props / instance for the hierarchy. selection = what the user selected.
4. Verify: script_check (syntax), then playtest (runs the game, reports errors/warnings, stops).
5. console shows only new Output lines since your last call. history undo reverts mistakes.
Other Studio tools (generate_*, insert_asset, screen_capture, input simulation, …) are available with the same names.`;

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

  const server = new Server({ name: "rbx-studio-plus", version: VERSION }, { capabilities: { tools: { listChanged: true }, resources: {} }, instructions: INSTRUCTIONS });

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
    resources: [{ uri: "rbx://studio/status", name: "Studio status", mimeType: "text/plain", description: "Connected studios, play mode, sync state" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const t = own.find((x) => x.name === "studio_status")!;
    let text: string;
    try { text = String(await t.handler({})); } catch (e: any) { text = e.message; }
    return { contents: [{ uri: req.params.uri, mimeType: "text/plain", text }] };
  });

  await server.connect(new StdioServerTransport());
  // Warm up the Studio bridge so the tool list is complete; tell the client if it grew.
  allTools().then((t) => { if (t.length > own.length) server.sendToolListChanged().catch(() => {}); });
  const bye = async () => { await up.close(); process.exit(0); };
  process.stdin.on("close", bye);
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((e) => { process.stderr.write(`[rbx-studio-plus] fatal: ${e?.stack ?? e}\n`); process.exit(1); });
