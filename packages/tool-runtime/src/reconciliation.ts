import type { ExecutionId } from "@arbor/domain";
import {
  type InvocationRef,
  ReconciliationSource,
  type ReconciliationSourceError,
  ToolInvocationStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/** P4 `06` §4; DID v1.8 §3.4. Implements the P2 `ReconciliationSource` over
 * tool invocations. `OutcomeUnknown` must not be swallowed by retry. */

const RECONCILABLE: ReadonlyArray<string> = [
  "Reconcilable",
  "NonIdempotent",
  "Interrupted",
];

export const ReconciliationSourceLive: Layer.Layer<
  ReconciliationSource,
  never,
  ToolInvocationStore
> = Layer.effect(
  ReconciliationSource,
  Effect.gen(function* () {
    const store = yield* ToolInvocationStore;
    const pending = (
      executionId: ExecutionId,
    ): Effect.Effect<
      ReadonlyArray<InvocationRef>,
      ReconciliationSourceError,
      import("@arbor/ports").TransactionScope
    > =>
      Effect.gen(function* () {
        const unsettled = yield* store.findUnsettled(executionId);
        return unsettled
          .filter((invocation) =>
            RECONCILABLE.includes(invocation.sideEffectSemantics),
          )
          .map((invocation) => invocation.invocationId);
      }).pipe(
        Effect.mapError(
          (cause): ReconciliationSourceError => ({
            _tag: "ReconciliationSourceError",
            cause,
          }),
        ),
      );
    return ReconciliationSource.of({ pending });
  }),
);
