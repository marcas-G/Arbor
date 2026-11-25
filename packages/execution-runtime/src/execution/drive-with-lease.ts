import type { AgentExecutionState, Execution, ExecutionId, Principal, WakeReason } from "@arbor/domain";
import type { ExecutionDriverOwnershipLost, ExecutionDriverPortService, LeaseFencingRejected, LeaseRecord, RuntimeSafetyGateService } from "@arbor/ports";
import { Effect } from "effect";
import { leaseRenewalLoop, stopRequestLoop, STOP_REQUEST_POLL_INTERVAL_MS, type ExecutionLeaseQualificationProbe } from "./lease.js";

/** Drive lifetime owns both renewal and durable stop watchers. */
export const driveWithLease = (
  execution: Execution,
  executionId: ExecutionId,
  agentExecutionState: AgentExecutionState,
  wakeReason: WakeReason,
  principal: Principal,
  lease: LeaseRecord,
  driver: ExecutionDriverPortService,
  safety: RuntimeSafetyGateService,
  renewIntervalMs: number,
  leaseQualificationProbe?: ExecutionLeaseQualificationProbe,
) =>
  Effect.gen(function* () {
    // P9 `03` §1: race the drive against the renewal loop — the first to
    // complete wins; a lost renewal (LeaseLost) interrupts the drive so no
    // durable mutation is attempted, and no ordinary retry occurs. A durable
    // StopExecution is a second control boundary: its watcher interrupts the
    // same driver fiber and lets recovery perform the existing settlement or
    // reconciliation pass.
    const stopController = new AbortController();
    const driveOrStop = Effect.raceFirst(
      driver.drive({
        execution: execution,
        agentExecutionState,
        wakeReason,
        context: {
          _tag: "ExecutionOrigin",
          principal,
          executionId,
          fencingGeneration: lease.generation,
          workerId: lease.workerId,
          workerIncarnationId: lease.workerIncarnationId,
        },
        safetyGate: safety,
        cancellationSignal: stopController.signal,
      }),
      stopRequestLoop(executionId, STOP_REQUEST_POLL_INTERVAL_MS, () =>
        stopController.abort(),
      ),
    );
    return yield* Effect.raceFirst(
      driveOrStop,
      leaseRenewalLoop(
        executionId,
        lease.workerId,
        lease.workerIncarnationId,
        lease.generation,
        renewIntervalMs,
        leaseQualificationProbe,
      ),
    ).pipe(
      Effect.catchTag(
        "ExecutionDriverOwnershipLost",
        (lost: ExecutionDriverOwnershipLost) =>
          Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId: lost.executionId,
            generation: lost.generation,
          }),
      ),
    );
  });
