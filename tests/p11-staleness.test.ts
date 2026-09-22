import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as stalenessModule from "../packages/application/src/environment-staleness.js";
import {
  type EnvironmentChangeFact,
  ownershipClaimFreshness,
  staleAttentionRow,
  verificationFreshness,
} from "../packages/application/src/environment-staleness.js";
import {
  type CanonicalResourceRegion,
  concludeVerification,
  parse,
  startVerification,
  type Verification,
  VerificationId,
  type VerificationVerdict,
  WorkId,
  type WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";

// -- fixtures --

const WS_ID = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789e1");
const WORK_ID = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789e1");
const VER_ID = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789e1",
);

const MODULE_PATH = join(
  import.meta.dirname,
  "..",
  "packages",
  "application",
  "src",
  "environment-staleness.ts",
);

/** Resolved canonical region fixture (P11-005 round-1 rule: never a raw
 * ResourceAddress). */
const region = (
  path: string,
  resourceSpaceId = "space-fs",
): CanonicalResourceRegion =>
  ({
    resourceSpaceId,
    normalizedRegion: { kind: "FileTree", path },
  }) as CanonicalResourceRegion;

const concludedVerification = (
  verdict: VerificationVerdict,
  targetEnvironmentRevision: string | null,
): Verification => {
  const started = startVerification({
    verificationId: VER_ID,
    workId: WORK_ID,
    targetWorkRevision: 1 as WorkRevision,
    missionSnapshot: {
      goal: "verify the outcome",
      criteria: [
        { criterionId: "c1", requirement: "must hold", required: true },
      ],
      riskRequirements: [],
    },
    targetEnvironmentRevision,
  });
  const result = concludeVerification(started, verdict);
  if (!result.ok) {
    throw new Error(`concludeVerification failed: ${result.error._tag}`);
  }
  return result.value;
};

describe("p11-staleness (P11-007 Verdict × Freshness derived overlay)", () => {
  it("four states: same stored verdict, derived freshness differs — the verdict string never changes", () => {
    const advancedOverlap: ReadonlyArray<EnvironmentChangeFact> = [
      { toRevision: "2", changedRegions: [region("/pkg-a")] },
    ];
    const alreadySeen: ReadonlyArray<EnvironmentChangeFact> = [
      { toRevision: "1", changedRegions: [region("/pkg-a")] },
    ];

    // PASS+CURRENT: the change did not advance past the bound revision
    // (equality is already-seen — counters compared numerically).
    const passCurrent = concludedVerification("Pass", "1");
    expect(
      verificationFreshness(
        {
          targetEnvironmentRevision: passCurrent.targetEnvironmentRevision,
          boundRegions: [region("/pkg-a/module-1")],
        },
        alreadySeen,
      ),
    ).toBe("CURRENT");
    expect(passCurrent.state).toEqual({ status: "Concluded", verdict: "Pass" });

    // PASS+STALE / FAIL+STALE / UNKNOWN+STALE: same change, same bound
    // regions — only the derived freshness differs, never the verdict.
    for (const verdict of ["Pass", "Fail", "Unknown"] as const) {
      const verification = concludedVerification(verdict, "1");
      const before = structuredClone(verification);
      expect(
        verificationFreshness(
          {
            targetEnvironmentRevision: verification.targetEnvironmentRevision,
            boundRegions: [region("/pkg-a/module-1")],
          },
          advancedOverlap,
        ),
      ).toBe("STALE");
      expect(verification.state).toEqual({
        status: "Concluded",
        verdict,
      });
      expect(verification).toEqual(before);
    }
  });

  it("revision advanced but changedRegions do not overlap the bound regions → CURRENT (narrow rule)", () => {
    expect(
      verificationFreshness(
        { targetEnvironmentRevision: "1", boundRegions: [region("/pkg-a")] },
        [{ toRevision: "2", changedRegions: [region("/pkg-z")] }],
      ),
    ).toBe("CURRENT");
    // canonical spaces differ → never overlaps, even on the same path
    expect(
      verificationFreshness(
        {
          targetEnvironmentRevision: "1",
          boundRegions: [region("/pkg-a", "space-fs")],
        },
        [
          {
            toRevision: "2",
            changedRegions: [region("/pkg-a", "space-git")],
          },
        ],
      ),
    ).toBe("CURRENT");
  });

  it("boundRegions absent → conservative STALE on any advanced revision, even non-overlapping", () => {
    expect(
      verificationFreshness({ targetEnvironmentRevision: "1" }, [
        { toRevision: "2", changedRegions: [region("/pkg-z")] },
      ]),
    ).toBe("STALE");
  });

  it("targetEnvironmentRevision null (static review, P8 B-7) is forever CURRENT", () => {
    expect(
      verificationFreshness(
        { targetEnvironmentRevision: null, boundRegions: [region("/pkg-a")] },
        [{ toRevision: "2", changedRegions: [region("/pkg-a")] }],
      ),
    ).toBe("CURRENT");
  });

  it("three prohibitions (07 §2) hold mechanically: no verdict literals, no write/runtime surface, exports are the pure derivation functions only", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    // No path produces or rewrites a verdict value: the literals that a
    // PASS→FAIL / PASS→UNKNOWN auto-flip would need do not exist.
    for (const literal of ['"Pass"', '"Fail"', '"Unknown"']) {
      expect(source.includes(literal), literal).toBe(false);
    }
    // No command/store/journal/transaction surface of any kind — the
    // module cannot write anything, so no auto-re-verify-and-accept.
    for (const forbidden of [
      "Effect",
      "Gateway",
      "Repository",
      "Store",
      "Journal",
      "PendingDomainEvent",
      ".transact",
      ".insert",
      ".update",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    // Enumerated export surface: exactly the three pure functions
    // (types are erased at runtime).
    expect(Object.keys(stalenessModule).sort()).toEqual([
      "ownershipClaimFreshness",
      "staleAttentionRow",
      "verificationFreshness",
    ]);
  });

  it("staleAttentionRow: EnvironmentInvalidation Attention row shape; dedupKey = source identity × invalidating toRevision", () => {
    expect(
      staleAttentionRow({
        kind: "verification",
        verificationId: VER_ID,
        targetWorkspaceId: WS_ID,
        invalidatingToRevision: "2",
      }),
    ).toEqual({
      source: "EnvironmentInvalidation",
      severity: "Attention",
      targetWorkspaceId: WS_ID,
      dedupKey: `environment-invalidation:verification:${VER_ID}:2`,
    });
    // a different invalidating change is a different fact (dedup distinct)
    const atTwo = staleAttentionRow({
      kind: "verification",
      verificationId: VER_ID,
      targetWorkspaceId: WS_ID,
      invalidatingToRevision: "2",
    }).dedupKey;
    const atThree = staleAttentionRow({
      kind: "verification",
      verificationId: VER_ID,
      targetWorkspaceId: WS_ID,
      invalidatingToRevision: "3",
    }).dedupKey;
    expect(atTwo).not.toBe(atThree);
    expect(
      staleAttentionRow({
        kind: "ownership-claim",
        claimId: "clm_stale-1",
        targetWorkspaceId: WS_ID,
        invalidatingToRevision: "4",
      }),
    ).toEqual({
      source: "EnvironmentInvalidation",
      severity: "Attention",
      targetWorkspaceId: WS_ID,
      dedupKey: "environment-invalidation:ownership-claim:clm_stale-1:4",
    });
  });

  it("ownership claim rides the same rule (07 §3 boundary views)", () => {
    const claim = {
      resolvedAtEnvironmentRevision: "3",
      regions: [region("/boundary/x")],
    };
    expect(
      ownershipClaimFreshness(claim, [
        { toRevision: "4", changedRegions: [region("/boundary")] },
      ]),
    ).toBe("STALE");
    // equality is already-seen; disjoint regions stay narrow
    expect(
      ownershipClaimFreshness(claim, [
        { toRevision: "3", changedRegions: [region("/boundary")] },
      ]),
    ).toBe("CURRENT");
    expect(
      ownershipClaimFreshness(claim, [
        { toRevision: "4", changedRegions: [region("/elsewhere")] },
      ]),
    ).toBe("CURRENT");
  });
});
