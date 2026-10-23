import type {
  CommandSubmissionContext,
  ExecutionId,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ExecutionRepositoryService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type CommandAuthorityFact,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
  validateCommandAuthority,
} from "./authority.js";
import { commandErr, commandOk } from "./command-result.js";
import type {
  SteerWorkPayload,
  SteerWorkResult,
} from "./commands/steer-work.js";
import { semanticRequestFingerprint } from "./fingerprint.js";
import type {
  CommandHandler,
  CommandHandlerError,
  CommandOutcome,
  GatewayEnvelope,
} from "./gateway.js";
import type { CommandRejection } from "./rejection.js";

export type CriticalSteerStage = "SteerWork" | "StopExecution";

export type CriticalSteerFailure =
  | CommandHandlerError
  | {
      readonly _tag: "CriticalSteerRejected";
      readonly stage: CriticalSteerStage;
      readonly rejection: CommandRejection;
    };

export interface CriticalSteerCommitted<StopResult> {
  readonly _tag: "CriticalSteerCommitted";
  readonly steer: CommandOutcome<SteerWorkResult>;
  readonly stop: CommandOutcome<StopResult>;
}

export interface SubmitCriticalSteerArgs<StopPayload, StopResult> {
  readonly steerEnvelope: GatewayEnvelope<SteerWorkPayload>;
  readonly steerContext: CommandSubmissionContext;
  readonly steerAuthority: VerifiedCommandAuthority;
  readonly stopEnvelope: GatewayEnvelope<StopPayload>;
  readonly stopContext: CommandSubmissionContext;
  readonly stopAuthority: VerifiedRuntimeCommandAuthority;
  readonly deps: {
    readonly steerHandler: CommandHandler<SteerWorkPayload, SteerWorkResult>;
    readonly stopHandler: CommandHandler<StopPayload, StopResult>;
  };
}

/** Transaction-time identity used to refresh P12 Stop authority if active-main
 * preparation became stale before the outer Gateway transaction. */
export interface CriticalSteerActiveMain {
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
}

/** P12-resolved preparation for the composite Critical Steer. `NoActiveMain`
 * is only a pre-transaction observation; the handler re-reads the Workspace
 * inside the Gateway transaction before choosing the accepted P6 option A. */
export type CriticalSteerPreparation =
  | {
      readonly _tag: "Ready";
      readonly executionId: ExecutionId;
      readonly authority: VerifiedRuntimeCommandAuthority;
    }
  | { readonly _tag: "NoActiveMain" }
  | { readonly _tag: "AuthorityDenied"; readonly reason: string }
  | { readonly _tag: "Unavailable" };

export interface MakeCriticalSteerCommandHandlerArgs<StopResult> {
  readonly steerHandler: CommandHandler<SteerWorkPayload, SteerWorkResult>;
  readonly stopHandler: CommandHandler<
    { readonly executionId: ExecutionId },
    StopResult
  >;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findActiveMainByWorkspace"
  >;
}

const rejected = (
  stage: CriticalSteerStage,
  rejection: CommandRejection,
): CriticalSteerFailure => ({
  _tag: "CriticalSteerRejected",
  stage,
  rejection,
});

const runCommand = <Payload, Result>(
  stage: CriticalSteerStage,
  handler: CommandHandler<Payload, Result>,
  envelope: GatewayEnvelope<Payload>,
  context: CommandSubmissionContext,
  authority: VerifiedCommandAuthority | VerifiedRuntimeCommandAuthority,
): Effect.Effect<
  CommandOutcome<Result>,
  CriticalSteerFailure,
  TransactionScope
> =>
  Effect.gen(function* () {
    if (handler.commandType !== envelope.commandType) {
      return yield* Effect.die(
        new Error(
          `critical steer wiring mismatch: handler ${handler.commandType} cannot execute ${envelope.commandType}`,
        ),
      );
    }
    const fingerprint = semanticRequestFingerprint({
      commandType: envelope.commandType,
      projectId: envelope.projectId,
      actor: envelope.actor,
      schemaVersion: handler.schemaVersion,
      payload: envelope.payload,
    });
    const mismatch = validateCommandAuthority(authority, handler.authority, {
      principal: context.principal,
      commandId: envelope.commandId,
      projectId: envelope.projectId,
      semanticRequestFingerprint: fingerprint,
      submissionOrigin: context._tag,
      payload: envelope.payload,
    });
    if (Option.isSome(mismatch)) {
      return yield* Effect.fail(
        rejected(stage, {
          _tag: "AuthorityDenied",
          reason: mismatch.value,
        }),
      );
    }
    const outcome = yield* handler.execute(envelope, context);
    if (!outcome.ok) {
      return yield* Effect.fail(rejected(stage, outcome.error));
    }
    return outcome.value;
  });

/**
 * P6 `04` §4 Critical Steer quiescence wiring: within ONE reliable commit
 * boundary, 1) `SteerWork(severity=Critical)` → `WorkSteered`, then
 * 2) `StopExecution` of the current active main — both facts or neither.
 *
 * The caller invokes this from the outer SteerWork handler while the Gateway
 * transaction is active. A `CriticalSteerRejected` failure escapes as a
 * failed effect so the adapter rolls back both handler mutations. This helper
 * composes the two handlers' `execute` directly; it never opens a nested
 * transaction or submits a second gateway command. Authority facts are
 * validated per command exactly as the gateway would; returned outcomes carry
 * pending events for the one outer receipt to journal.
 *
 * `steer.severity` must be `"Critical"`: Normal steer is a plain SteerWork
 * submission and never routes through this path (misuse is a defect, not a
 * rejection).
 */
export const submitCriticalSteer = <StopPayload, StopResult>(
  args: SubmitCriticalSteerArgs<StopPayload, StopResult>,
): Effect.Effect<
  CriticalSteerCommitted<StopResult>,
  CriticalSteerFailure,
  TransactionScope
> =>
  Effect.gen(function* () {
    if (args.steerEnvelope.payload.steer.severity !== "Critical") {
      return yield* Effect.die(
        new Error(
          "submitCriticalSteer requires steer.severity=Critical; submit Normal steer via SteerWork directly",
        ),
      );
    }
    const steer = yield* runCommand(
      "SteerWork",
      args.deps.steerHandler,
      args.steerEnvelope,
      args.steerContext,
      args.steerAuthority,
    );
    const stop = yield* runCommand(
      "StopExecution",
      args.deps.stopHandler,
      args.stopEnvelope,
      args.stopContext,
      args.stopAuthority,
    );
    return { _tag: "CriticalSteerCommitted", steer, stop };
  });

/** P6 single outer SteerWork command adapter, following P8 RetryVerification:
 * the Gateway owns one receipt/transaction; the inner StopExecution is a
 * direct handler call carrying the same external CommandId. */
export const makeCriticalSteerCommandHandler = <StopResult>(
  args: MakeCriticalSteerCommandHandlerArgs<StopResult>,
): CommandHandler<SteerWorkPayload, SteerWorkResult> => ({
  ...args.steerHandler,
  prepare: (envelope, context) => {
    if (envelope.payload.steer.severity !== "Critical") {
      return Effect.succeed({ _tag: "Unavailable" });
    }
    if (envelope.prepareCriticalSteerStop === undefined) {
      return Effect.succeed({ _tag: "Unavailable" });
    }
    return envelope.prepareCriticalSteerStop(envelope.payload, context);
  },
  execute: (envelope, context, prepared) => {
    if (envelope.payload.steer.severity !== "Critical") {
      return args.steerHandler.execute(envelope, context);
    }
    return Effect.gen(function* () {
      const activeMain = yield* args.executions.findActiveMainByWorkspace(
        envelope.payload.workspaceId,
      );
      if (Option.isNone(activeMain)) {
        // Accepted P6 option A: no Stop target exists at the transaction's
        // current-state boundary, so commit the ordinary SteerWork effects.
        return yield* args.steerHandler.execute(envelope, context);
      }
      const currentMain: CriticalSteerActiveMain = {
        executionId: activeMain.value.executionId,
        projectId: activeMain.value.projectId,
        workspaceId: activeMain.value.workspaceId,
      };
      if (
        currentMain.projectId !== envelope.projectId ||
        currentMain.workspaceId !== envelope.payload.workspaceId
      ) {
        return yield* Effect.die(
          new Error("CriticalSteerActiveMainBindingChangedBeforeCommit"),
        );
      }

      const preparation = prepared as CriticalSteerPreparation | undefined;
      let stopAuthority: VerifiedRuntimeCommandAuthority;
      if (
        preparation?._tag === "Ready" &&
        preparation.executionId === currentMain.executionId &&
        preparation.authority._tag === "StopExecutionAuthority" &&
        preparation.authority.projectId === currentMain.projectId &&
        preparation.authority.executionId === currentMain.executionId
      ) {
        stopAuthority = preparation.authority;
      } else {
        if (envelope.prepareCriticalSteerStop === undefined) {
          return yield* Effect.die(
            new Error("CriticalSteerStopAuthorityPreparationUnavailable"),
          );
        }
        const refreshed = yield* envelope.prepareCriticalSteerStop(
          envelope.payload,
          context,
          currentMain,
        );
        if (refreshed._tag === "AuthorityDenied") {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: refreshed.reason,
          });
        }
        if (
          refreshed._tag !== "Ready" ||
          refreshed.executionId !== currentMain.executionId ||
          refreshed.authority._tag !== "StopExecutionAuthority" ||
          refreshed.authority.projectId !== currentMain.projectId ||
          refreshed.authority.executionId !== currentMain.executionId
        ) {
          return yield* Effect.die(
            new Error("CriticalSteerStopAuthorityRefreshDidNotBindCurrentMain"),
          );
        }
        stopAuthority = refreshed.authority;
      }

      const steerAuthority = envelope.resolvedAuthority as
        | CommandAuthorityFact
        | undefined;
      if (steerAuthority?._tag !== "SteerWorkAuthority") {
        return yield* Effect.die(
          new Error("CriticalSteerOuterAuthorityUnavailable"),
        );
      }
      const stopPayload = { executionId: currentMain.executionId } as const;
      const stopEnvelope: GatewayEnvelope<typeof stopPayload> = {
        ...envelope,
        commandType: "StopExecution",
        payload: stopPayload,
        resolvedAuthority: stopAuthority,
      };
      const committed = yield* submitCriticalSteer({
        steerEnvelope: envelope,
        steerContext: context,
        steerAuthority: steerAuthority as VerifiedCommandAuthority,
        stopEnvelope,
        stopContext: context,
        stopAuthority,
        deps: {
          steerHandler: args.steerHandler,
          stopHandler: args.stopHandler,
        },
      }).pipe(
        Effect.catchTag("CriticalSteerRejected", (failure) =>
          Effect.die(
            new Error(
              `CriticalSteerCompositeRejected:${failure.stage}:${failure.rejection._tag}`,
            ),
          ),
        ),
      );
      return commandOk({
        result: committed.steer.result,
        events: [...committed.steer.events, ...committed.stop.events],
        ...(committed.steer.afterReceipt === undefined
          ? {}
          : { afterReceipt: committed.steer.afterReceipt }),
      });
    });
  },
});
