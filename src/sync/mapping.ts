// Pure mapping between Studio script instances and local files (Rojo-compatible naming).
import path from "node:path";

export type ScriptClass = "Script" | "LocalScript" | "ModuleScript";
export interface StudioScript { segs: string[]; cls: ScriptClass; rc?: string; hash: string }

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function encodeSeg(name: string): string {
  let s = name.replace(/[<>:"/\\|?*%\x00-\x1f]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  s = s.replace(/[. ]$/, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  if (s === "") s = "%00";
  const base = s.split(".")[0];
  if (RESERVED.test(base) || /^init$/i.test(base)) s = "%" + s.charCodeAt(0).toString(16).toUpperCase() + s.slice(1);
  return s;
}

export function decodeSeg(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function suffixFor(cls: ScriptClass, rc?: string): string {
  if (cls === "LocalScript") return ".client.luau";
  if (cls === "Script") return rc === "Client" ? ".client.luau" : ".server.luau";
  return ".luau";
}

/** Map Studio scripts to relative POSIX file paths. Scripts that contain other scripts become `<dir>/init.*`. */
export function mapScripts(list: StudioScript[]): Map<string, StudioScript> {
  const key = (segs: string[]) => segs.join("\u0000");
  const containers = new Set<string>();
  for (const s of list) for (let i = 1; i < s.segs.length; i++) containers.add(key(s.segs.slice(0, i)));
  const out = new Map<string, StudioScript>();
  const lower = new Set<string>();
  for (const s of list) {
    const enc = s.segs.map(encodeSeg);
    let rel = containers.has(key(s.segs))
      ? [...enc, "init" + suffixFor(s.cls, s.rc)].join("/")
      : enc.join("/") + suffixFor(s.cls, s.rc);
    // Case-insensitive filesystems: "Foo" and "foo" would collide.
    if (lower.has(rel.toLowerCase())) {
      let n = 2;
      const ext = suffixFor(s.cls, s.rc);
      const stem = rel.slice(0, -ext.length);
      while (lower.has(`${stem}~c${n}${ext}`.toLowerCase())) n++;
      rel = `${stem}~c${n}${ext}`;
    }
    lower.add(rel.toLowerCase());
    out.set(rel, s);
  }
  return out;
}

/** Interpret a new local file (not in the manifest) as a script to create. */
export function fileToTarget(rel: string): { segs: string[]; cls: ScriptClass } | undefined {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const file = parts.pop();
  if (!file) return undefined;
  const m = file.match(/^(.*?)(\.server|\.client)?\.(luau|lua)$/);
  if (!m) return undefined;
  const [, stem, kind] = m;
  const cls: ScriptClass = kind === ".server" ? "Script" : kind === ".client" ? "LocalScript" : "ModuleScript";
  const segs = stem === "init" ? parts : [...parts, stem];
  if (segs.length < 2) return undefined; // must live inside a service
  return { segs: segs.map(decodeSeg), cls };
}

export function isScriptFile(rel: string): boolean {
  const b = path.posix.basename(rel);
  return /\.(luau|lua)$/.test(b) && !b.startsWith(".");
}

/** "ServerScriptService.Foo" / "ServerScriptService/Foo" prefix filter on segments. */
export function underPrefix(segs: string[], prefixes?: string[][]): boolean {
  if (!prefixes?.length) return true;
  return prefixes.some((p) => p.length <= segs.length && p.every((x, i) => x === segs[i] || x === segs[i].replace(/~\d+$/, "")));
}
