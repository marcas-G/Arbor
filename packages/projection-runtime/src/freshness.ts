import type { FreshnessRequirement, QueryResult } from "@arbor/domain";
import type { ProjectionStale } from "@arbor/ports";
import { Effect } from "effect";
import type { ProjectionReadError } from "./errors.js";

// --- P10 `03` §2 (GQ5): the freshness contract --------------------------
//
// - monotonic watermark: every projection row/read carries the journal
//   sequence it reflects (watermark w);
// - observable lag: lag = L − w exposed on every query response;
// - explicit barrier: FreshnessRequirement {minWatermark} (frozen form)
//   or {maxLag} (contract-level extension — a watermark expressed as
//   acceptable lag; same mechanism, no new semantics);
// - no implicit RYW: writers get NO read-your-writes guarantee — a
//   reader that needs it passes the barrier explicitly;
// - sequence watermark only — no clock-based freshness, no RYW SLA.

/** lag = L − w, clamped at zero (a watermark may never exceed the
 * canonical lastSequence; a defensive clamp keeps the contract
 * non-negative). */
export const lagOf = (watermark: number, lastSequence: number): number =>
  Math.max(0, lastSequence - watermark);

/** The watermark a barrier requires, expressed on the same scale as the
 * projection watermark: max of the minWatermark floor and the
 * maxLag-derived floor (L − maxLag). */
export const requiredWatermark = (
  barrier: FreshnessRequirement,
  lastSequence: number,
): number => {
  const byMin = barrier.minWatermark ?? 0;
  const byLag =
    barrier.maxLag === undefined
      ? Number.NEGATIVE_INFINITY
      : lastSequence - barrier.maxLag;
  return Math.max(0, byMin, byLag);
};

export type FreshnessDecision =
  | { readonly _tag: "Satisfied"; readonly lag: number }
  | {
      readonly _tag: "CatchUp";
      /** First journal sequence not yet reflected (watermark + 1). */
      readonly fromSequence: number;
      /** The bounded catch-up target (≥ required watermark). */
      readonly toSequence: number;
      readonly lag: number;
    };

/** Pure barrier evaluation. Satisfied ⇒ serve the read; CatchUp ⇒ the
 * runtime blocks on a bounded catch-up read (from..to) and re-reads;
 * a runtime that cannot catch up refuses with the typed staleness
 * marker below. maxLag is the same mechanism as minWatermark — both
 * reduce to a required watermark. */
export const resolveBarrier = (
  barrier: FreshnessRequirement | undefined,
  watermark: number,
  lastSequence: number,
): FreshnessDecision => {
  const lag = lagOf(watermark, lastSequence);
  if (barrier === undefined) {
    return { _tag: "Satisfied", lag };
  }
  const required = requiredWatermark(barrier, lastSequence);
  if (watermark >= required) {
    return { _tag: "Satisfied", lag };
  }
  return {
    _tag: "CatchUp",
    fromSequence: watermark + 1,
    toSequence: Math.min(Math.max(required, 0), lastSequence),
    lag,
  };
};

/** The typed staleness marker (Problem vocabulary, ports/errors):
 * refusal — never a silent stale read. */
export const projectionStaleRefusal = (input: {
  readonly barrier: FreshnessRequirement;
  readonly watermark: number;
  readonly lastSequence: number;
}): ProjectionStale => ({
  _tag: "ProjectionStale",
  code: "projection/stale",
  category: "stale",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {
    watermark: input.watermark,
    lastSequence: input.lastSequence,
    lag: lagOf(input.watermark, input.lastSequence),
    requiredWatermark: requiredWatermark(input.barrier, input.lastSequence),
    minWatermark: input.barrier.minWatermark ?? null,
    maxLag: input.barrier.maxLag ?? null,
  },
});

/** GQ5 envelope: wrap any read value with the watermark it reflects and
 * the observable lag against canonical lastSequence. */
export const withFreshnessEnvelope = <T>(
  value: T,
  watermark: number,
  lastSequence: number,
): QueryResult<T> => ({
  value,
  watermark,
  lag: lagOf(watermark, lastSequence),
});

/** The barrier runtime: read → (barrier satisfied? serve : bounded
 * catch-up read → re-read → serve, else refuse with the typed staleness
 * marker). No implicit RYW anywhere: without a barrier the caller gets
 * whatever the snapshot currently reflects — writes are never awaited. */
export const enforceFreshnessBarrier = <T>(input: {
  readonly barrier: FreshnessRequirement | undefined;
  readonly lastSequence: number;
  readonly readSnapshot: () => Effect.Effect<
    QueryResult<T>,
    ProjectionReadError
  >;
  readonly catchUp: (
    fromSequence: number,
    toSequence: number,
  ) => Effect.Effect<number, ProjectionReadError>;
}): Effect.Effect<QueryResult<T>, ProjectionReadError | ProjectionStale> =>
  Effect.gen(function* () {
    const first = yield* input.readSnapshot();
    const decision = resolveBarrier(
      input.barrier,
      first.watermark,
      input.lastSequence,
    );
    if (decision._tag === "Satisfied") {
      return first;
    }
    yield* input.catchUp(decision.fromSequence, decision.toSequence);
    const second = yield* input.readSnapshot();
    const redecided = resolveBarrier(
      input.barrier,
      second.watermark,
      input.lastSequence,
    );
    if (redecided._tag === "Satisfied") {
      return second;
    }
    return yield* Effect.fail(
      projectionStaleRefusal({
        barrier: input.barrier as FreshnessRequirement,
        watermark: second.watermark,
        lastSequence: input.lastSequence,
      }),
    );
  });
