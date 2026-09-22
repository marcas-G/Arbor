import { describe, expect, it } from "vitest";
import type { CommandRejection } from "../packages/application/src/rejection.js";
import type {
  VerificationState,
  WakeCondition,
} from "../packages/domain/src/index.js";
import {
  aggregateVerdict,
  type ConclusionReason,
  concludeVerification,
  parse,
  startVerification,
  type VerificationCriterionType,
  type VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  type WorkId,
  type WorkRevision,
} from "../packages/domain/src/index.js";

const VER_1 = parse(
  (await import("../packages/domain/src/index.js")).VerificationId,
)("ver_00000000-0000-7000-8000-000000000001");
const WORK_1 = parse((await import("../packages/domain/src/index.js")).WorkId)(
  "wrk_00000000-0000-7000-8000-000000000001",
);

const criterion = (
  criterionId: string,
  required = true,
): VerificationCriterionType => ({
  criterionId,
  requirement: `req-${criterionId}`,
  required,
});

const mission = (
  criteria: VerificationCriterionType[],
): VerificationMission => ({
  goal: "g",
  criteria,
  riskRequirements: [],
});

describe("P8-001 M-1: work-level VerificationChanged", () => {
  it("the wake condition carries workId + targetWorkRevision, no verificationId", () => {
    const condition: WakeCondition = {
      _tag: "VerificationChanged",
      workId: WORK_1,
      targetWorkRevision: 0 as never,
    };
    expect(condition._tag).toBe("VerificationChanged");
    expect("verificationId" in condition).toBe(false);
    expect(condition.workId).toBe(WORK_1);
  });
});

describe("P8-001 M-2: structured mission criteria", () => {
  it("criteria are {criterionId, requirement, required}", () => {
    const m = mission([criterion("c1"), criterion("c2", false)]);
    expect(m.criteria[0]!.required).toBe(true);
    expect(m.criteria[1]!.required).toBe(false);
  });
});

describe("P8-001 aggregation (v1.11 G1)", () => {
  const v = (verdict: VerificationVerdict, required = true) => ({
    required,
    verdict,
  });
  it("any required Fail → Fail", () => {
    expect(aggregateVerdict([v("Pass"), v("Fail")])).toBe("Fail");
  });
  it("required unresolved without required Fail → Unknown", () => {
    expect(aggregateVerdict([v("Pass"), v("Unknown")])).toBe("Unknown");
  });
  it("all required Pass → Pass even with optional Fail/Unknown", () => {
    expect(
      aggregateVerdict([v("Pass"), v("Fail", false), v("Unknown", false)]),
    ).toBe("Pass");
  });
  it("truth table over all combos is mechanically pinned", () => {
    const required: VerificationVerdict[] = ["Pass", "Fail", "Unknown"];
    for (const a of required) {
      for (const b of required) {
        const result = aggregateVerdict([v(a), v(b)]);
        const expected =
          a === "Fail" || b === "Fail"
            ? "Fail"
            : a === "Unknown" || b === "Unknown"
              ? "Unknown"
              : "Pass";
        expect(result).toBe(expected);
      }
    }
  });
});

describe("P8-001 Orphaned conclusion (G5)", () => {
  it("Orphaned pairs only with Unknown", () => {
    const open = startVerification({
      verificationId: VER_1,
      workId: WORK_1,
      targetWorkRevision: 0 as never,
      missionSnapshot: mission([criterion("c1")]),
    });
    const bad = concludeVerification(open, "Pass", "Orphaned");
    expect(bad.ok).toBe(false);
    const good = concludeVerification(open, "Unknown", "Orphaned");
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(
        (
          good.value.state as Extract<
            VerificationState,
            { status: "Concluded" }
          >
        ).conclusionReason,
      ).toBe("Orphaned");
    }
  });
});

describe("P8-001 rejection enums + event payloads", () => {
  it("both P8 enums exist as typed rejections", () => {
    const alreadyOpen: CommandRejection = {
      _tag: "VerificationAlreadyOpen",
      workId: WORK_1,
    };
    const invalid: CommandRejection = {
      _tag: "InvalidVerificationMission",
      reason: "goal required",
    };
    expect(alreadyOpen._tag).toBe("VerificationAlreadyOpen");
    expect(invalid._tag).toBe("InvalidVerificationMission");
  });

  it("four event payloads carry their contract fields", async () => {
    const events = await import("../packages/domain/src/events.js");
    const fields = (schema: { fields: object }) =>
      Object.keys(schema.fields).sort();
    expect(fields(events.VerificationStarted)).toEqual(
      [
        "_tag",
        "missionDigest",
        "targetWorkRevision",
        "verificationId",
        "workId",
      ].sort(),
    );
    expect(fields(events.VerificationConcluded)).toEqual(
      [
        "_tag",
        "conclusionReason",
        "evidenceRefs",
        "targetWorkRevision",
        "verificationId",
        "verdict",
        "workId",
      ].sort(),
    );
    expect(fields(events.WorkOutcomeAccepted)).toEqual(
      [
        "_tag",
        "acceptanceId",
        "actor",
        "targetWorkRevision",
        "verificationId",
        "workId",
      ].sort(),
    );
    expect(fields(events.ExecutionSettled)).toEqual(
      ["_tag", "claimRef", "executionId", "workId", "workRevision"].sort(),
    );
  });
});
