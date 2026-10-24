#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "./check-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const impactMap = JSON.parse(
  readFileSync(resolve(root, "planning/testing/impact-map.json"), "utf8"),
);

const normalize = (path) => path.replaceAll("\\", "/").replace(/^\.\//, "");
const laneOrder = ["quick", "core", "process", "ui", "provider", "package"];

function match(path, pattern) {
  return globToRegExp(pattern).test(path);
}

export function planTestImpact(changedPaths, map = impactMap) {
  const paths = [...new Set(changedPaths.map(normalize))].sort();
  const selected = new Map();
  const unknownPaths = [];
  const matchedRules = [];
  const highRiskTags = new Set();

  const addLane = (lane, reason, full = false) => {
    if (!map.lanes[lane]) throw new Error(`impact map references unknown lane: ${lane}`);
    const current = selected.get(lane) ?? { scope: "selected-lane", reasons: [] };
    if (full) current.scope = "full-lane";
    current.reasons.push(reason);
    selected.set(lane, current);
  };

  for (const path of paths) {
    const rules = map.pathRules.filter((rule) => match(path, rule.pattern));
    if (rules.length === 0) {
      unknownPaths.push(path);
      continue;
    }
    for (const rule of rules) {
      matchedRules.push({ path, pattern: rule.pattern, lanes: rule.lanes });
      for (const lane of rule.lanes) {
        addLane(lane, `${path} matches ${rule.pattern}`);
      }
    }
    for (const rule of map.highRiskRules) {
      const patterns = rule.patterns.filter((pattern) => match(path, pattern));
      if (patterns.length === 0) continue;
      highRiskTags.add(rule.tag);
      for (const lane of rule.lanes) {
        addLane(lane, `high-risk ${rule.tag}: ${path} matches ${patterns.join(", ")}`, true);
      }
    }
  }

  if (unknownPaths.length > 0) {
    for (const lane of laneOrder) {
      addLane(lane, `unknown path(s) require conservative full-lane selection: ${unknownPaths.join(", ")}`, true);
    }
  }

  return {
    schemaVersion: 1,
    mode: unknownPaths.length > 0 ? "conservative-unknown" : "impact-selected",
    changedPaths: paths,
    matchedRules,
    unknownPaths,
    highRiskTags: [...highRiskTags].sort(),
    selectedLanes: laneOrder.filter((lane) => selected.has(lane)),
    lanes: Object.fromEntries(
      laneOrder
        .filter((lane) => selected.has(lane))
        .map((lane) => [
          lane,
          {
            scope: selected.get(lane).scope,
            command: map.lanes[lane].command,
            description: map.lanes[lane].scope,
            reasons: [...new Set(selected.get(lane).reasons)],
          },
        ]),
    ),
    realProviderL3: selected.has("provider")
      ? "not-run; decide explicitly from the changed provider-facing contract and release scope"
      : "not-selected",
    completeCoverage: false,
    coverageLabel:
      "focused impact plan only; never a complete release qualification",
  };
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim() ?? "git failed");
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedPathsSince(base) {
  const tracked = runGit([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "--no-renames",
    base,
    "--",
  ]);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])];
}

function parseArguments(args) {
  const changedPaths = [];
  let base;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--base") {
      base = args[++index];
      if (!base) throw new Error("--base requires a Git ref");
    } else if (args[index] === "--changed") {
      const path = args[++index];
      if (!path) throw new Error("--changed requires a repository-relative path");
      changedPaths.push(path);
    } else if (args[index] === "--help" || args[index] === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  if (base && changedPaths.length > 0)
    throw new Error("use either --base or --changed, not both");
  if (!base && changedPaths.length === 0)
    throw new Error("provide --base <ref> or one or more --changed <path> values");
  return { base, changedPaths };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
      console.log(
        "Usage: node scripts/testing/plan-test-impact.mjs --base <git-ref> | --changed <path> [--changed <path> ...]",
      );
    } else {
      const changes = args.base ? changedPathsSince(args.base) : args.changedPaths;
      console.log(JSON.stringify(planTestImpact(changes), null, 2));
    }
  } catch (error) {
    console.error(`test impact planner: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
