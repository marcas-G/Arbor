export type ReconciliationScenario = {
  readonly boundary: string;
  readonly semantics: "Reconcilable" | "NonIdempotent";
  readonly reconciliationMode?: "NotOccurred" | "Occurred" | "StillUnknown";
  readonly profileDrift?: "version" | "hash" | "effect-key";
  readonly resourceChangeDuringReconcile?: boolean;
  readonly reconciliationDrift?: "authority" | "approval" | "stop";
  readonly takeoverDuringReconciliationIo?: boolean;
  readonly proofMismatch?: "attemptNo" | "visibilityScopeSha256";
  readonly killDuringReconciliationIo?: boolean;
  readonly recoveryCrashBoundary?:
    | "AH7BeforeToolSettlementCommit"
    | "AH7AfterToolSettlementCommit"
    | "AH7BeforeActionResultCommit"
    | "AH7AfterActionResultCommit";
};

// Ordinary production composition registers shell@3 as NonIdempotent. The
// test-only Reconcilable profile is available only in scenarios that inject
// a reconciliationMode through reconciliationChild below.

export const AH7_SCENARIOS: ReadonlyArray<ReconciliationScenario> = [
  {
    boundary: "AH7AfterToolIntentCommit",
    semantics: "NonIdempotent",
  },
  {
    boundary: "AH7AfterToolEffectBeforeSettlement",
    semantics: "NonIdempotent",
  },
  {
    boundary: "AH7AfterEffectAdmissionCommit",
    semantics: "Reconcilable",
    reconciliationMode: "NotOccurred",
    takeoverDuringReconciliationIo: true,
  },
  ...(["attemptNo", "visibilityScopeSha256"] as const).map((proofMismatch) => ({
    boundary: "AH7AfterEffectAdmissionCommit" as const,
    semantics: "Reconcilable" as const,
    reconciliationMode: "NotOccurred" as const,
    takeoverDuringReconciliationIo: true,
    proofMismatch,
  })),
  {
    boundary: "AH7AfterEffectAdmissionCommit",
    semantics: "Reconcilable",
    reconciliationMode: "NotOccurred",
    killDuringReconciliationIo: true,
  },
  {
    boundary: "AH7AfterEffectAdmissionCommit",
    semantics: "Reconcilable",
    reconciliationMode: "NotOccurred",
    resourceChangeDuringReconcile: true,
  },
  ...(["authority", "approval", "stop"] as const).map(
    (reconciliationDrift) => ({
      boundary: "AH7AfterEffectAdmissionCommit" as const,
      semantics: "Reconcilable" as const,
      reconciliationMode: "NotOccurred" as const,
      reconciliationDrift,
    }),
  ),
  {
    boundary: "AH7AfterToolEffectBeforeSettlement",
    semantics: "Reconcilable",
    reconciliationMode: "Occurred",
  },
  {
    boundary: "AH7AfterEffectAdmissionCommit",
    semantics: "Reconcilable",
    reconciliationMode: "StillUnknown",
  },
  ...(
    ["AH7BeforeActionResultCommit", "AH7AfterActionResultCommit"] as const
  ).map((recoveryCrashBoundary) => ({
    boundary: "AH7AfterEffectAdmissionCommit" as const,
    semantics: "Reconcilable" as const,
    reconciliationMode: "StillUnknown" as const,
    recoveryCrashBoundary,
  })),
  ...(["version", "hash", "effect-key"] as const).map((profileDrift) => ({
    boundary: "AH7AfterEffectAdmissionCommit" as const,
    semantics: "Reconcilable" as const,
    reconciliationMode: "NotOccurred" as const,
    profileDrift,
  })),
  ...(["NotOccurred", "Occurred"] as const).flatMap((reconciliationMode) =>
    (
      ["AH7BeforeToolSettlementCommit", "AH7AfterToolSettlementCommit"] as const
    ).map((recoveryCrashBoundary) => ({
      boundary:
        reconciliationMode === "Occurred"
          ? ("AH7AfterToolEffectBeforeSettlement" as const)
          : ("AH7AfterEffectAdmissionCommit" as const),
      semantics: "Reconcilable" as const,
      reconciliationMode,
      recoveryCrashBoundary,
      resourceChangeDuringReconcile: true,
    })),
  ),
  ...(["NotOccurred", "Occurred"] as const).flatMap((reconciliationMode) =>
    (
      ["AH7BeforeActionResultCommit", "AH7AfterActionResultCommit"] as const
    ).map((recoveryCrashBoundary) => ({
      boundary:
        reconciliationMode === "Occurred"
          ? ("AH7AfterToolEffectBeforeSettlement" as const)
          : ("AH7AfterEffectAdmissionCommit" as const),
      semantics: "Reconcilable" as const,
      reconciliationMode,
      recoveryCrashBoundary,
    })),
  ),
];

export interface Ah7ScenarioFlags extends ReconciliationScenario {
  readonly mismatchedProofIsUnknown: boolean;
  readonly testName: string;
  readonly preserveTakeoverFixtureOnFailure: boolean;
  readonly noEffectRetryDenied: boolean;
  readonly resumesUnadmittedIntent: boolean;
}

export const ah7ScenarioFlags = (
  scenario: ReconciliationScenario,
): Ah7ScenarioFlags => {
  const {
    boundary,
    semantics,
    reconciliationMode,
    profileDrift,
    resourceChangeDuringReconcile,
    reconciliationDrift,
    takeoverDuringReconciliationIo,
    proofMismatch,
    killDuringReconciliationIo,
    recoveryCrashBoundary,
  } = scenario;

  const mismatchedProofIsUnknown = proofMismatch !== undefined;
  const testName =
    profileDrift !== undefined
      ? `fails closed on trusted profile ${profileDrift} drift before source reconciliation`
      : reconciliationMode === "StillUnknown" &&
          recoveryCrashBoundary?.includes("ActionResult")
        ? `preserves the P9 escalation and resumes StillUnknown P3 projection across ${recoveryCrashBoundary}`
        : mismatchedProofIsUnknown
          ? `rejects G1 ${proofMismatch} proof after G0/G1 source-I/O takeover`
          : reconciliationMode !== undefined
            ? killDuringReconciliationIo
              ? "restarts after SIGKILL during reconciliation source lookup"
              : takeoverDuringReconciliationIo
                ? "fences gen0 after delayed reconciliation I/O while gen1 retries the same invocation"
                : resourceChangeDuringReconcile
                  ? recoveryCrashBoundary === undefined
                    ? "revalidates the Workspace resource snapshot after NotOccurred reconciliation I/O"
                    : `qualifies the P40 ${reconciliationMode} selection across ${recoveryCrashBoundary}`
                  : reconciliationDrift !== undefined
                    ? `rejects NotOccurred retry after ${reconciliationDrift} drift during reconciliation I/O`
                    : recoveryCrashBoundary === undefined
                      ? `recovers ${reconciliationMode} from a test-only trusted profile after a daemon restart`
                      : `recovers ${reconciliationMode} across ${recoveryCrashBoundary}`
            : boundary === "AH7AfterToolIntentCommit"
              ? "resumes a NotAdmitted shell intent from its persisted ProviderTurn"
              : `does not replay an ambiguous ${semantics} shell effect after ${boundary}`;
  const preserveTakeoverFixtureOnFailure =
    takeoverDuringReconciliationIo === true;
  const noEffectRetryDenied =
    reconciliationMode === "NotOccurred" &&
    (resourceChangeDuringReconcile || reconciliationDrift !== undefined);
  const resumesUnadmittedIntent = boundary === "AH7AfterToolIntentCommit";
  return {
    ...scenario,
    mismatchedProofIsUnknown,
    testName,
    preserveTakeoverFixtureOnFailure,
    noEffectRetryDenied,
    resumesUnadmittedIntent,
  };
};

export const ah7ScenarioTestName = (scenario: ReconciliationScenario): string =>
  ah7ScenarioFlags(scenario).testName;

export type Ah7ScenarioFamily =
  | "non-idempotent-boundary"
  | "profile-drift"
  | "g0-g1-takeover"
  | "sigkill-recovery"
  | "retry-denied"
  | "recovery-crash-boundary";

// Mirrors the recovery-phase dispatch of the pre-split single test body: the
// conditions appear in the same order, so every scenario routes to the family
// that owned its branch there.
export const ah7ScenarioFamily = (
  scenario: ReconciliationScenario,
): Ah7ScenarioFamily => {
  const {
    semantics,
    reconciliationMode,
    profileDrift,
    resourceChangeDuringReconcile,
    reconciliationDrift,
    takeoverDuringReconciliationIo,
    killDuringReconciliationIo,
    recoveryCrashBoundary,
  } = scenario;
  const noEffectRetryDenied =
    reconciliationMode === "NotOccurred" &&
    (resourceChangeDuringReconcile || reconciliationDrift !== undefined);
  if (semantics === "NonIdempotent") return "non-idempotent-boundary";
  if (profileDrift !== undefined) return "profile-drift";
  if (
    reconciliationMode !== undefined &&
    noEffectRetryDenied &&
    !takeoverDuringReconciliationIo &&
    !recoveryCrashBoundary?.includes("ActionResult")
  ) {
    return "retry-denied";
  }
  if (reconciliationMode === "NotOccurred" && killDuringReconciliationIo) {
    return "sigkill-recovery";
  }
  if (reconciliationMode !== undefined && takeoverDuringReconciliationIo) {
    return "g0-g1-takeover";
  }
  if (reconciliationMode !== undefined) return "recovery-crash-boundary";
  throw new Error(
    `AH7 scenario maps to no split family: ${JSON.stringify(scenario)}`,
  );
};

export const ah7FamilyScenarios = (
  family: Ah7ScenarioFamily,
): ReadonlyArray<ReconciliationScenario> =>
  AH7_SCENARIOS.filter((scenario) => ah7ScenarioFamily(scenario) === family);
