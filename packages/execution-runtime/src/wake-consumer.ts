import {
  CommandGateway,
  newUuid7,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type {
  CommandSubmissionContext,
  Principal,
  WakeReason,
  WorkspaceId,
} from "@arbor/domain";
import { CommandId, ExecutionId, parse } from "@arbor/domain";
import {
  Clock,
  ExecutionScheduler,
  IdGenerator,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { AdmitExecutionPayload } from "./commands/admit-execution.js";
import { runExecution } from "./execution-runtime.js";

const systemContext = (principal: Principal): CommandSubmissionContext => ({
  _tag: "System",
  principal,
  causationRef: "execution-scheduler",
});

/**
 * P2 production wake consumer. The scheduler remains the only decision
 * authority; this function applies its canonical Work selection, admits the
 * selected focus through CommandGateway, then hands the durable Execution to
 * the P2 worker lifecycle (`runExecution`).
 *
 * The daemon calls this one boundary for a Workspace wake. It does not carry a
 * second decision table, lease owner, or Agent loop.
 */
export const consumeWorkspaceWake = (
  workspaceId: WorkspaceId,
  wakeReason: WakeReason,
  principal: Principal,
) =>
  Effect.gen(function* () {
    const scheduler = yield* ExecutionScheduler;
    const gateway = yield* CommandGateway;
    const workspaces = yield* WorkspaceRepository;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    const ids = yield* IdGenerator;

    while (true) {
      const decision = yield* scheduler.reevaluate(workspaceId, wakeReason);

      if (decision._tag === "Noop" || decision._tag === "Idle") {
        return;
      }

      if (decision._tag === "SelectCurrentWork") {
        const workspace = yield* tx.transact(workspaces.findById(workspaceId));
        if (Option.isNone(workspace)) {
          return;
        }
        const current = workspace.value;
        const now = yield* clock.now();
        const payload = {
          workspaceId,
          workId: decision.workId,
          expectedWorkspaceRevision: current.revision,
        };
        const commandSeed = yield* ids.generate<string>("CommandId");
        const commandId = parse(CommandId)(
          `cmd_${newUuid7("execution-scheduler-select", commandSeed)}`,
        );
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
        const receipt = yield* gateway.execute(
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
        // A stale candidate/revision is re-evaluated on the next wake. Do not
        // turn a terminal command receipt into an Agent dispatch.
        if (receipt.resolution._tag === "TerminalRejected") {
          return;
        }
        continue;
      }

      const workspace = yield* tx.transact(workspaces.findById(workspaceId));
      if (Option.isNone(workspace)) {
        return;
      }
      const current = workspace.value;
      const now = yield* clock.now();
      const executionSeed = yield* ids.generate<string>("ExecutionId");
      const executionId = parse(ExecutionId)(
        `exe_${newUuid7("execution-scheduler-execution", executionSeed)}`,
      );
      const payload: AdmitExecutionPayload = {
        _tag: "WorkspaceMain",
        executionId,
        workspaceId,
        focus: decision.focus,
      };
      const commandSeed = yield* ids.generate<string>("CommandId");
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("execution-scheduler-admit", commandSeed)}`,
      );
      const authority: VerifiedRuntimeCommandAuthority = {
        _tag: "AdmitExecutionAuthority",
        submissionOrigin: "System",
        principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AdmitExecution",
          projectId: current.projectId,
          actor: principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: current.projectId,
        commandKind: "AdmitExecution",
        workspaceId,
        bindingKind: "WorkspaceMain",
      };
      const receipt = yield* gateway.execute(
        {
          commandType: "AdmitExecution",
          commandId,
          projectId: current.projectId,
          actor: principal as never,
          issuedAt: now,
          payload,
        },
        systemContext(principal),
        authority,
      );
      if (receipt.resolution._tag === "TerminalRejected") {
        return;
      }

      yield* runExecution(executionId, wakeReason, principal);
      return;
    }
  });
