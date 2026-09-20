import type { ExecutionSettlement } from "@arbor/domain";
import { ExecutionDriverPort } from "@arbor/ports";
import { Effect, Layer } from "effect";

/** Deterministic driver double: returns a fixed settlement proposal. */
export const FakeDriverLive = (
  settlement: ExecutionSettlement,
): Layer.Layer<ExecutionDriverPort> =>
  Layer.succeed(ExecutionDriverPort, {
    drive: () => Effect.succeed(settlement),
  });
