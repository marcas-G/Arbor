import {
  CommandGateway,
  type CommandRejection,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type {
  CommandSubmissionContext,
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  Principal,
  WakeReason,
} from "@arbor/domain";
import {
  AgentExecutionStateStore,
  ExecutionDriverPort,
  ExecutionRepository,
  LeaseService,
  RuntimeSafetyGate,
  TransactionPort,
  WorkerDispatchPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/**
 * Orchestration: durable admission already exists; dispatch, acquire a lease,
 * drive, and persist the driver's settlement proposal through the command
 * pipeline (ExecutionOrigin, fenced).
 */
export const runExecution = (
  executionId: ExecutionId,
  wakeReason: WakeReason,
  principal: Principal,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const states = yield* AgentExecutionStateStore;
    const leases = yield* LeaseService;
    const dispatch = yield* WorkerDispatchPort;
    const driver = yield* ExecutionDriverPort;
    const safety = yield* RuntimeSafetyGate;
    const gateway = yield* CommandGateway;

    const execution = yield* tx.transact(repository.findById(executionId));
    if (Option.isNone(execution)) {
      return yield* Effect.fail({ _tag: "ExecutionNotFound" as const });
    }
    yield* dispatch.dispatch({
      executionId,
      workspaceId: execution.value.workspaceId,
      workerKind: "Agent",
    });
    const lease = yield* tx.transact(
      leases.acquire(executionId, "worker:local"),
    );
    const state = yield* tx.transact(states.find(executionId));
    const settlement = yield* driver.drive({
      execution: execution.value,
      agentExecutionState: Option.getOrElse(state, () => ({
        executionId,
        focus: { _tag: "Coordination" as const },
        wakeReason,
        currentMode: null,
        activeSkillRefs: [],
        turnNo: 0,
        recentDirectiveRefs: [],
        recentActionFingerprints: [],
        updatedAt: "t",
      })),
      wakeReason,
      context: {
        _tag: "ExecutionOrigin",
        principal,
        executionId,
        fencingGeneration: lease.generation,
      },
      safetyGate: safety,
    });

    const payload = {
      executionId,
      settlement,
      expectedFencingGeneration: lease.generation as LeaseGeneration,
    };
    const commandId = `cmd_settle_${executionId}_${lease.generation}` as never;
    const authority: VerifiedRuntimeCommandAuthority = {
      _tag: "SettleExecutionAuthority",
      submissionOrigin: "ExecutionOrigin",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SettleExecution",
        projectId: execution.value.projectId,
        actor: principal as never,
        schemaVersion: "1",
        payload,
      }),
      projectId: execution.value.projectId,
      commandKind: "SettleExecution",
      executionId,
      fencingGeneration: lease.generation,
    };
    const context: CommandSubmissionContext = {
      _tag: "ExecutionOrigin",
      principal,
      executionId,
      fencingGeneration: lease.generation,
    };
    const receipt = yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: execution.value.projectId,
        actor: principal as never,
        issuedAt: "t",
        payload,
      },
      context,
      authority,
    );
    if (receipt.resolution._tag === "TerminalRejected") {
      return yield* Effect.fail(
        receipt.resolution.error as unknown as CommandRejection,
      );
    }
    return settlement;
  });
