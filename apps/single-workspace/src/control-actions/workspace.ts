import type { AgentAction, AgentActionHandler } from "@arbor/agent-runtime";
import {
  type AuthorizeWorkspaceSandboxPayload,
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  deriveFormationIds,
  isChildWorkspaceProposal,
  newFormationProposalId,
  resolveCurrentWorkspaceSandboxAuthorization,
  semanticRequestFingerprint,
  type WorkspaceSandboxAuthorizationResult,
} from "@arbor/application";
import {
  admitFormationProposal,
  type ChildWorkspaceProposal,
  decodeWorkspaceSandboxAuthorization,
  encodeNetworkPolicyV1,
} from "@arbor/domain";
import type {
  AgentLoopStepStoreService,
  ClockService,
  CommandStoreService,
  FormationFulfillmentStoreService,
  FormationProposalStoreService,
  InboxProjectionStoreService,
  ProviderTurnStoreService,
  SessionRepositoryService,
  TransactionPortService,
  WorkspacePlacementPortService,
  WorkspaceRepositoryService,
  WorkspaceSandboxAuthorizationStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  commitDurableControlActionEffect,
} from "../durable-control-action-effect.js";
import {
  actionError,
  actionOperationalFailure,
  generationScopedCommandId,
  findPriorCommandReceipt,
} from "./command-receipts.js";

export interface WorkspacePlacementDependencies {
  readonly placement: WorkspacePlacementPortService;
}

export interface AllocateWorkspaceSandboxDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry: CommandHandlerRegistryService;
  readonly commandReceipts: Pick<CommandStoreService, "findResolution">;
  readonly workspaces: WorkspaceRepositoryService;
  readonly authorizations: WorkspaceSandboxAuthorizationStoreService;
  readonly placement: WorkspacePlacementPortService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
}

export interface ProposeChildDependencies {
  readonly proposals: FormationProposalStoreService;
  readonly fulfillments?: Pick<FormationFulfillmentStoreService, "put">;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert"> &
    Partial<Pick<InboxProjectionStoreService, "findByKey">>;
  readonly clock: ClockService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly tx: TransactionPortService;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly providerTurns?: Pick<
    ProviderTurnStoreService,
    "findManifestByTurn" | "findSettledResult"
  >;
  readonly sessions?: Pick<SessionRepositoryService, "appendItemIdempotent">;
}

/** Allocates capability only. The existing Gateway owns the ledger, current
 * Parent ceiling, human-revocation priority and transaction fencing. */
export const allocateWorkspaceSandboxHandler = (
  dependencies: AllocateWorkspaceSandboxDependencies,
): AgentActionHandler => ({
  action: "AllocateWorkspaceSandbox",
  handle: ({ action, execution, context, invocation }) =>
    Effect.gen(function* () {
      if (
        action._tag !== "AllocateWorkspaceSandbox" ||
        context._tag !== "ExecutionOrigin" ||
        context.executionId !== execution.executionId ||
        execution.binding._tag !== "WorkspaceExecution" ||
        execution.state.status !== "Active"
      )
        return yield* Effect.fail(
          actionError(
            "Allocation requires the current active Parent Workspace execution",
          ),
        );
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const namespace = "allocate-workspace-sandbox-command";
      const observation = (workspaceId: string, revision: number) => ({
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `WorkspaceSandboxAllocated(${workspaceId}, revision ${revision}); recorded allocation only, current authority and resources are checked before use`,
          truncated: false,
        },
      });
      const prior = yield* findPriorCommandReceipt({
        context,
        namespace,
        occurrence,
        includeCurrent: true,
        commandReceipts: dependencies.commandReceipts,
        commandHandlerRegistry: dependencies.commandHandlerRegistry,
        tx: dependencies.tx,
        projectId: execution.projectId,
        commandType: "AuthorizeWorkspaceSandbox",
        operation: "AllocateWorkspaceSandbox.receiptFirst",
        errorOperation: "AllocateWorkspaceSandbox",
      });
      if (prior._tag === "TerminalRejected")
        return yield* Effect.fail(
          actionError(
            "The allocation was rejected; inspect the Child and current Parent authority before a new request",
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      if (prior._tag === "Committed") {
        const result = prior.receipt.resolution
          .result as Partial<WorkspaceSandboxAuthorizationResult> | null;
        const fact = decodeWorkspaceSandboxAuthorization(result?.authorization);
        if (
          fact?.state !== "Granted" ||
          fact.origin.kind !== "Parent" ||
          fact.projectId !== execution.projectId ||
          fact.origin.parentWorkspaceId !== execution.workspaceId ||
          fact.origin.parentExecutionId !== execution.executionId ||
          fact.commandId !== prior.receipt.commandId ||
          fact.actorPrincipal !== context.principal ||
          fact.profile !== action.profile ||
          fact.expiresAt !== action.expiresAt ||
          encodeNetworkPolicyV1(fact.networkPolicy) !==
            encodeNetworkPolicyV1(action.networkPolicy)
        )
          return yield* Effect.fail(
            actionOperationalFailure("AllocateWorkspaceSandbox.receiptFirst")(
              "Committed allocation does not match the pinned action",
            ),
          );
        const replayPayload: AuthorizeWorkspaceSandboxPayload = {
          workspaceId: fact.workspaceId,
          expectedAuthorizationRevision: fact.authorizationRevision - 1,
          expectedResourceBoundaryRevision: fact.resourceBoundaryRevision,
          expectedWorkspacePolicyRevision: fact.workspacePolicyRevision,
          profile: fact.profile,
          providerId: fact.providerId,
          networkPolicy: fact.networkPolicy,
          expiresAt: fact.expiresAt,
          source: {
            kind: "Parent",
            expectedParentAuthorizationRevision:
              fact.origin.parentAuthorizationRevision,
          },
        };
        if (
          prior.receipt.semanticRequestFingerprint !==
          semanticRequestFingerprint({
            commandType: "AuthorizeWorkspaceSandbox",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload: replayPayload,
          })
        )
          return yield* Effect.fail(
            actionOperationalFailure("AllocateWorkspaceSandbox.receiptFirst")(
              "Committed allocation fingerprint mismatch",
            ),
          );
        // Replay reports the old effect; it never overwrites a newer human head.
        return observation(fact.workspaceId, fact.authorizationRevision);
      }
      // Resolve before any new write, using the existing scoped placement port.
      const resolved = yield* dependencies.placement.resolveChildRef(
        execution.workspaceId,
        action.targetWorkspaceRef,
      );
      if (Option.isNone(resolved))
        return yield* Effect.fail(
          actionError(
            "Target ref is stale, foreign, retired or not an active direct Child",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      const targetWorkspaceId = resolved.value.targetWorkspaceId;
      const now = yield* dependencies.clock.now();
      const captured = yield* dependencies.tx.transact(
        Effect.gen(function* () {
          const target =
            yield* dependencies.workspaces.findById(targetWorkspaceId);
          const parent = yield* resolveCurrentWorkspaceSandboxAuthorization(
            dependencies,
            {
              projectId: execution.projectId,
              workspaceId: execution.workspaceId,
              now,
            },
          );
          const head = yield* dependencies.authorizations.findCurrent(
            execution.projectId,
            targetWorkspaceId,
          );
          return { target, parent, head };
        }),
      );
      if (
        Option.isNone(captured.target) ||
        captured.target.value.projectId !== execution.projectId ||
        captured.target.value.parentWorkspaceId !== execution.workspaceId ||
        captured.target.value.lifecycle !== "Active" ||
        captured.parent._tag !== "Authorized"
      )
        return yield* Effect.fail(
          actionError(
            "Current direct Child or Parent authorization is unavailable",
            "action/precondition",
            "WaitForStateChange",
          ),
        );
      if (
        Option.isSome(captured.head) &&
        captured.head.value.state === "Revoked"
      )
        return yield* Effect.fail(
          actionError(
            "The user revoked this Child. Only the user can restore its authority",
            "action/precondition",
            "WaitForStateChange",
          ),
        );
      const parent = captured.parent.authorization;
      const target = captured.target.value;
      const payload: AuthorizeWorkspaceSandboxPayload = {
        workspaceId: targetWorkspaceId,
        expectedAuthorizationRevision: Option.isSome(captured.head)
          ? captured.head.value.authorizationRevision
          : 0,
        expectedResourceBoundaryRevision: target.resourceBoundaryRevision,
        expectedWorkspacePolicyRevision: target.workspacePolicyRevision,
        profile: action.profile,
        providerId: parent.providerId,
        networkPolicy: action.networkPolicy,
        expiresAt: action.expiresAt,
        source: {
          kind: "Parent",
          expectedParentAuthorizationRevision: parent.authorizationRevision,
        },
      };
      const commandId = generationScopedCommandId(
        namespace,
        occurrence,
        context,
      );
      const receipt = yield* dependencies.gateway.execute<
        AuthorizeWorkspaceSandboxPayload,
        WorkspaceSandboxAuthorizationResult
      >(
        {
          commandType: "AuthorizeWorkspaceSandbox",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: now,
          payload,
        },
        context,
        {
          _tag: "WorkspaceSandboxAuthorizationAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AuthorizeWorkspaceSandbox",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          workspaceId: targetWorkspaceId,
          commandKind: "AuthorizeWorkspaceSandbox",
          source: {
            kind: "Parent",
            parentWorkspaceId: execution.workspaceId,
            parentAuthorizationRevision: parent.authorizationRevision,
            parentExecutionId: execution.executionId,
          },
        },
      );
      if (receipt.resolution._tag !== "Committed")
        return yield* Effect.fail(
          actionError(
            "Allocation rejected: the requested capabilities must fit current Parent authority and Child scope; a human revocation requires human restoration",
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      return observation(
        targetWorkspaceId,
        receipt.resolution.result.authorization.authorizationRevision,
      );
    }).pipe(
      Effect.mapError(actionOperationalFailure("AllocateWorkspaceSandbox")),
    ),
});

export const listWorkspacesHandler = (
  dependencies: WorkspacePlacementDependencies,
): AgentActionHandler => ({
  action: "ListWorkspaces",
  handle: ({ action, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "ListWorkspaces") {
        return yield* Effect.fail(
          actionOperationalFailure("ListWorkspaces.dispatch")(
            "ListWorkspaces handler received a different AgentAction",
          ),
        );
      }
      const snapshot = yield* dependencies.placement.list({
        rootWorkspaceId: execution.workspaceId,
        ...(action.cursor === undefined ? {} : { cursor: action.cursor }),
        ...(action.query === undefined ? {} : { query: action.query }),
      });
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: JSON.stringify(snapshot),
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ListWorkspaces"))),
});

export const readWorkspaceHandler = (
  dependencies: WorkspacePlacementDependencies,
): AgentActionHandler => ({
  action: "ReadWorkspace",
  handle: ({ action, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "ReadWorkspace") {
        return yield* Effect.fail(
          actionOperationalFailure("ReadWorkspace.dispatch")(
            "ReadWorkspace handler received a different AgentAction",
          ),
        );
      }
      const candidate = yield* dependencies.placement.read(
        execution.workspaceId,
        action.workspaceRef,
      );
      if (Option.isNone(candidate)) {
        return yield* Effect.fail(
          actionError(
            "workspaceRef is stale, foreign, retired, or outside direct-child scope",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: JSON.stringify(candidate.value),
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ReadWorkspace"))),
});

/** ACR-8 (DID v1.19): P6 formation semantics are closed. The handler
 * persists a Pending proposal only — the human RecordDecision gate (and the
 * formation consumer that creates the child on Approve) stays untouched.
 * `basisResponsibilityRevision` is bound from the workspace's current
 * responsibility revision (trusted Runtime fact, never model-supplied). */
export const proposeChildWorkspaceHandler = (
  dependencies: ProposeChildDependencies,
): AgentActionHandler => ({
  action: "ProposeChildWorkspace",
  handle: (input) =>
    Effect.gen(function* () {
      const { action, execution } = input;
      if (action._tag !== "ProposeChildWorkspace") {
        return yield* Effect.fail(
          actionOperationalFailure("ProposeChildWorkspace.dispatch")(
            "ProposeChildWorkspace handler received a different AgentAction",
          ),
        );
      }
      const persistProposal = () =>
        Effect.gen(function* () {
          const sender = yield* dependencies.workspaces.findById(
            execution.workspaceId,
          );
          if (Option.isNone(sender)) {
            return yield* Effect.fail(
              actionError("proposing Workspace is missing"),
            );
          }
          const proposal: ChildWorkspaceProposal = {
            name: action.proposal.name,
            rationale: action.proposal.rationale,
            responsibilityDraft: action.proposal.responsibilityDraft,
            resourceBoundaryDraft: {
              basisResponsibilityRevision: sender.value.responsibilityRevision,
              addresses: action.proposal.resourceBoundaryDraft.addresses,
            },
            ...(action.proposal.resourceOwnershipDelegation === undefined
              ? {}
              : {
                  resourceOwnershipDelegation:
                    action.proposal.resourceOwnershipDelegation,
                }),
            ...(action.proposal.initialWork === undefined
              ? {}
              : { initialWork: action.proposal.initialWork }),
          };
          if (!isChildWorkspaceProposal(proposal)) {
            return yield* Effect.fail(
              actionOperationalFailure("ProposeChildWorkspace.domainGuard")(
                "decoded proposal failed the domain proposal guard",
              ),
            );
          }
          const record = admitFormationProposal({
            proposalId: newFormationProposalId(
              `${execution.executionId}:${JSON.stringify(action.proposal)}`,
            ),
            parentWorkspaceId: execution.workspaceId,
            proposal,
          });
          const admittedAt = yield* dependencies.clock.now();
          const formationIds = deriveFormationIds(
            record.proposalId,
            record.revision,
          );
          yield* dependencies.proposals.insert(record);
          if (dependencies.fulfillments !== undefined) {
            yield* dependencies.fulfillments.put({
              proposalId: record.proposalId,
              proposalRevision: record.revision,
              expectedChildWorkspaceId: formationIds.workspaceId,
              expectedInitialWorkId:
                record.proposal.initialWork === undefined
                  ? null
                  : formationIds.workId,
              state: "AwaitingDecision",
              typedBlock: null,
              lastAttemptAt: null,
              revision: 0,
            });
          }
          yield* dependencies.inbox.admitUpsert({
            recipientWorkspaceId: record.parentWorkspaceId,
            entryKey: `gov:${record.proposalId}:${record.revision}`,
            kind: "Governance",
            summary: `formation proposal "${record.proposal.name}" revision ${record.revision} awaiting human decision`,
            admittedAt,
          });
          return record;
        });
      if (
        dependencies.loopSteps !== undefined &&
        dependencies.sessions !== undefined &&
        dependencies.providerTurns !== undefined
      ) {
        const committed = yield* commitDurableControlActionEffect({
          handlerInput: input,
          expectedToolName: "propose_workspace",
          tx: dependencies.tx,
          loopSteps: dependencies.loopSteps,
          providerTurns: dependencies.providerTurns,
          sessions: dependencies.sessions,
          clock: dependencies.clock,
          effect: () =>
            persistProposal().pipe(
              Effect.map((record) => ({
                value: record,
                result: {
                  observation: {
                    text: `ProposalRecorded(${record.proposalId}); awaiting a human RecordDecision (Approve/Reject/Modify)`,
                    truncated: false as const,
                  },
                  canonicalRefs: [record.proposalId],
                },
              })),
            ),
        });
        return committed.outcome;
      }
      if (
        dependencies.loopSteps !== undefined ||
        dependencies.sessions !== undefined
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("ProposeWorkspace.commit")(
            "P9 Control commit requires the exact ProviderTurn manifest store",
          ),
        );
      }
      const record = yield* dependencies.tx.transact(persistProposal());
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `ProposalRecorded(${record.proposalId}); awaiting a human RecordDecision (Approve/Reject/Modify)`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ProposeChildWorkspace"))),
});
