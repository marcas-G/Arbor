import type {
  CanonicalProviderEvent,
  ProviderFailure,
  ProviderFailureKind,
  ProviderPortEvent,
} from "@arbor/ports";
import { ProviderPort } from "@arbor/ports";
import { Effect, Layer, Stream } from "effect";

export interface FakeProviderScript {
  readonly events?: ReadonlyArray<CanonicalProviderEvent>;
  /** Per-run scripts (run N uses turns[N]); falls back to `events`. */
  readonly turns?: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
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
        runTurn: ({ request, context }) => {
          const attempt = calls;
          calls += 1;
          const kind = script.failures?.[attempt];
          const preflight: ProviderPortEvent = {
            _tag: "Observation",
            delta: {
              responseStarted: false,
              externalEffectPossible: false,
            },
          };
          if (kind !== undefined) {
            return Stream.concat(
              Stream.fromIterable([preflight]),
              Stream.fail(failure(kind)),
            );
          }
          const events = script.turns?.[attempt] ?? script.events ?? [];
          const canonicalEvents = events.some(
            (event) => event._tag === "TurnStarted",
          )
            ? events
            : [
                {
                  _tag: "TurnStarted" as const,
                  providerTurnId: context.providerTurnId,
                  attemptNo: context.attemptNo,
                  modelRef: request.modelRef,
                },
                ...events,
              ];
          return Stream.fromIterable<ProviderPortEvent>([
            preflight,
            { _tag: "Observation", delta: { responseStarted: true } },
            ...canonicalEvents.map((event) => ({
              _tag: "Canonical" as const,
              event,
            })),
          ]);
        },
      });
    }),
  );
