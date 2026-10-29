import { ExecutionId, parse } from "@arbor/domain";
import { ProviderDeploymentBreaker, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  layer,
  P21_MIGRATIONS,
  ProviderDeploymentBreakerLive,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const firstExecution = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const secondExecution = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

describe("P17 provider deployment breaker", () => {
  it("opens after systemic failures, admits one half-open probe, then closes on success", async () => {
    const base = layer({ filename: ":memory:" });
    const txLayer = Layer.provide(TransactionPortLive, base);
    const app = Layer.mergeAll(
      Layer.provide(ProviderDeploymentBreakerLive, base),
      txLayer,
      base,
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P21_MIGRATIONS);
      const breaker = yield* ProviderDeploymentBreaker;
      const tx = yield* TransactionPort;
      for (const second of [1, 2, 3]) {
        yield* tx.transact(
          breaker.recordFailure({
            bindingFingerprint: "binding-a",
            configurationRevision: "config-1",
            failureClass: "TransientProviderUnavailable",
            now: `2026-10-01T00:00:0${String(second)}.000Z`,
          }),
        );
      }
      const denied = yield* tx.transact(
        breaker.admit({
          bindingFingerprint: "binding-a",
          configurationRevision: "config-1",
          executionId: firstExecution,
          now: "2026-10-01T00:00:30.000Z",
        }),
      );
      const probe = yield* tx.transact(
        breaker.admit({
          bindingFingerprint: "binding-a",
          configurationRevision: "config-1",
          executionId: firstExecution,
          now: "2026-10-01T00:01:03.000Z",
        }),
      );
      const secondDenied = yield* tx.transact(
        breaker.admit({
          bindingFingerprint: "binding-a",
          configurationRevision: "config-1",
          executionId: secondExecution,
          now: "2026-10-01T00:01:03.000Z",
        }),
      );
      yield* tx.transact(
        breaker.recordSuccess({
          bindingFingerprint: "binding-a",
          configurationRevision: "config-1",
          now: "2026-10-01T00:01:04.000Z",
        }),
      );
      const admitted = yield* tx.transact(
        breaker.admit({
          bindingFingerprint: "binding-a",
          configurationRevision: "config-1",
          executionId: secondExecution,
          now: "2026-10-01T00:01:05.000Z",
        }),
      );
      return { denied, probe, secondDenied, admitted };
    });

    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.denied).toMatchObject({
      _tag: "Denied",
      failureClass: "TransientProviderUnavailable",
      retryAt: "2026-10-01T00:01:03.000Z",
    });
    expect(result.probe).toEqual({ _tag: "Admitted", probe: true });
    expect(result.secondDenied._tag).toBe("Denied");
    expect(result.admitted).toEqual({ _tag: "Admitted", probe: false });
  });
});
