import { WorkerDispatchPort } from "@arbor/ports";
import { Effect, Layer } from "effect";

/** Local in-process worker dispatch: a durable wake intent, never a lease. */
export const WorkerDispatchPortLive: Layer.Layer<WorkerDispatchPort> =
  Layer.succeed(WorkerDispatchPort, {
    dispatch: (request) =>
      Effect.succeed({
        dispatchId: `dsp_${request.executionId}_${request.workerKind}`,
        acceptedAt: "t",
      }),
  });
