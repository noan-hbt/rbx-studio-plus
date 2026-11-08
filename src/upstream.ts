// Connection to Roblox Studio's built-in MCP server (we are its MCP client).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";

export type ToolContent = { type: string; text?: string; data?: string; mimeType?: string; [k: string]: unknown };
export interface ToolResult { content: ToolContent[]; isError?: boolean }
export interface UpstreamTool { name: string; description?: string; inputSchema: any }

export class UpstreamError extends Error {}

export function upstreamCommand(): { command: string; args: string[] } {
  const env = process.env.RBX_UPSTREAM_CMD;
  if (env) {
    const arr = JSON.parse(env) as string[];
    return { command: arr[0], args: arr.slice(1) };
  }
  if (process.platform === "win32") {
    const bat = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Roblox", "mcp.bat");
    return { command: "cmd.exe", args: ["/c", bat] };
  }
  return { command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP", args: [] };
}

export const DEFAULT_TIMEOUT_MS = Number(process.env.RBX_TIMEOUT_MS ?? 60_000);

const NOT_RUNNING_HINT =
  "Is Roblox Studio open with a place loaded and 'Enable Studio as MCP server' turned on (Assistant → … → Manage MCP Servers)?";

export class Upstream {
  private client?: Client;
  private connecting?: Promise<Client>;
  private tools?: UpstreamTool[];

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { command, args } = upstreamCommand();
      const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
      const client = new Client({ name: "rbx-studio-plus", version: "0.1.0" });
      transport.onclose = () => { if (this.client === client) { this.client = undefined; this.tools = undefined; } };
      try {
        await withTimeout(client.connect(transport), 30_000, `Could not start Studio's MCP bridge (${command} ${args.join(" ")}). ${NOT_RUNNING_HINT}`);
      } catch (e) {
        await transport.close().catch(() => {});
        throw e;
      }
      this.client = client;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }

  async listTools(): Promise<UpstreamTool[]> {
    if (this.tools) return this.tools;
    const c = await this.connect();
    const r = await c.listTools();
    this.tools = r.tools as UpstreamTool[];
    return this.tools;
  }

  /** Calls an upstream tool. Reconnects once if the bridge died. */
  async call(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ToolResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.connect();
        const r = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true, maxTotalTimeout: timeoutMs });
        return r as unknown as ToolResult;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const isTimeout = /timed? ?out|-32001/i.test(msg);
        if (isTimeout) throw new UpstreamError(`Studio did not answer '${name}' within ${Math.round(timeoutMs / 1000)}s. If the code was heavy, split it and call task.wait() between chunks. ${NOT_RUNNING_HINT}`);
        if (attempt === 0 && /closed|EPIPE|not connected|ECONNRESET/i.test(msg)) { this.client = undefined; this.tools = undefined; continue; }
        throw new UpstreamError(`${msg}. ${NOT_RUNNING_HINT}`);
      }
    }
  }

  async close() { await this.client?.close().catch(() => {}); }
}

export function textOf(r: ToolResult): string {
  return r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new UpstreamError(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
