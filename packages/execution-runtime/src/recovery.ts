import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type {
  DomainEvent,
  ExecutionId,
  ExecutionSettlement,
  Principal,
} from "@arbor/domain";
import {
  Clock,
  DomainEventJournal,
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

/** P9 `01` §2 (B-2): a durable completion fact — an `ExecutionSettled`
 * event whose payload settlement is `Completed(...)` persisted in the
 * settlement trace — settles to the corresponding Completed form, never a
 * guess, never a downgrade. */
const completionFact = (
  events: ReadonlyArray<DomainEvent<unknown>>,
  executionId: ExecutionId,
): ExecutionSettlement | null => {
  for (const event of events) {
    if (
      event.eventType !== "ExecutionSettled" ||
      event.aggregateRef !== executionId
    ) {
      continue;
    }
    const settlement = (
      event.payload as { settlement?: { readonly _tag?: unknown } }
    ).settlement;
    if (
      typeof settlement === "object" &&
      settlement !== null &&
      settlement._tag === "Completed"
    ) {
      return settlement as ExecutionSettlement;
    }
  }
  return null;
};

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
    const journal = yield* DomainEventJournal;

    const now = yield* clock.now();
    const invalidated = yield* tx.transact(leases.invalidateExpired(now));
    const unsettled = yield* tx.transact(repository.findUnsettledExecutions());

    const settled: string[] = [];
    const escalated: string[] = [];
    for (const execution of unsettled) {
      const events = yield* tx.transact(
        journal.readAfter(execution.projectId, 0, 1_000_000),
      );
      const completion = completionFact(events, execution.executionId);
      if (completion !== null) {
        // B-2 deterministic settle: RecoveryController authority path with
        // the deterministic commandId f("recovery", executionId,
        // "completion"); idempotent replay returns the existing receipt.
        const payload = {
          executionId: execution.executionId,
          settlement: completion,
        };
        const commandId =
          `cmd_recovery_completion_${execution.executionId}` as never;
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
        continue;
      }
      if (execution.stopRequestedAt === null) {
        continue;
      }
      const pending = yield* tx.transact(
        reconciliation.pending(execution.executionId),
      );
      if (pending.length > 0) {
        escalated.push(execution.executionId);
        // P9 `01` §1.2 / `04` §1: durable Attention fact — dedup key
        // executionId + invocationRefs fingerprint; repeated passes are
        // no-ops (INSERT OR IGNORE semantics via journal idempotency key).
        const fingerprint = pending
          .map((ref) =>
            String((ref as { invocationId?: unknown }).invocationId ?? ref),
          )
          .sort()
          .join(",");
        // P9 `01` §1.2 / `04` §1: dedup key executionId + invocationRefs
        // fingerprint — repeated passes mint no new facts.
        const alreadyFact = events.some(
          (event) =>
            event.eventType === "ReconciliationEscalated" &&
            event.aggregateRef === execution.executionId &&
            (event.payload as { invocationRefsFingerprint?: string })
              .invocationRefsFingerprint === fingerprint,
        );
        if (!alreadyFact) {
          yield* tx.transact(
            journal.append([
              {
                projectId: execution.projectId,
                eventType: "ReconciliationEscalated",
                eventVersion: 1,
                occurredAt: now,
                aggregateRef: execution.executionId,
                actor: principal as never,
                payload: {
                  executionId: execution.executionId,
                  invocationRefsFingerprint: fingerprint,
                  refs: pending,
                },
              } as never,
            ]),
          );
        }
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
