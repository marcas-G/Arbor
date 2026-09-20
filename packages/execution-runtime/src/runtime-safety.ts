import type { ExecutionId } from "@arbor/domain";
import {
  type ExecutionActivity,
  RuntimeSafetyGate,
  type SafetyDecision,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

export interface RuntimeSafetyOptions {
  readonly maxRepeatedFingerprints?: number;
}

/**
 * P2-owned execution-wide Runtime Safety / control gating (DID v1.7 G4).
 * P3's driver must call `admitActivity` at every new ProviderTurn /
 * ToolInvocation / Specialist action boundary.
 */
export const RuntimeSafetyGateLive = (
  options: RuntimeSafetyOptions = {},
): Layer.Layer<RuntimeSafetyGate> => {
  const max = options.maxRepeatedFingerprints ?? 3;
  return Layer.effect(
    RuntimeSafetyGate,
    Effect.sync(() => {
      const counts = new Map<string, number>();
      return RuntimeSafetyGate.of({
        admitActivity: (
          executionId: ExecutionId,
          activity: ExecutionActivity,
        ): Effect.Effect<SafetyDecision> =>
          Effect.sync(() => {
            const key = `${executionId}:${activity._tag}:${activity.fingerprint}`;
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return next > max ? "Stop" : "Continue";
          }),
      });
    }),
  );
};
