import type { CommandSubmissionContext } from "@arbor/domain";
import type { ExecutionRepositoryError, TransactionScope } from "@arbor/ports";
import { Context, Effect, type Effect as EffectType, Layer } from "effect";
import type { StopAdmission } from "./authority.js";

export type FenceStopOutcome = "Pass" | "FencingRejected" | "ExecutionStopping";

export interface FenceStopCheckService {
  readonly check: (
    context: CommandSubmissionContext,
    stopAdmission: StopAdmission,
  ) => EffectType.Effect<
    FenceStopOutcome,
    ExecutionRepositoryError,
    TransactionScope
  >;
}

export class FenceStopCheck extends Context.Service<
  FenceStopCheck,
  FenceStopCheckService
>()("arbor/FenceStopCheck") {}

export const FenceStopCheckInertLive: Layer.Layer<FenceStopCheck> =
  Layer.succeed(FenceStopCheck, {
    check: () => Effect.succeed("Pass"),
  });
