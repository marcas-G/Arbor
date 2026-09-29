import type {
  CanonicalProviderEvent,
  PortableModelRequest,
  ProtocolAdapter,
  ProviderExecutionContext,
  ProviderPortEvent,
} from "@arbor/ports";
import { ProviderPort } from "@arbor/ports";
import { Effect, Layer, Stream } from "effect";

/**
 * P16 E4b — proof-of-construction protocol family (`02` E4b).
 *
 * `provider-testecho` is an in-process deterministic echo family (NOT a real
 * provider — scope guard 1): it echoes a digest of the portable request as
 * text deltas plus usage, exercising exactly the frozen ProviderPort
 * contract. Onboarding this family must require only this package + a
 * registry registration line — never Provider Runtime / Model Context /
 * Agent Runtime / CanonicalProviderEvent changes
 * (verify-provider-extension.mjs --mode protocol proves it mechanically).
 */

export interface TestechoScript {
  /** Fail the first N attempts with this kind, then succeed. */
  readonly failures?: ReadonlyArray<string>;
  /** Override the deterministic echo payload (conformance injection). */
  readonly events?: ReadonlyArray<CanonicalProviderEvent>;
}

const failureOf = (kind: string) => ({
  _tag: "ProviderFailure" as const,
  kind: kind as never,
});

export const TestechoProviderLive = (
  script: TestechoScript = {},
): Layer.Layer<ProviderPort> =>
  Layer.effect(
    ProviderPort,
    Effect.sync(() => {
      let calls = 0;
      return ProviderPort.of({
        runTurn: ({
          request,
          context,
        }: {
          readonly request: PortableModelRequest;
          readonly context: ProviderExecutionContext;
        }) => {
          const attempt = calls;
          calls += 1;
          const kind = script.failures?.[attempt];
          const started: ProviderPortEvent = {
            _tag: "Canonical",
            event: {
              _tag: "TurnStarted",
              providerTurnId: context.providerTurnId,
              attemptNo: context.attemptNo,
              modelRef: request.modelRef,
            },
          };
          const preflight: ProviderPortEvent = {
            _tag: "Observation",
            delta: { responseStarted: false, externalEffectPossible: false },
          };
          const responseStarted: ProviderPortEvent = {
            _tag: "Observation",
            delta: { responseStarted: true },
          };
          if (kind !== undefined) {
            return Stream.concat(
              Stream.fromIterable([started, preflight, responseStarted]),
              Stream.fail(failureOf(kind)),
            );
          }
          const echo = `echo:${request.modelRef}:${request.messages.length}:${request.toolDefinitions.length}`;
          const events: ReadonlyArray<CanonicalProviderEvent> =
            script.events ?? [
              { _tag: "TextDelta", text: echo },
              {
                _tag: "UsageReported",
                inputTokens: echo.length,
                outputTokens: echo.length,
              },
              { _tag: "TurnCompleted", finishReason: "Stop" },
            ];
          return Stream.fromIterable([
            started,
            preflight,
            responseStarted,
            ...events.map(
              (event): ProviderPortEvent => ({ _tag: "Canonical", event }),
            ),
          ]);
        },
      });
    }),
  );

/** P16 `01` §2/§6: the testecho family registration value. */
export const providerTestechoAdapter: ProtocolAdapter = {
  adapterId: "provider-testecho",
  profile: {
    // G-B2 (Final Closure Audit): a DISTINCT test protocol-family identity —
    // the E4b proof must demonstrate a new protocol family, not merely a new
    // adapter implementation inside an existing family.
    protocolFamily: "testecho-echo-v1",
    authMode: { _tag: "None" },
    capabilityFlags: {
      reportsCacheTokens: false,
      supportsContinuation: false,
      streamsDeltas: true,
    },
    failureTaxonomy: "phase1-v2",
  },
  layerFor: (binding) =>
    TestechoProviderLive(
      (binding.transportOverride as TestechoScript | undefined) ?? {},
    ),
};
