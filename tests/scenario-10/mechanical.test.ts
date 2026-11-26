import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VIEW_IDS,
  type ViewId,
  WORKSPACE_STATUS_LABELS,
  type WorkspaceStatusLabel,
} from "../../packages/domain/dist/index.js";

describe("-acceptance mechanical assertion list (07 Mechanical)", () => {
  it("ViewId set equals the 01 must-set exactly; the dispatch switch is exhaustive", () => {
    expect([...VIEW_IDS]).toEqual([
      "responsibility-tree",
      "attention",
      "workspace-detail",
      "work-detail",
      "current-work",
      "verification",
      "dependency-view",
      "transcript",
      "usage",
      "inbox-view",
    ]);
    const exhaustive = (view: ViewId): 1 => {
      switch (view) {
        case "responsibility-tree":
        case "attention":
        case "workspace-detail":
        case "work-detail":
        case "current-work":
        case "verification":
        case "dependency-view":
        case "transcript":
        case "usage":
        case "inbox-view":
          return 1;
      }
    };
    for (const view of VIEW_IDS) {
      expect(exhaustive(view)).toBe(1);
    }
  });

  it("WorkspaceStatus label map: six frozen labels; exhaustive switch incl. the retired terminal", () => {
    expect([...WORKSPACE_STATUS_LABELS]).toEqual([
      "executing",
      "waiting-runnable",
      "waiting-blocked",
      "idle",
      "retired",
      "attention-flagged",
    ]);
    const exhaustive = (label: WorkspaceStatusLabel): 1 => {
      switch (label) {
        case "executing":
        case "waiting-runnable":
        case "waiting-blocked":
        case "idle":
        case "retired":
        case "attention-flagged":
          return 1;
      }
    };
    for (const label of WORKSPACE_STATUS_LABELS) {
      expect(exhaustive(label)).toBe(1);
    }
  });

  it("consume-only: no promptPrograms redefinition in the P10 tree; the six P8/P6-frozen families stand untouched", () => {
    const repoRoot = join(import.meta.dirname, "../..");
    const walk = (
      dir: string,
      sink: Array<string> = [],
    ): ReadonlyArray<string> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path, sink);
        } else if (entry.name.endsWith(".ts")) {
          sink.push(path);
        }
      }
      return sink;
    };
    for (const tree of [
      "packages/projection-runtime/src",
      "packages/api-contracts/src",
    ]) {
      for (const file of walk(join(repoRoot, tree))) {
        expect(
          readFileSync(file, "utf8").includes("promptPrograms"),
          `${file}: P10 must not redefine P8-owned prompt programs`,
        ).toBe(false);
      }
    }
    const families = readdirSync(
      join(repoRoot, "packages/agent-runtime/promptPrograms"),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(families).toEqual([
      "bootstrap",
      "communication",
      "formation",
      "human-steer",
      "query-inspection",
      "verification",
    ]);
    for (const family of families) {
      expect(
        existsSync(
          join(
            repoRoot,
            "packages/agent-runtime/promptPrograms",
            family,
            "v1.md",
          ),
        ),
        family,
      ).toBe(true);
    }
    const queryProgram = readFileSync(
      join(
        repoRoot,
        "packages/agent-runtime/promptPrograms/query-inspection/v1.md",
      ),
      "utf8",
    );
    expect(queryProgram.includes("contractRevision: P8-05@1")).toBe(true);
    expect(queryProgram.includes("P14")).toBe(true);
  });

  it("–P9 regression guards referenced: the architecture guard suites stand in tests/architecture", () => {
    const repoRoot = join(import.meta.dirname, "../..");
    for (const phase of [5, 6, 7, 8, 9]) {
      const guardPath = join(
        repoRoot,
        `tests/architecture/p${phase}-architecture.test.ts`,
      );
      expect(existsSync(guardPath), guardPath).toBe(true);
      expect(readFileSync(guardPath, "utf8").includes("describe(")).toBe(true);
    }
  });
});
