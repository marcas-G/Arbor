import type { ExecutionId } from "@arbor/domain";
import {
  type ExecutionActivity,
  RuntimeSafetyGate,
  type RuntimeSafetyObservation,
  type SafetyDecision,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/**
 * P12 `08` §6 (E-03): the Runtime Safety Envelope injection surface. The
 * six DID §8.16A dimensions are configured here; numeric thresholds are
 * configuration, not contract (P2 `02` §5). No dimension may be silently
 * defaulted to "unlimited" — every field is a finite ceiling.
 */
export interface RuntimeSafetyPolicy {
  /** D1: max transient retries per operation. */
  readonly maxRetries: number;
  /** D2: max repeated identical action fingerprints. */
  readonly maxRepeatedFingerprints: number;
  /** D3: max tool recursion / chaining depth. */
  readonly maxRecursionDepth: number;
  /** D4: max consecutive turns without durable progress. */
  readonly maxNoProgressTurns: number;
  /** D5: provider / tool concurrency ceiling. */
  readonly concurrencyCeiling: number;
  /** D6: max requests inside the rate window. */
  readonly rateLimit: number;
  /** D6: sliding rate-window width in milliseconds (R-06). */
  readonly rateWindowMs: number;
}

/**
 * Composition fallback. Finite on every dimension; the Composition Root
 * supplies an explicit policy (see `SliceConfig.runtimeSafetyPolicy`).
 */
export const DEFAULT_RUNTIME_SAFETY_POLICY: RuntimeSafetyPolicy = {
  maxRetries: 3,
  maxRepeatedFingerprints: 3,
  maxRecursionDepth: 8,
  maxNoProgressTurns: 24,
  concurrencyCeiling: 16,
  rateLimit: 1_000,
  rateWindowMs: 60_000,
};

/**
 * In-process, per-Execution gate state (P9 `03` §4 / RG-11): never
 * persisted, reset on daemon restart. `agent_execution_state` is not used.
 */
interface ExecutionSafetyState {
  /** D1: retry ordinal of the current provider operation. */
  retry: number;
  /** D2: count per action fingerprint. */
  fingerprints: Map<string, number>;
  /** D3: recursion / chaining depth of the current chain. */
  chainDepth: number;
  /** D4: consecutive no-durable-progress turns. */
  noProgressTurns: number;
  /** D5: lease-scoped in-flight gauge, keyed by lease generation. */
  inFlight: Map<string, number>;
  /** D5: the lease generation the gauge is currently scoped to. */
  leaseGeneration: string | null;
  /** D6: observedAt timestamps (epoch ms) inside the rate window. */
  rate: Array<number>;
}

const freshState = (): ExecutionSafetyState => ({
  retry: 0,
  fingerprints: new Map(),
  chainDepth: 0,
  noProgressTurns: 0,
  inFlight: new Map(),
  leaseGeneration: null,
  rate: [],
});

const stateFor = (
  states: Map<string, ExecutionSafetyState>,
  executionId: ExecutionId,
): ExecutionSafetyState => {
  const key = String(executionId);
  const existing = states.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const state = freshState();
  states.set(key, state);
  return state;
};

const evaluate = (
  policy: RuntimeSafetyPolicy,
  state: ExecutionSafetyState,
  activity: ExecutionActivity,
  observation: RuntimeSafetyObservation | undefined,
): SafetyDecision => {
  let stop = false;

  // D2 — repeated identical action fingerprints. Durable progress clears
  // the per-fingerprint counts (P12 `08` §3).
  if (observation?.durableProgress === true) {
    state.fingerprints.clear();
  }
  const fingerprintKey = `${activity._tag}:${activity.fingerprint}`;
  const fingerprintCount = (state.fingerprints.get(fingerprintKey) ?? 0) + 1;
  state.fingerprints.set(fingerprintKey, fingerprintCount);
  if (fingerprintCount > policy.maxRepeatedFingerprints) {
    stop = true;
  }

  // D1 — transient retries per operation. `retryCount` 0 starts a new
  // operation (reset); otherwise the ordinal is monotonic within the op.
  if (observation?.retryCount !== undefined) {
    state.retry =
      observation.retryCount === 0
        ? 0
        : Math.max(state.retry, observation.retryCount);
    if (state.retry >= policy.maxRetries) {
      stop = true;
    }
  }

  // D3 — tool recursion / chaining depth. Depth 0 starts a new chain.
  if (observation?.chainDepth !== undefined) {
    state.chainDepth = observation.chainDepth;
    if (state.chainDepth > policy.maxRecursionDepth) {
      stop = true;
    }
  }

  // D4 — consecutive turns without durable progress, evaluated at a turn
  // boundary. An in-flight `end` bracket is not a turn boundary.
  if (activity._tag === "ProviderTurn" && observation?.inFlight !== "end") {
    if (observation?.durableProgress === true) {
      state.noProgressTurns = 0;
    } else {
      state.noProgressTurns += 1;
    }
    if (state.noProgressTurns > policy.maxNoProgressTurns) {
      stop = true;
    }
  }

  // D5 — lease-scoped in-flight gauge. A new lease generation discards the
  // previous gauge so a stale lease never counts against the live lease.
  if (
    observation?.inFlight !== undefined &&
    observation.leaseGeneration !== undefined
  ) {
    const generation = String(observation.leaseGeneration);
    if (state.leaseGeneration !== generation) {
      state.inFlight.clear();
      state.leaseGeneration = generation;
    }
    const current = state.inFlight.get(generation) ?? 0;
    if (observation.inFlight === "begin") {
      const next = current + 1;
      state.inFlight.set(generation, next);
      if (next > policy.concurrencyCeiling) {
        stop = true;
      }
    } else {
      state.inFlight.set(generation, Math.max(0, current - 1));
    }
  }

  // D6 — sliding rate window over `observedAt`; expiry resets the window.
  if (observation?.observedAt !== undefined) {
    const now = Date.parse(observation.observedAt);
    if (!Number.isNaN(now)) {
      state.rate = state.rate.filter((t) => now - t < policy.rateWindowMs);
      state.rate.push(now);
      if (state.rate.length > policy.rateLimit) {
        stop = true;
      }
    }
  }

  return stop ? "Stop" : "Continue";
};

/**
 * P2-owned execution-wide Runtime Safety / control gating (DID v1.7 G4;
 * v1.14 G7 §8.16A six-dimension completion). P3's driver calls
 * `admitActivity` at every new ProviderTurn / ToolInvocation / Specialist
 * action boundary and obtains `Continue`/`Stop`. `Stop` →
 * `Interrupted(RuntimeSafetyStop)`; Work remains Open; Attention emitted.
 *
 * Counters are in-process and reset on restart (P9 `03` §4); no durable
 * upgrade is performed.
 */
export const RuntimeSafetyGateLive = (
  policy: RuntimeSafetyPolicy = DEFAULT_RUNTIME_SAFETY_POLICY,
): Layer.Layer<RuntimeSafetyGate> =>
  Layer.effect(
    RuntimeSafetyGate,
    Effect.sync(() => {
      const states = new Map<string, ExecutionSafetyState>();
      return RuntimeSafetyGate.of({
        admitActivity: (
          executionId: ExecutionId,
          activity: ExecutionActivity,
          observation?: RuntimeSafetyObservation,
        ): Effect.Effect<SafetyDecision> =>
          Effect.sync(() =>
            evaluate(
              policy,
              stateFor(states, executionId),
              activity,
              observation,
            ),
          ),
      });
    }),
  );
