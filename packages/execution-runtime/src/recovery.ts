import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type { Principal } from "@arbor/domain";
import {
  Clock,
  ExecutionRepository,
  LeaseService,
  ReconciliationSource,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

export interface RecoveryResult {
  readonly invalidated: number;
  readonly settled: ReadonlyArray<string>;
  readonly escalated: ReadonlyArray<string>;
}

/**
 * Deterministic Execution-boundary recovery (P2 `06` §2–§6).
 * Invalidates expired leases; settles only deterministic outcomes via
 * `SettleExecution` with `RecoveryController` authority; never blindly
 * replays an uncertain case.
 */
export const runRecovery = (principal: Principal) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const leases = yield* LeaseService;
    const reconciliation = yield* ReconciliationSource;
    const gateway = yield* CommandGateway;
    const clock = yield* Clock;

    const now = yield* clock.now();
    const invalidated = yield* tx.transact(leases.invalidateExpired(now));
    const unsettled = yield* tx.transact(repository.findUnsettledExecutions());

    const settled: string[] = [];
    const escalated: string[] = [];
    for (const execution of unsettled) {
      if (execution.stopRequestedAt === null) {
        continue;
      }
      const pending = yield* tx.transact(
        reconciliation.pending(execution.executionId),
      );
      if (pending.length > 0) {
        escalated.push(execution.executionId);
        continue;
      }
      const settlement = {
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      } as const;
      const payload = { executionId: execution.executionId, settlement };
      const commandId = `cmd_recovery_settle_${execution.executionId}` as never;
      const authority: VerifiedRuntimeCommandAuthority = {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "RecoveryController",
        principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: execution.projectId,
          actor: principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: execution.projectId,
        commandKind: "SettleExecution",
        executionId: execution.executionId,
      };
      yield* gateway.execute(
        {
          commandType: "SettleExecution",
          commandId,
          projectId: execution.projectId,
          actor: principal as never,
          issuedAt: now,
          payload,
        },
        { _tag: "RecoveryController", principal, causationRef: "recovery" },
        authority,
      );
      settled.push(execution.executionId);
    }
    return { invalidated, settled, escalated };
  });

export const ReconciliationSourceStubLive: Layer.Layer<ReconciliationSource> =
  Layer.succeed(ReconciliationSource, {
    pending: () => Effect.succeed([]),
  });
