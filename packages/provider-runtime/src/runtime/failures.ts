import type { ProviderExecutionTimeout, ProviderFailure } from "@arbor/ports";

export const timeoutFailure = (
  phase: ProviderExecutionTimeout["phase"],
): ProviderExecutionTimeout => ({ _tag: "ProviderExecutionTimeout", phase });

export const unknownFailure = (safeDiagnostic: string): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "UnknownProviderFailure",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic,
});

export const protocolFailure = (safeDiagnostic: string): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "ProtocolViolation",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic,
});

export const cancelledFailure = (): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "Cancelled",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic: "provider-call-cancelled",
});

export const stoppedRecoveryDecision = (reason: string) =>
  ({
    safety: "UnsafeReplay",
    decision: "Stop",
    strategy: null,
    reason,
  }) as const;
