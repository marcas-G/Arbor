import type { ExecutionSettlement } from "@arbor/domain";
import { ExecutableApprovalStore, ExecutionDriverPort } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/** Deterministic driver double: returns a fixed settlement proposal. */
export const FakeDriverLive = (
  settlement: ExecutionSettlement,
): Layer.Layer<ExecutionDriverPort> =>
  Layer.succeed(ExecutionDriverPort, {
    drive: () => Effect.succeed(settlement),
  });

/** Pre-P38 fixtures have no approval ledger rows. P2 runner fixtures install
 * this explicit no-pending port instead of relying on a missing service. */
export const NoPendingExecutableApprovalStoreLive: Layer.Layer<ExecutableApprovalStore> =
  Layer.succeed(ExecutableApprovalStore, {
    findPendingForExecution: () => Effect.succeed(Option.none()),
  } as never);
