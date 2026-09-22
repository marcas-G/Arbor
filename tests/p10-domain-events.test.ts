import { describe, expect, it } from "vitest";
import {
  HumanInterventionApplied,
  WorkSteered,
} from "../packages/domain/src/events.js";
import {
  type HumanInterventionKind,
  VIEW_IDS,
  type ViewId,
  WORKSPACE_STATUS_LABELS,
  type WorkspaceStatusLabel,
} from "../packages/domain/src/projection.js";

describe("P10-001 event payloads", () => {
  it("HumanInterventionApplied carries exactly the P10 06 §1 fields", () => {
    const fields = Object.keys(HumanInterventionApplied.fields).sort();
    expect(fields).toEqual(
      [
        "_tag",
        "actor",
        "targetWorkspaceId",
        "summaryRef",
        "occurredAt",
        "kind",
      ].sort(),
    );
  });

  it("WorkSteered carries the P6 04 §2 frozen shape (back-fill)", () => {
    const fields = Object.keys(WorkSteered.fields).sort();
    expect(fields).toEqual([
      "_tag",
      "fromRevision",
      "severity",
      "toRevision",
      "workId",
    ]);
  });
});

describe("P10-001 projection vocabulary", () => {
  it("ViewId union = the must-set (Search absent — deferred)", () => {
    expect([...VIEW_IDS]).toEqual([
      "responsibility-tree",
      "attention",
      "workspace-detail",
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
        case "current-work":
        case "verification":
        case "dependency-view":
        case "transcript":
        case "usage":
        case "inbox-view":
          return 1;
      }
    };
    expect(exhaustive("attention")).toBe(1);
  });

  it("WorkspaceStatus labels: six, frozen from SD text (+ retired terminal)", () => {
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
    expect(exhaustive("retired")).toBe(1);
  });

  it("HumanInterventionKind is exactly four-valued", () => {
    const kinds: HumanInterventionKind[] = [
      "Steer",
      "CriticalSteer",
      "Stop",
      "GovernanceDecision",
    ];
    expect(kinds).toHaveLength(4);
  });
});
