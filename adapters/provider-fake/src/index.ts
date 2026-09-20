import type {
  CanonicalProviderEvent,
  ProviderFailure,
  ProviderFailureKind,
} from "@arbor/ports";
import { ProviderPort } from "@arbor/ports";
import { Effect, Layer, Stream } from "effect";

export interface FakeProviderScript {
  readonly events?: ReadonlyArray<CanonicalProviderEvent>;
  /** Fail the first N attempts with these kinds, then succeed. */
  readonly failures?: ReadonlyArray<ProviderFailureKind>;
}

const failure = (kind: ProviderFailureKind): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind,
});

/** Deterministic `ProviderPort` double. No live network. */
export const FakeProviderLive = (
  script: FakeProviderScript,
): Layer.Layer<ProviderPort> =>
  Layer.effect(
    ProviderPort,
    Effect.sync(() => {
      let calls = 0;
      return ProviderPort.of({
        runTurn: () => {
          const attempt = calls;
          calls += 1;
          const kind = script.failures?.[attempt];
          if (kind !== undefined) {
            return Stream.fail(failure(kind));
          }
          return Stream.fromIterable(script.events ?? []);
        },
      });
    }),
  );
