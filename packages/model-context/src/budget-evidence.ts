import { estimateTextTokens } from "./request-budget.js";

export type BudgetEvidence =
  | { readonly kind: "ProviderObserved"; readonly tokens: number }
  | { readonly kind: "ModelEstimator"; readonly tokens: number }
  | { readonly kind: "AdapterEstimator"; readonly tokens: number }
  | { readonly kind: "CharsPerFourFallback"; readonly tokens: number };

export const resolveBudgetEvidence = (input: {
  readonly providerObserved?: number;
  readonly modelEstimate?: number;
  readonly adapterEstimate?: number;
  readonly fallbackText: string;
}): BudgetEvidence => {
  if (input.providerObserved !== undefined)
    return { kind: "ProviderObserved", tokens: input.providerObserved };
  if (input.modelEstimate !== undefined)
    return { kind: "ModelEstimator", tokens: input.modelEstimate };
  if (input.adapterEstimate !== undefined)
    return { kind: "AdapterEstimator", tokens: input.adapterEstimate };
  return {
    kind: "CharsPerFourFallback",
    tokens: estimateTextTokens(input.fallbackText),
  };
};

export const nativeCheckpointCompatible = (
  checkpointBindingFingerprint: string | undefined,
  activeBindingFingerprint: string,
): boolean =>
  checkpointBindingFingerprint !== undefined &&
  checkpointBindingFingerprint === activeBindingFingerprint;

export const decideContextOverflowRecovery = (input: {
  readonly recoveryAttempt: number;
  readonly durableAssistantOutput: boolean;
  readonly durableEffect: boolean;
}): "CompactAndRetry" | "Stop" =>
  input.recoveryAttempt === 0 &&
  !input.durableAssistantOutput &&
  !input.durableEffect
    ? "CompactAndRetry"
    : "Stop";
