import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type {
  CommandId,
  ExecutionFocus,
  ExecutionId,
  Principal,
  WakeReason,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type AdmitExecutionPayload,
  preDispatchCheck,
} from "@arbor/execution-runtime";
import {
  Clock,
  type ExecutionRepository,
  ExecutionScheduler,
  IdGenerator,
  type SchedulerDecision,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/**
 * P5 `01` §3.1. The slice loop consumes the frozen scheduler decision table and
 * never re-decides it: the **selection decision** belongs to the evaluator, the
 * **canonical mutation** is applied through `CommandGateway` using the
 * evaluator's exact `workId`.
 */
export interface SelectionStep {
  readonly selections: ReadonlyArray<WorkId>;
  readonly decision: SchedulerDecision;
}

const systemContext = (principal: Principal) => ({
  _tag: "System" as const,
  principal,
  causationRef: "scheduler",
});

export const evaluateAndSelect = (
  workspaceId: WorkspaceId,
  principal: Principal,
  wakeReason: WakeReason,
): Effect.Effect<
  SelectionStep,
  unknown,
  | ExecutionScheduler
  | CommandGateway
  | WorkspaceRepository
  | TransactionPort
  | Clock
> =>
  Effect.gen(function* () {
    const scheduler = yield* ExecutionScheduler;
    const gateway = yield* CommandGateway;
    const workspaces = yield* WorkspaceRepository;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;

    const applySelection = (workId: WorkId) =>
      Effect.gen(function* () {
        const workspace = yield* tx.transact(workspaces.findById(workspaceId));
        if (Option.isNone(workspace)) {
          return;
        }
        const current = workspace.value;
        const now = yield* clock.now();
        const payload = {
          workspaceId,
          workId,
          expectedWorkspaceRevision: current.revision,
        };
        const commandId =
          `cmd_${workspaceId}_select_${workId}_${current.revision}` as CommandId;
        const authority: VerifiedCommandAuthority = {
          _tag: "SelectCurrentWorkAuthority",
          principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "SelectCurrentWork",
            projectId: current.projectId,
            actor: principal as never,
            schemaVersion: "1",
            payload,
          }),
          projectId: current.projectId,
          targetWorkspaceId: workspaceId,
        };
        yield* gateway.execute(
          {
            commandType: "SelectCurrentWork",
            commandId,
            projectId: current.projectId,
            actor: principal as never,
            issuedAt: now,
            payload,
          },
          systemContext(principal),
          authority,
        );
      });

    let decision = yield* scheduler.reevaluate(workspaceId, wakeReason);
    const selections: WorkId[] = [];
    while (decision._tag === "SelectCurrentWork") {
      yield* applySelection(decision.workId);
      selections.push(decision.workId);
      decision = yield* scheduler.reevaluate(workspaceId, wakeReason);
    }
    return { selections, decision };
  });

export type DispatchRound<A> =
  | { readonly dispatched: false }
  | { readonly dispatched: true; readonly outcome: A };

/** T4 hook (P9 `03` §2, GQ3): before the dispatch loop hands an execution
 * to a drive, run the targeted pre-dispatch check — the lease-fence
 * predicate ONLY. A live, unexpired lease skips the round; never the
 * nine-step recovery. */
export const dispatchRound = <A, E, R>(
  executionId: ExecutionId,
  drive: Effect.Effect<A, E, R>,
): Effect.Effect<
  DispatchRound<A>,
  unknown,
  R | ExecutionRepository | TransactionPort | Clock
> =>
  Effect.gen(function* () {
    const dispatchable = yield* preDispatchCheck(executionId);
    if (!dispatchable) {
      return { dispatched: false };
    }
    return { dispatched: true, outcome: yield* drive };
  });

export const admitExecution = (
  workspaceId: WorkspaceId,
  executionId: ExecutionId,
  focus: ExecutionFocus,
  principal: Principal,
): Effect.Effect<
  unknown,
  unknown,
  CommandGateway | WorkspaceRepository | TransactionPort | Clock | IdGenerator
> =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const workspaces = yield* WorkspaceRepository;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    const ids = yield* IdGenerator;

    const workspace = yield* tx.transact(workspaces.findById(workspaceId));
    if (Option.isNone(workspace)) {
      return;
    }
    const projectId = workspace.value.projectId;
    const now = yield* clock.now();
    const payload: AdmitExecutionPayload = {
      _tag: "WorkspaceMain",
      executionId,
      workspaceId,
      focus,
    };
    // Each admission attempt is a distinct logical command; a deterministic id
    // would replay an earlier terminal rejection (e.g. ActiveExecutionConflict).
    const commandId =
      `cmd_${yield* ids.generate<string>("CommandId")}` as CommandId;
    const authority: VerifiedRuntimeCommandAuthority = {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AdmitExecution",
        projectId,
        actor: principal as never,
        schemaVersion: "1",
        payload,
      }),
      projectId,
      commandKind: "AdmitExecution",
      workspaceId,
      bindingKind: "WorkspaceMain",
    };
    return yield* gateway.execute(
      {
        commandType: "AdmitExecution",
        commandId,
        projectId,
        actor: principal as never,
        issuedAt: now,
        payload,
      },
      systemContext(principal),
      authority,
    );
  });
