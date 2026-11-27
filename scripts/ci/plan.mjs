#!/usr/bin/env node
// CI verification-plan generator — CI campaign PR 5: impact-analysis
// shadow mode (docs/engineering/ci-architecture.md, "Impact analysis").
//
// Reuses the checked test-impact planner (scripts/testing/plan-test-impact.mjs
// + planning/testing/impact-map.json) and the functional shard inventory
// (scripts/testing/functional-shard.mjs) to emit an auditable CI Plan for a
// base..head diff. The plan is uploaded as a workflow artifact; the
// functional lanes read it in SHADOW MODE — every lane still runs its
// complete inventory, and the plan only reports what selection would have
// skipped. Skipped-suggestions must stay green for N runs before selection
// actually reduces scope.
//
// The plan keeps two layers separate: `impact` is the raw audit trail of
// the checked impact map (its own conservative-unknown behavior included),
// while `selection`/`requiredChecks` are this policy's decision. Where the
// map goes conservative on paths this policy confidently classifies (e.g.
// pure docs diffs, unknown to the map), the policy decision wins and the
// map's verdict stays visible next to it.
//
// ── Risk classification policy (initial version) ─────────────────────
//
// Classification walks the buckets below; the first complete match wins.
// "any" = at least one changed path matches; "all" = every changed path
// matches (docs and Markdown always ride along, they never widen a diff).
//
//   1. lockfile     any changed path is pnpm-lock.yaml
//                   → full: unit + functional + functional-ui + web build
//                     (the dependency graph moved; nothing may be deferred)
//   2. docs-only    every changed path is docs/** or **/*.md
//                   → static lane only (lint/typecheck/architecture/naming
//                     still apply to documentation diffs)
//   3. runtime      every changed path is docs, **/*.md, or under
//                   packages/agent-runtime / packages/execution-runtime
//                   → core (unit) full + functional smoke+risk-selected
//                     (smoke group + the crash-sentinels family from
//                     planning/testing/manifest.json)
//   4. web          every changed path is docs, **/*.md, or under apps/web
//                   → web checks + functional-ui (browser suite)
//   5. unclassified anything the policy cannot confidently classify —
//                   mixed diffs, unknown paths, empty diffs
//                   → conservative full selection
//
// Escalations from the impact map's high-risk tags (never below bucket):
//   schema      → functional and functional-ui escalate to full
//   permissions → functional-ui escalates to full (browser approval flows)
//
// Every plan carries policyDigest = sha256 over the serialized policy
// object, so a plan artifact is always auditable against the exact policy
// version that produced it. Touching POLICY changes the digest.
//
// ── Shadow-mode contract ─────────────────────────────────────────────
//
// This generator must not reduce any test execution. requiredChecks and
// selection describe what the policy WOULD require after the merge-gate
// switchover (ten consecutive green full runs, per ci-architecture.md);
// today they are reporting only. Planner failures degrade to a
// conservative full-selection plan (status "error") instead of failing
// the workflow, so lane obligations never depend on this script.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "../testing/check-manifest.mjs";
import {
  collectFunctionalShardFiles,
  shardFiles,
} from "../testing/functional-shard.mjs";
import { planTestImpact } from "../testing/plan-test-impact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  readFileSync(join(root, "planning/testing/manifest.json"), "utf8"),
);
const impactMapSha256 = createHash("sha256")
  .update(readFileSync(join(root, "planning/testing/impact-map.json")))
  .digest("hex");

// Must mirror the functional matrix width in .github/workflows/ci.yml.
export const FUNCTIONAL_SHARD_TOTAL = 8;

const docsPatterns = ["docs/**", "**/*.md"];

// selection.core.scope is "full" | "none" today; "selected" (a file-level
// core subset) is reserved for the per-file core impact mapping that lands
// with the merge gate. selection.functional.scope is "full" |
// "smoke+risk-selected" | "none".
export const POLICY = {
  schemaVersion: 1,
  buckets: [
    {
      name: "lockfile",
      description: "lockfile change: dependency graph moved, full selection",
      any: ["pnpm-lock.yaml"],
      plan: {
        unit: "full",
        functional: "full",
        functionalUi: "full",
        web: true,
      },
    },
    {
      name: "docs-only",
      description: "pure documentation diff: static lane only",
      all: docsPatterns,
      plan: {
        unit: "none",
        functional: "none",
        functionalUi: "none",
        web: false,
      },
    },
    {
      name: "runtime",
      description:
        "agent-runtime/execution-runtime change: core full plus the crash-sentinel functional family",
      all: [
        ...docsPatterns,
        "packages/agent-runtime/**",
        "packages/execution-runtime/**",
      ],
      plan: {
        unit: "full",
        functional: "smoke+risk-selected",
        functionalUi: "none",
        web: false,
      },
    },
    {
      name: "web",
      description: "web change: web checks plus the browser functional lane",
      all: [...docsPatterns, "apps/web/**"],
      plan: {
        unit: "none",
        functional: "none",
        functionalUi: "full",
        web: true,
      },
    },
    {
      name: "unclassified",
      description:
        "not confidently classifiable (mixed/unknown/empty diff): conservative full selection",
      plan: {
        unit: "full",
        functional: "full",
        functionalUi: "full",
        web: true,
      },
    },
  ],
  functionalSuites: {
    "smoke+risk-selected": ["smoke", "crashSentinels"],
  },
  escalations: [
    {
      riskTag: "schema",
      effect: { functional: "full", functionalUi: "full" },
      reason: "schema/migration changes are cross-cutting",
    },
    {
      riskTag: "permissions",
      effect: { functionalUi: "full" },
      reason: "permission/approval changes reach the browser flows",
    },
  ],
};

const functionalRank = { none: 0, "smoke+risk-selected": 1, full: 2 };
const laneRank = { none: 0, full: 1 };

export function policyDigest(policy = POLICY) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex")}`;
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function classifyPolicy(changedPaths) {
  for (const bucket of POLICY.buckets) {
    if (bucket.name === "unclassified") continue;
    if (bucket.any && changedPaths.some((path) => matchesAny(path, bucket.any)))
      return bucket;
    if (
      bucket.all &&
      changedPaths.length > 0 &&
      changedPaths.every((path) => matchesAny(path, bucket.all))
    )
      return bucket;
  }
  return POLICY.buckets.find((bucket) => bucket.name === "unclassified");
}

function escalateFunctional(current, next) {
  return functionalRank[next] > functionalRank[current] ? next : current;
}

function escalateLane(current, next) {
  return laneRank[next] > laneRank[current] ? next : current;
}

const toRelative = (path) => {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
};

function functionalInventory() {
  return collectFunctionalShardFiles().map(toRelative);
}

function selectedFunctionalFiles(scope) {
  if (scope === "full") return functionalInventory();
  if (scope === "smoke+risk-selected") {
    const suites = POLICY.functionalSuites[scope] ?? [];
    return [
      ...new Set(suites.flatMap((suite) => manifest.groups[suite] ?? [])),
    ].sort();
  }
  return [];
}

function shardSummary(inventory, selected) {
  const selectedSet = new Set(selected);
  const shards = {};
  for (let index = 1; index <= FUNCTIONAL_SHARD_TOTAL; index += 1) {
    const files = shardFiles(inventory, index, FUNCTIONAL_SHARD_TOTAL);
    shards[String(index)] = {
      total: files.length,
      selected: files.filter((path) => selectedSet.has(path)).length,
    };
  }
  return shards;
}

export function buildCiPlan(
  changedPathsInput,
  { sourceSha = null, baseSha = null, functionalFiles = null } = {},
) {
  const changedPaths = [
    ...new Set(changedPathsInput.map((path) => toRelative(path))),
  ].sort();
  const impact = planTestImpact(changedPaths);
  const bucket = classifyPolicy(changedPaths);
  const selectionPlan = structuredClone(bucket.plan);
  const escalationReasons = [];
  for (const escalation of POLICY.escalations) {
    if (!impact.highRiskTags.includes(escalation.riskTag)) continue;
    if (escalation.effect.functional) {
      const before = selectionPlan.functional;
      selectionPlan.functional = escalateFunctional(
        selectionPlan.functional,
        escalation.effect.functional,
      );
      if (selectionPlan.functional !== before)
        escalationReasons.push(`${escalation.riskTag}: ${escalation.reason}`);
    }
    if (escalation.effect.functionalUi) {
      const before = selectionPlan.functionalUi;
      selectionPlan.functionalUi = escalateLane(
        selectionPlan.functionalUi,
        escalation.effect.functionalUi,
      );
      if (selectionPlan.functionalUi !== before)
        escalationReasons.push(`${escalation.riskTag}: ${escalation.reason}`);
    }
  }

  const inventory = functionalFiles ?? functionalInventory();
  const selected = selectedFunctionalFiles(selectionPlan.functional);
  const selectedSet = new Set(selected);
  const notInShardWalk = selected.filter((path) => !inventory.includes(path));

  const requiredShards = [];
  for (let index = 1; index <= FUNCTIONAL_SHARD_TOTAL; index += 1) {
    const files = shardFiles(inventory, index, FUNCTIONAL_SHARD_TOTAL);
    if (
      selectionPlan.functional === "full" ||
      files.some((path) => selectedSet.has(path))
    )
      requiredShards.push(index);
  }

  const requiredChecks = {
    static: {
      required: true,
      reason: "always required (lint, types, architecture, naming)",
    },
    unit: {
      required: selectionPlan.unit === "full",
      reason:
        selectionPlan.unit === "full"
          ? `${bucket.name}: core inventory required`
          : `${bucket.name}: core inventory not required by selection`,
    },
    web: {
      required: selectionPlan.web === true,
      reason: selectionPlan.web
        ? `${bucket.name}: web build checks required`
        : `${bucket.name}: web build checks not required by selection`,
    },
    functional: {
      required: selectionPlan.functional !== "none",
      shards: requiredShards,
      reason: `${bucket.name}: functional scope ${selectionPlan.functional}`,
    },
    "functional-ui": {
      required: selectionPlan.functionalUi === "full",
      reason: `${bucket.name}: functional-ui scope ${selectionPlan.functionalUi}`,
    },
    health: {
      required: true,
      reason: "always required (audit + health snapshot)",
    },
  };

  const wouldSkipFunctionalFiles =
    selectionPlan.functional === "full"
      ? []
      : inventory.filter((path) => !selectedSet.has(path));

  return {
    schemaVersion: 1,
    mode: "shadow",
    status: "ok",
    generatedAt: new Date().toISOString(),
    sourceSha,
    baseSha,
    policyDigest: policyDigest(),
    classification: bucket.name,
    classificationReason: bucket.description,
    riskTags: [...new Set([bucket.name, ...impact.highRiskTags])].sort(),
    changedPaths,
    unknownPaths: impact.unknownPaths,
    impact: {
      selectedLanes: impact.selectedLanes,
      laneScopes: Object.fromEntries(
        Object.entries(impact.lanes).map(([lane, detail]) => [
          lane,
          detail.scope,
        ]),
      ),
      highRiskTags: impact.highRiskTags,
      matchedRules: impact.matchedRules,
      impactMapSha256,
    },
    requiredChecks,
    selection: {
      core: { scope: selectionPlan.unit, reason: bucket.description },
      functional: {
        scope: selectionPlan.functional,
        suites:
          selectionPlan.functional === "smoke+risk-selected"
            ? POLICY.functionalSuites["smoke+risk-selected"]
            : [],
        files: selected,
        notInShardWalk,
        shards: shardSummary(inventory, selected),
        shardTotal: FUNCTIONAL_SHARD_TOTAL,
        reasons: [bucket.description, ...escalationReasons],
      },
      functionalUi: {
        scope: selectionPlan.functionalUi,
        files: manifest.groups.functionalUi.length,
        reason: bucket.description,
      },
    },
    shadow: {
      enabled: true,
      wouldSkipChecks: Object.entries(requiredChecks)
        .filter(([, check]) => !check.required)
        .map(([name]) => name),
      wouldSkipFunctionalFiles,
      note: "shadow mode: every lane still runs its complete inventory; this plan only reports what selection would change",
    },
  };
}

function errorPlan(sourceSha, baseSha, error) {
  const digest = policyDigest();
  return {
    schemaVersion: 1,
    mode: "shadow",
    status: "error",
    error: error instanceof Error ? error.message : String(error),
    generatedAt: new Date().toISOString(),
    sourceSha,
    baseSha,
    policyDigest: digest,
    classification: "unclassified",
    classificationReason: `plan generation failed: ${error instanceof Error ? error.message : String(error)}`,
    riskTags: ["unclassified"],
    changedPaths: [],
    unknownPaths: [],
    impact: {
      selectedLanes: [],
      laneScopes: {},
      highRiskTags: [],
      matchedRules: [],
      impactMapSha256,
    },
    requiredChecks: {
      static: { required: true, reason: "always required" },
      unit: {
        required: true,
        reason: "plan error: conservative full selection",
      },
      web: {
        required: true,
        reason: "plan error: conservative full selection",
      },
      functional: {
        required: true,
        shards: Array.from({ length: FUNCTIONAL_SHARD_TOTAL }, (_, i) => i + 1),
        reason: "plan error: conservative full selection",
      },
      "functional-ui": {
        required: true,
        reason: "plan error: conservative full selection",
      },
      health: { required: true, reason: "always required" },
    },
    selection: {
      core: {
        scope: "full",
        reason: "plan error: conservative full selection",
      },
      functional: {
        scope: "full",
        suites: [],
        files: [],
        notInShardWalk: [],
        shards: {},
        shardTotal: FUNCTIONAL_SHARD_TOTAL,
        reasons: ["plan error: conservative full selection"],
      },
      functionalUi: {
        scope: "full",
        files: manifest.groups.functionalUi.length,
        reason: "plan error: conservative full selection",
      },
    },
    shadow: {
      enabled: true,
      wouldSkipChecks: [],
      wouldSkipFunctionalFiles: [],
      note: "plan generation failed; conservative full selection reported",
    },
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
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? "git failed",
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseArguments(args) {
  const options = { changed: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    switch (args[index]) {
      case "--base":
        if (!value) throw new Error("--base requires a Git ref");
        options.base = value;
        index += 1;
        break;
      case "--head":
        if (!value) throw new Error("--head requires a Git ref");
        options.head = value;
        index += 1;
        break;
      case "--output":
        if (!value) throw new Error("--output requires a file path");
        options.output = value;
        index += 1;
        break;
      case "--report":
        if (!value) throw new Error("--report requires a plan JSON path");
        options.report = value;
        index += 1;
        break;
      case "--shard":
        if (!value?.includes("/"))
          throw new Error("--shard requires <index>/<total>");
        options.shard = value;
        index += 1;
        break;
      case "--check":
        if (!value) throw new Error("--check requires a check name");
        options.check = value;
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return options;
}

const shortSha = (sha) =>
  typeof sha === "string" && sha.length >= 8 ? sha.slice(0, 8) : (sha ?? "—");

function listSection(title, paths, cap = 40) {
  if (paths.length === 0) return [];
  const lines = [`- ${title} (${paths.length}):`];
  for (const path of paths.slice(0, cap)) lines.push(`  - \`${path}\``);
  if (paths.length > cap) lines.push(`  - … and ${paths.length - cap} more`);
  return lines;
}

export function planSummaryMarkdown(plan) {
  const selection = plan.selection ?? {};
  const core = selection.core?.scope ?? "—";
  const functional = selection.functional?.scope ?? "—";
  const functionalUi = selection.functionalUi?.scope ?? "—";
  const required = Object.entries(plan.requiredChecks ?? {})
    .filter(([, check]) => check.required)
    .map(([name, check]) =>
      name === "functional" && Array.isArray(check.shards)
        ? `functional (shards ${check.shards.join(",")})`
        : name,
    );
  return [
    "## Arbor CI plan (shadow mode)",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Status | ${plan.status} |`,
    `| Source / base | \`${shortSha(plan.sourceSha)}\` / \`${shortSha(plan.baseSha)}\` |`,
    `| Classification | ${plan.classification} |`,
    `| Risk tags | ${plan.riskTags.join(", ")} |`,
    `| Policy digest | \`${plan.policyDigest}\` |`,
    `| Changed paths | ${plan.changedPaths.length} |`,
    "",
    `- Selection if active: core **${core}** · functional **${functional}** (${selection.functional?.files?.length ?? 0} files) · functional-ui **${functionalUi}**`,
    `- Required checks if active: ${required.join(", ")}`,
    `- Shadow: would skip ${plan.shadow?.wouldSkipFunctionalFiles?.length ?? 0} functional files and ${plan.shadow?.wouldSkipChecks?.length ?? 0} checks.`,
    "",
    plan.shadow?.note ?? "",
    "",
    "> Shadow mode (CI PR 5): this plan changes nothing CI runs today;",
    "> skipped-suggestions must stay green for ten consecutive full runs",
    "> before selection reduces scope (docs/engineering/ci-architecture.md).",
    "",
  ].join("\n");
}

export function shardSummaryMarkdown(plan, index, total) {
  const inventory = functionalInventory();
  const shardFilesForIndex = shardFiles(inventory, index, total);
  const selectedSet = new Set(plan.selection?.functional?.files ?? []);
  const kept = shardFilesForIndex.filter((path) => selectedSet.has(path));
  const skipped = shardFilesForIndex.filter((path) => !selectedSet.has(path));
  const scope = plan.selection?.functional?.scope ?? "—";
  const active = scope !== "none";
  return [
    `## CI plan shadow report — functional shard ${index}/${total}`,
    "",
    `- Plan status: ${plan.status}; classification: ${plan.classification}; functional selection: ${scope}`,
    `- If selection were active this shard would run **${kept.length}** of **${shardFilesForIndex.length}** files.`,
    ...listSection("Files that would be skipped", skipped),
    active
      ? ""
      : "- Selection would not require any functional file for this diff.",
    "",
    "- Shadow mode: this job ran the **full** shard; no test was skipped.",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function checkSummaryMarkdown(plan, checkName) {
  const check = plan.requiredChecks?.[checkName];
  const required = check?.required === true;
  return [
    `## CI plan shadow report — ${checkName}`,
    "",
    `- Plan status: ${plan.status}; classification: ${plan.classification}`,
    `- Required by selection if active: **${required ? "yes" : "no"}** — ${check?.reason ?? "unknown check"}`,
    "",
    `- Shadow mode: this job ran its **complete** inventory; nothing was skipped.`,
    "",
  ].join("\n");
}

function writePlan(path, plan) {
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

function generatePlan(options) {
  const sourceSha = runGit(["rev-parse", options.head ?? "HEAD"])[0];
  const baseSha = runGit(["rev-parse", options.base])[0];
  const changedPaths = runGit([
    "diff",
    "--name-only",
    "--diff-filter=ACMRD",
    "--no-renames",
    `${baseSha}`,
    `${sourceSha}`,
  ]);
  return buildCiPlan(changedPaths, { sourceSha, baseSha });
}

const usage = [
  "Usage:",
  "  node scripts/ci/plan.mjs --base <sha> [--head <sha>] [--output <file>]",
  "  node scripts/ci/plan.mjs --report <plan.json> [--shard <n>/<total> | --check <name>]",
].join("\n");

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else if (options.report) {
      const plan = JSON.parse(readFileSync(options.report, "utf8"));
      if (options.shard) {
        const [index, total] = options.shard.split("/").map(Number);
        if (
          !Number.isInteger(index) ||
          !Number.isInteger(total) ||
          index < 1 ||
          total < 1 ||
          index > total
        )
          throw new Error(`invalid --shard value: ${options.shard}`);
        console.log(shardSummaryMarkdown(plan, index, total));
      } else if (options.check) {
        console.log(checkSummaryMarkdown(plan, options.check));
      } else {
        console.log(planSummaryMarkdown(plan));
      }
    } else {
      if (!options.base) throw new Error("--base is required");
      let plan;
      try {
        plan = generatePlan(options);
      } catch (error) {
        // A broken planner must never fail the workflow or change lane
        // obligations: degrade to a conservative full-selection plan.
        plan = errorPlan(null, null, error);
        console.error(
          `ci plan: generation failed, emitting conservative fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (options.output) writePlan(options.output, plan);
      else console.log(JSON.stringify(plan, null, 2));
    }
  } catch (error) {
    console.error(
      `ci plan: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
