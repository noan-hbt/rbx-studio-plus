// Static Luau analysis: require() graph & cycle detection, GetService validation, optional luau-analyze / selene.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ScriptSource {
  segs: string[];
  cls: string;
  source: string;
}

export interface StaticDiagnostic {
  script: string;
  line: number;
  kind: "cycle" | "broken-require" | "bad-service";
  message: string;
}

const KNOWN_SERVICES = new Set([
  "Workspace", "Players", "Lighting", "MaterialService", "ReplicatedFirst", "ReplicatedStorage",
  "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer",
  "Teams", "SoundService", "TextChatService", "Chat", "LocalizationService", "TestService",
  "RunService", "UserInputService", "ContextActionService", "TweenService", "HttpService",
  "CollectionService", "PhysicsService", "PathfindingService", "ProximityPromptService",
  "MarketplaceService", "DataStoreService", "MemoryStoreService", "MessagingService",
  "PolicyService", "SocialService", "TeleportService", "BadgeService", "GroupService",
  "InsertService", "AssetService", "AvatarEditorService", "ContentProvider", "Debris",
  "GuiService", "HapticService", "LogService", "VRService", "VoiceChatService",
  "Selection", "ChangeHistoryService", "ScriptEditorService", "StudioService", "CoreGui",
  "Stats", "NetworkClient", "NetworkServer", "AnalyticsService", "ExperienceAuthService",
  "TextService", "AdService", "CaptureService", "CommerceService",
]);

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Strip line and block comments while preserving line count/offsets. */
function stripComments(src: string): string {
  return src
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function resolveRequireTarget(fromSegs: string[], expr: string): string[] | undefined {
  const clean = expr.replace(/\s+/g, "");
  // Handle game:GetService("Service").A.B or game:GetService('Service').A.B
  const svcMatch = clean.match(/^game:GetService\((["'])([A-Za-z0-9_]+)\1\)(.*)$/);
  if (svcMatch) {
    const rest = svcMatch[3];
    if (!rest.startsWith(".") && rest !== "") return undefined;
    const tail = rest ? rest.slice(1).split(".") : [];
    if (tail.some((p) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) return undefined;
    return [svcMatch[2], ...tail];
  }
  // Handle script.Parent... or script.Child...
  if (clean === "script" || clean.startsWith("script.")) {
    const parts = clean.split(".").slice(1);
    if (!parts.length || parts.some((p) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) return undefined;
    const cur = [...fromSegs];
    for (const p of parts) {
      if (p === "Parent") {
        if (!cur.length) return undefined;
        cur.pop();
      } else {
        cur.push(p);
      }
    }
    return cur;
  }
  // Handle game.ReplicatedStorage.X or ReplicatedStorage.X
  const rootMatch = clean.match(/^(?:game\.)?(ReplicatedStorage|ServerScriptService|ServerStorage|ReplicatedFirst|StarterPlayer|StarterGui|StarterPack|Workspace)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/);
  if (rootMatch) {
    return [rootMatch[1], ...rootMatch[2].slice(1).split(".")];
  }
  return undefined;
}

/** Analyze static require() graph, cycles, and GetService typos across scripts. */
export function analyzeScripts(scripts: ScriptSource[], knownNodes?: Set<string>): StaticDiagnostic[] {
  const diagnostics: StaticDiagnostic[] = [];
  const byKey = new Map<string, ScriptSource>();
  const stripSuffix = (s: string) => s.replace(/~\d+$/, "");
  const normKey = (segs: string[]) => segs.map(stripSuffix).join("\u0000");

  for (const sc of scripts) {
    byKey.set(normKey(sc.segs), sc);
  }

  const edges = new Map<string, string[]>();

  for (const sc of scripts) {
    const fromName = sc.segs.join(".");
    const fromKey = normKey(sc.segs);
    const code = stripComments(sc.source);
    const deps: string[] = [];

    // Check GetService("...")
    const svcRe = /GetService\(\s*(["'])([^"']+)\1\s*\)/g;
    let sm: RegExpExecArray | null;
    while ((sm = svcRe.exec(code)) !== null) {
      if (!KNOWN_SERVICES.has(sm[2])) {
        diagnostics.push({
          script: fromName,
          line: lineOf(code, sm.index),
          kind: "bad-service",
          message: `Unknown Roblox service '${sm[2]}' in GetService()`,
        });
      }
    }

    // Check require(...)
    const reqRe = /\brequire\(\s*([^()\n]+?)\s*\)/g;
    let rm: RegExpExecArray | null;
    while ((rm = reqRe.exec(code)) !== null) {
      const targetSegs = resolveRequireTarget(sc.segs, rm[1]);
      if (!targetSegs) continue;
      const targetKey = normKey(targetSegs);
      const target = byKey.get(targetKey);
      if (target) {
        deps.push(targetKey);
      } else if (!knownNodes || !knownNodes.has(targetKey)) {
        // Ignore if target is a known non-script or dynamic WaitForChild; we only matched static dot chains.
        diagnostics.push({
          script: fromName,
          line: lineOf(code, rm.index),
          kind: "broken-require",
          message: `require(${rm[1].trim()}) -> '${targetSegs.join(".")}' not found among scripts`,
        });
      }
    }
    edges.set(fromKey, deps);
  }

  // Cycle detection (DFS)
  const state = new Map<string, 1 | 2>(); // 1=visiting, 2=done
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const dfs = (u: string) => {
    state.set(u, 1);
    stack.push(u);
    for (const v of edges.get(u) ?? []) {
      const st = state.get(v);
      if (st === 1) {
        const idx = stack.indexOf(v);
        const cycle = [...stack.slice(idx), v].map((k) => byKey.get(k)?.segs.join(".") ?? k);
        const sig = [...cycle].sort().join("|");
        if (!reportedCycles.has(sig)) {
          reportedCycles.add(sig);
          diagnostics.push({
            script: cycle[0],
            line: 1,
            kind: "cycle",
            message: `Circular require(): ${cycle.join(" -> ")}`,
          });
        }
      } else if (!st) {
        dfs(v);
      }
    }
    stack.pop();
    state.set(u, 2);
  };

  for (const k of edges.keys()) {
    if (!state.get(k)) dfs(k);
  }

  return diagnostics;
}

export async function runExternalAnalyzers(dir: string, sourcemapFile?: string): Promise<string[]> {
  const out: string[] = [];
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) return out;

  // luau-analyze
  try {
    const args = ["--formatter=plain"];
    if (sourcemapFile && fs.existsSync(sourcemapFile)) args.push(`--sourcemap=${sourcemapFile}`);
    args.push(absDir);
    await execFileAsync("luau-analyze", args, { timeout: 20_000 });
    out.push("✔ luau-analyze: 0 issues");
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      const msg = String(e.stdout || e.stderr || e.message || "").trim();
      if (msg) out.push(`luau-analyze:\n${msg.split(/\r?\n/).slice(0, 40).join("\n")}`);
    }
  }

  // selene
  try {
    await execFileAsync("selene", ["--display-style=quiet", absDir], { timeout: 20_000 });
    out.push("✔ selene: 0 issues");
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      const msg = String(e.stdout || e.stderr || e.message || "").trim();
      if (msg) out.push(`selene:\n${msg.split(/\r?\n/).slice(0, 40).join("\n")}`);
    }
  }

  return out;
}
