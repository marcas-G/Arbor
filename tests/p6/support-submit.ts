import { Effect } from "effect";
import type { RecordDecisionResult } from "../../packages/application/src/commands/record-decision.js";
import {
  type SendMessagePayload,
  type SendMessageResult,
  sendMessagePlan,
} from "../../packages/application/src/commands/send-message.js";
import {
  makeSteerWorkHandler,
  type SteerWorkPayload,
  type SteerWorkResult,
} from "../../packages/application/src/commands/steer-work.js";
import type { SubmitCriticalSteerArgs } from "../../packages/application/src/critical-steer.js";
import {
  type CommandGatewayService,
  type CommandHandler,
  type CommandRejection,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import type {
  ChildWorkspaceProposal,
  CommandId,
  CommandReceipt,
  ExecutionId,
  FormationProposalId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  makeStopExecutionHandler,
  type StopExecutionPayload,
  type StopExecutionResult,
} from "../../packages/execution-runtime/src/index.js";
import {
  ExecutionRepository,
  InboxProjectionStore,
  WorkRepository,
} from "../../packages/ports/src/index.js";
import { ACTOR, PRINCIPAL, PROJECT } from "./support.js";
export const submitDecision = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly proposalId: FormationProposalId;
    readonly expectedProposalRevision: number;
    readonly outcome:
      | { readonly _tag: "Approve" }
      | { readonly _tag: "Reject" }
      | {
          readonly _tag: "Modify";
          readonly proposal: ChildWorkspaceProposal;
        };
  },
): Effect.Effect<
  CommandReceipt<RecordDecisionResult, CommandRejection>,
  unknown
> => {
  const payload = {
    proposalId: args.proposalId,
    expectedProposalRevision: args.expectedProposalRevision,
    outcome: args.outcome,
  };
  return gw.execute(
    {
      commandType: "RecordDecision",
      commandId: args.commandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: PRINCIPAL },
    {
      _tag: "RecordDecisionAuthority",
      principal: PRINCIPAL,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "RecordDecision",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "1",
        payload,
      }),
      projectId: PROJECT,
      proposalId: args.proposalId,
    },
  );
};

export const submitSend = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: SendMessagePayload;
  },
): Effect.Effect<
  CommandReceipt<SendMessageResult, CommandRejection>,
  unknown
> => {
  const plan = sendMessagePlan({
    messageId: args.payload.messageId,
    commandId: args.commandId,
    projectId: PROJECT,
    senderWorkspaceId: args.payload.senderWorkspaceId,
    principal: PRINCIPAL,
    actor: ACTOR,
    message: args.payload.message,
  });
  const envelope: GatewayEnvelope<SendMessagePayload> = {
    commandType: "SendMessage",
    commandId: args.commandId,
    projectId: PROJECT,
    actor: ACTOR,
    issuedAt: "t",
    payload: args.payload,
  };
  return gw.execute(
    envelope,
    { _tag: "External", principal: PRINCIPAL },
    plan.authority,
  );
};

export const submitSteer = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: SteerWorkPayload;
    readonly authorityTargetWorkspaceId?: WorkspaceId;
  },
) => {
  const authority: VerifiedCommandAuthority = {
    _tag: "SteerWorkAuthority",
    principal: PRINCIPAL,
    commandId: args.commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "SteerWork",
      projectId: PROJECT,
      actor: ACTOR,
      schemaVersion: "2",
      payload: args.payload,
    }),
    projectId: PROJECT,
    targetWorkspaceId:
      args.authorityTargetWorkspaceId ?? args.payload.workspaceId,
    workId: args.payload.workId,
  };
  return gw.execute(
    {
      commandType: "SteerWork",
      commandId: args.commandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: args.payload,
    },
    { _tag: "External", principal: PRINCIPAL },
    authority,
  );
};

export const steerHandlers = Effect.gen(function* () {
  return {
    steerHandler: makeSteerWorkHandler({
      works: yield* WorkRepository,
      inbox: yield* InboxProjectionStore,
    }),
    stopHandler: makeStopExecutionHandler({
      executions: yield* ExecutionRepository,
    }),
  };
});

export const criticalSteerSubmission = (
  handlers: {
    readonly steerHandler: CommandHandler<SteerWorkPayload, SteerWorkResult>;
    readonly stopHandler: CommandHandler<
      StopExecutionPayload,
      StopExecutionResult
    >;
  },
  args: {
    readonly steerCommandId: CommandId;
    readonly stopCommandId: CommandId;
    readonly payload: SteerWorkPayload;
    readonly executionId: ExecutionId;
  },
): SubmitCriticalSteerArgs<StopExecutionPayload, StopExecutionResult> => {
  const stopPayload: StopExecutionPayload = { executionId: args.executionId };
  return {
    steerEnvelope: {
      commandType: "SteerWork",
      commandId: args.steerCommandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: args.payload,
    },
    steerContext: { _tag: "External", principal: PRINCIPAL },
    steerAuthority: {
      _tag: "SteerWorkAuthority",
      principal: PRINCIPAL,
      commandId: args.steerCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SteerWork",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "2",
        payload: args.payload,
      }),
      projectId: PROJECT,
      targetWorkspaceId: args.payload.workspaceId,
      workId: args.payload.workId,
    },
    stopEnvelope: {
      commandType: "StopExecution",
      commandId: args.stopCommandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: stopPayload,
    },
    stopContext: {
      _tag: "System",
      principal: PRINCIPAL,
      causationRef: `acceptance-critical:${args.steerCommandId}`,
    },
    stopAuthority: {
      _tag: "StopExecutionAuthority",
      submissionOrigin: "System",
      principal: PRINCIPAL,
      commandId: args.stopCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "StopExecution",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "1",
        payload: stopPayload,
      }),
      projectId: PROJECT,
      commandKind: "StopExecution",
      executionId: args.executionId,
    },
    deps: handlers,
  };
};
