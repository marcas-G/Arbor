import type { CommandSubmissionContext } from "@arbor/domain";
import type { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
  validateCommandAuthority,
} from "./authority.js";
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
 * The caller MUST wrap this in a single TransactionScope
 * (`TransactionPort.transact`): a `CriticalSteerRejected` failure exits the
 * surrounding transaction as a failure so the adapter rolls back, which is
 * what makes the two facts atomic. This function must never run inside
 * `gateway.execute` (the TransactionPort rejects nested transactions); it
 * composes the two handlers' `execute` directly instead of submitting a
 * second gateway command. Authority facts are validated per command exactly
 * as the gateway would; the returned outcomes carry the pending events for
 * the outer submission boundary to journal.
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
