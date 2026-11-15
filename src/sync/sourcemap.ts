// Rojo-compatible sourcemap.json and .luaurc generation for Luau LSP & luau-analyze.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Studio } from "../studio.js";
import { mapScripts, StudioScript } from "./mapping.js";

export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

export interface TreeInstanceNode {
  name: string;
  seg: string;
  className: string;
  children?: TreeInstanceNode[];
}

const TREE_LUA = `
local maxDepth = DATA.maxDepth or 6
local function rec(inst, depth)
 local out = {}
 local ok, ch = pcall(inst.GetChildren, inst)
 if not ok then return out end
 for i, c in ch do
  local okn, nm = pcall(function() return c.Name end)
  if okn and not (inst == game and __SKIP[nm]) then
   local node = { name = nm, seg = __seg(c), className = c.ClassName }
   if depth < maxDepth then
    local kids = rec(c, depth + 1)
    if #kids > 0 then node.children = kids end
   end
   table.insert(out, node)
  end
  if i % 500 == 0 then task.wait() end
 end
 return out
end
return __HS:JSONEncode(rec(game, 1))
`;

/** Build a Rojo-compatible sourcemap tree from Studio tree + mapped script paths. */
export function buildSourcemap(
  placeName: string,
  roots: TreeInstanceNode[],
  scriptFileBySegPath: Map<string, string>,
  filePrefix: string,
): SourcemapNode {
  const prefix = filePrefix ? filePrefix.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : "";
  const convert = (node: TreeInstanceNode, segs: string[]): SourcemapNode => {
    const nextSegs = [...segs, node.seg];
    const rel = scriptFileBySegPath.get(nextSegs.join("\u0000"));
    const out: SourcemapNode = { name: node.name, className: node.className };
    if (rel) out.filePaths = [prefix + rel];
    if (node.children?.length) {
      out.children = node.children.map((c) => convert(c, nextSegs));
    }
    return out;
  };
  return {
    name: placeName,
    className: "DataModel",
    children: roots.map((r) => convert(r, [])),
  };
}

export async function generateSourcemap(
  studio: Studio,
  opts: { dir: string; outFile?: string; studio?: string; maxDepth?: number; writeLuaurc?: boolean; scripts?: StudioScript[] },
): Promise<{ outFile: string; nodes: number; scriptsMapped: number; luaurcCreated: boolean }> {
  const s = await studio.resolve(opts.studio);
  const outFile = path.resolve(opts.outFile ?? "sourcemap.json");
  const outDir = path.dirname(outFile);
  const relDir = path.relative(outDir, path.resolve(opts.dir)).split(path.sep).join("/");
  const filePrefix = relDir === "." ? "" : relDir;

  const [rawTree, rawScripts] = await Promise.all([
    studio.rpc<string>(TREE_LUA, { maxDepth: opts.maxDepth ?? 6 }, { studio: opts.studio, context: "edit", timeoutMs: 120_000 }),
    opts.scripts
      ? Promise.resolve(opts.scripts)
      : studio.rpc<string>(
          `local out = {} for i, s in __scripts() do local ok, rc = pcall(function() return s.RunContext.Name end) table.insert(out, { s = __segs(s), c = s.ClassName, rc = ok and rc or nil, h = "" }) if i % 80 == 0 then task.wait() end end return __HS:JSONEncode(out)`,
          undefined,
          { studio: opts.studio, context: "edit", timeoutMs: 120_000 },
        ).then((j) => (JSON.parse(j) as any[]).map((x) => ({ segs: x.s, cls: x.c, rc: x.rc ?? undefined, hash: x.h ?? "" }) as StudioScript)),
  ]);

  const roots = JSON.parse(rawTree) as TreeInstanceNode[];
  const mapped = mapScripts(rawScripts);
  const bySeg = new Map<string, string>();
  for (const [rel, sc] of mapped) bySeg.set(sc.segs.join("\u0000"), rel);

  const tree = buildSourcemap(s.name, roots, bySeg, filePrefix);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(outFile, JSON.stringify(tree, null, 2) + "\n");

  let luaurcCreated = false;
  if (opts.writeLuaurc) {
    const rcPath = path.join(outDir, ".luaurc");
    if (!fs.existsSync(rcPath)) {
      await fsp.writeFile(rcPath, JSON.stringify({ languageMode: "nonstrict", lint: { "*": true }, globals: [] }, null, 2) + "\n");
      luaurcCreated = true;
    }
  }

  let nodes = 0;
  const count = (n: SourcemapNode) => {
    nodes++;
    n.children?.forEach(count);
  };
  count(tree);

  return { outFile, nodes, scriptsMapped: bySeg.size, luaurcCreated };
}
