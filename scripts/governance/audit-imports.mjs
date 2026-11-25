import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { moduleOf, specifiers } from "./inventory-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const head = git(["rev-parse", "HEAD"]).trim();
const before = git(["status", "--porcelain", "-z"]);
const paths = [...new Set(git(["ls-files", "-z"]).split("\0").filter(Boolean))].sort();
const packages = new Map();
const byName = new Map();
const errors = [];
for (const path of paths.filter(p => /^(packages|adapters|apps)\/[^/]+\/package\.json$/.test(p))) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    const module = moduleOf(path);
    if (typeof manifest.name !== "string" || byName.has(manifest.name)) throw Error("missing or duplicate package name");
    const declared = new Set(Object.keys({...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies}));
    packages.set(module, {name: manifest.name, declared});
    byName.set(manifest.name, module);
  } catch (error) { errors.push({path, error:String(error)}); }
}
const edges = new Map();
const findings = [];
let scanned = 0;
for (const path of paths.filter(p => /^(packages|adapters|apps)\/[^/]+\/src\/.*\.(?:ts|tsx|mts|cts)$/.test(p))) {
  const from = moduleOf(path);
  const owner = packages.get(from);
  if (!owner) { errors.push({path,error:"missing owning manifest"}); continue; }
  try {
    const ast = parse(readFileSync(join(root,path),"utf8"), {sourceType:"unambiguous", plugins:["typescript", ...(path.endsWith(".tsx")?["jsx"]:[])]});
    scanned++;
    for (const {specifier,line} of specifiers(ast)) {
      let target;
      if (specifier.startsWith("@arbor/")) {
        const name = specifier.split("/").slice(0,2).join("/");
        target = byName.get(name);
        if (!target) findings.push({path,line,specifier,kind:"unknown-internal-package"});
        if (specifier !== name) findings.push({path,line,specifier,kind:"deep-import-review"});
        if (target && target !== from && !owner.declared.has(name)) findings.push({path,line,specifier,kind:"undeclared-production-dependency"});
      } else if (specifier.startsWith(".")) {
        target = moduleOf(posix.normalize(posix.join(posix.dirname(path),specifier)));
        if (target && target !== from) findings.push({path,line,specifier,kind:"cross-module-relative-import"});
      }
      if (target && target !== from) {
        const key = from+" -> "+target;
        edges.set(key,(edges.get(key)??0)+1);
      }
    }
  } catch (error) { errors.push({path,error:String(error)}); }
}
const after = git(["status","--porcelain","-z"]);
const headAfter = git(["rev-parse","HEAD"]).trim();
console.log(JSON.stringify({
  schema:"arbor/source-import-audit/v1",head,dirty:Boolean(before||after),headChanged:head!==headAfter,statusChanged:before!==after,scanned,
  scope:"Tracked production src TS/TSX/MTS/CTS; literal import/export/import type/dynamic import/require; lexical relative paths, no full TS resolver, no nonliteral or alias resolution. Findings require review against DID and existing architecture tests.",
  edges:[...edges].sort(([a],[b])=>a.localeCompare(b)).map(([edge,count])=>({edge,count})),findings,errors
},null,2));
if(errors.length||head!==headAfter||before!==after) process.exitCode=1;
