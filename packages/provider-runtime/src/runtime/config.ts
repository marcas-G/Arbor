import type {
  ProviderFailure,
  ProviderRuntimeExecutionPolicy,
} from "@arbor/ports";

export interface ProviderRuntimeConfig {
  readonly systemDefault?: ProviderRuntimeExecutionPolicy;
  readonly providerDefault?: Partial<ProviderRuntimeExecutionPolicy>;
  /**
   * Gate C `03` §1.2/§1.3 (INV-C1-2): the adapter's declared usage
   * capabilities, supplied by the Composition Root from the resolved
   * binding's ProviderProfile. An adapter that declares
   * `reportsCacheTokens: false` must never emit cache token values —
   * violations fail the attempt closed.
   */
  readonly adapterUsageConstraints?: {
    readonly reportsCacheTokens: boolean;
  };
  /**
   * Gate C `03` §2.1 (C2): the binding identity a continuation checkpoint
   * must carry to be resumable; absent = legacy checkpoints are rejected
   * (stale continuation, never silently replayed).
   */
  readonly continuationBinding?: {
    readonly adapterId: string;
    readonly bindingFingerprint: string;
  };
  /** Explicit process-local crash qualification seam. Production Composition
   * leaves it absent; it is never sourced from a request or env var. */
  readonly qualificationProbe?: (
    event:
      | {
          readonly boundary:
            | "AH12BeforeSuccessCommit"
            | "AH12AfterSuccessCommit";
          readonly providerTurnId: string;
          readonly attemptNo: number;
        }
      | {
          readonly boundary:
            | "AH18BeforeSummaryTurnCommit"
            | "AH18AfterSummaryTurnCommit";
          readonly providerTurnId: string;
          readonly executionId: string;
        }
      | {
          readonly boundary: "AH18AfterSummaryRetryableFailureCommit";
          readonly providerTurnId: string;
          readonly executionId: string;
          readonly attemptNo: number;
          readonly failureKind: ProviderFailure["kind"];
        }
      | {
          readonly boundary:
            | "RAI-DG02BeforeFinalAttemptSettlementCommit"
            | "RAI-DG02AfterFinalAttemptSettlementCommit";
          readonly providerTurnId: string;
          readonly attemptNo: number;
          readonly failureKind: ProviderFailure["kind"];
        },
  ) => Promise<void>;
}
