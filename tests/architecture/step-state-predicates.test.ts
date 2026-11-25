import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

const STEP_STATES = new Set([
  "Prepared",
  "ProviderResultAvailable",
  "OutputRejected",
  "OutputAccepted",
  "ActionsInProgress",
  "StepEffectsCommitted",
  "NextStepReady",
  "SettlementProposed",
]);

const productionRoots = [
  "packages/agent-runtime/src",
  "packages/execution-runtime/src",
  "packages/tool-runtime/src",
  "packages/application/src",
  "packages/projection-runtime/src",
  "apps/single-workspace/src",
  "adapters/persistence-sqlite/src",
];

const listFiles = (directory: string): ReadonlyArray<string> => {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { encoding: "utf8" })) {
      const absolute = join(path, entry);
      if (entry === "dist" || entry === "node_modules") continue;
      if (entry.endsWith(".ts")) out.push(absolute);
      else if (!entry.includes(".")) walk(absolute);
    }
  };
  walk(join(repoRoot, directory));
  return out;
};

/**
 * Code-organization Rule 3 (docs/engineering/code-organization.md):
 * state-set decisions go through the predicates owned by the state's
 * defining package, never through a hand-written multi-state comparison
 * chain at a use site. This test fails on any new chain that compares a
 * `.state` (or state-typed binding) against two or more AgentLoopStep
 * state literals, which is the shape every historical chain took.
 * Existing chains are listed in source-governance-backlog.md and shrink
 * as seams migrate; growth of that inventory is a regression.
 */
describe("owned state predicates (code-organization Rule 3)", () => {
  for (const root of productionRoots) {
    it(`keeps ${root} free of hand-written step-state chains`, () => {
      const offenders: Array<{ file: string; line: number; text: string }> = [];
      for (const file of listFiles(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        let run = 0;
        for (const [index, line] of lines.entries()) {
          const matches = [...line.matchAll(/===\s*"([A-Za-z]+)"/g)].filter(
            (match) => STEP_STATES.has(match[1] ?? ""),
          );
          if (matches.length > 0) {
            run += matches.length;
          } else if (run > 0) {
            run = 0;
          }
          if (run >= 2) {
            offenders.push({
              file: file.slice(repoRoot.length + 1),
              line: index + 1,
              text: line.trim().slice(0, 100),
            });
            run = 0;
          }
        }
      }
      // Frozen inventory at adoption (2026-11-25): 13 chains across
      // agent-loop-actions, driver/cursor, startup-recovery and
      // recovery-decision. Must not grow; each entry disappears when its
      // seam migrates to an owned predicate.
      const frozenAllowance = 13;
      expect(
        offenders.length,
        `hand-written step-state chains (allowed ${frozenAllowance}):\n${offenders
          .map((o) => `${o.file}:${o.line} ${o.text}`)
          .join("\n")}`,
      ).toBeLessThanOrEqual(frozenAllowance);
    });
  }
});
