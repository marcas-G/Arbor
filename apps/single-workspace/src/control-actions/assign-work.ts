import type {
  AgentAction,
  AgentActionError,
  AgentActionHandler,
  AgentLoopQualificationProbe,
} from "@arbor/agent-runtime";
import {
  type AssignWorkPayload,
  type AssignWorkResult,
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  newUuid7,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  type CommandId as CommandIdType,
  executionEpisode,
  parse,
  WorkId,
  WorkRevision,
  workEpisode,
} from "@arbor/domain";
import {
  type AssignWorkApprovalCommandEvidence,
  type AssignWorkBindingFailureCode,
  type AssignWorkCommandEvidence,
  type AssignWorkTargetBinding,
  type AssignWorkTargetBindingRepositoryService,
  type ClockService,
  type CommandStoreService,
  type ControlApprovalStoreService,
  type DomainEventJournalService,
  type PermissionGrantRepositoryService,
  type RecoveryAttentionFactStoreService,
  sha256Hex,
  type TransactionPortService,
  type WorkRepositoryService,
  type WorkspacePlacementPortService,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  actionError,
  actionOperationalFailure,
  generationScopedCommandId,
  type PriorCommittedCommandReceipt,
  findPriorCommandReceipt,
} from "./command-receipts.js";

export interface AssignWorkBindingAttentionQualificationEvent {
  readonly boundary: "AH10AfterAssignWorkBindingAttentionCommit";
  readonly executionId: string;
  readonly logicalActionId: string;
  readonly committedCommandId: string;
}

export type AssignWorkBindingAttentionQualificationProbe = (
  event: AssignWorkBindingAttentionQualificationEvent,
) => Promise<void>;

export interface AssignWorkDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<CommandStoreService, "findResolution">;
  readonly workspaces: WorkspaceRepositoryService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly placement?: WorkspacePlacementPortService;
  readonly bindings?: Pick<
    AssignWorkTargetBindingRepositoryService,
    "findByCommandId" | "findByExecutionAndAction"
  >;
  readonly bindingAttention?: Pick<
    RecoveryAttentionFactStoreService,
    "recordAssignWorkBindingFailure"
  >;
  readonly works?: WorkRepositoryService;
  readonly grants?: Pick<PermissionGrantRepositoryService, "findById">;
  readonly approvals?: Pick<ControlApprovalStoreService, "findById">;
  readonly journal?: DomainEventJournalService;
  readonly bindingAttentionQualificationProbe?: AssignWorkBindingAttentionQualificationProbe;
  readonly assignWorkAuthorizedBeforeCommandProbe?: AgentLoopQualificationProbe;
}

const validateAssignWorkReceiptBinding = (input: {
  readonly binding: AssignWorkTargetBinding;
  readonly prior: PriorCommittedCommandReceipt;
  readonly action: Extract<AgentAction, { readonly _tag: "AssignWork" }>;
  readonly execution: import("@arbor/domain").Execution;
  readonly invocation: import("@arbor/model-context").ToolInvocation;
  readonly logicalActionId: string;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly tx: TransactionPortService;
  readonly journal: DomainEventJournalService;
  readonly grants: Pick<PermissionGrantRepositoryService, "findById">;
  readonly approvals: Pick<ControlApprovalStoreService, "findById">;
}): Effect.Effect<AssignWorkBindingFailureCode | null, AgentActionError> =>
  Effect.gen(function* () {
    const { binding, prior, action, execution, invocation } = input;
    const receipt = prior;
    if (
      binding.schemaVersion !== 1 ||
      binding.targetRefEncodingVersion !== 1 ||
      binding.targetLifecycleAtCommit !== "Active"
    ) {
      return "MalformedBinding";
    }
    if (
      binding.commandId !== receipt.commandId ||
      binding.projectId !== execution.projectId ||
      receipt.projectId !== execution.projectId ||
      binding.executionId !== execution.executionId
    ) {
      return "ReceiptMismatch";
    }
    if (
      binding.parentWorkspaceId !== execution.workspaceId ||
      binding.targetWorkspaceRef !== action.targetWorkspaceRef ||
      binding.targetWorkspaceRef === undefined ||
      binding.targetWorkspaceRef === "current"
    ) {
      return "RefMismatch";
    }
    if (
      binding.providerTurnId !== invocation.providerTurnId ||
      binding.logicalActionId !== input.logicalActionId ||
      binding.callRef !== invocation.callRef
    ) {
      return "SourceActionMismatch";
    }
    const actionDigest = sha256Hex(
      JSON.stringify({
        stableActionId: "core.control.assign-work",
        action,
      }),
    );
    if (
      binding.authority.actionDigest !== actionDigest ||
      binding.authority.targetRef !== binding.targetWorkspaceRef
    ) {
      return "AuthorityMismatch";
    }
    const receiptResult = receipt.resolution.result;
    if (
      typeof receiptResult !== "object" ||
      receiptResult === null ||
      !("workId" in receiptResult) ||
      receiptResult.workId !== binding.workId ||
      !("workspaceId" in receiptResult) ||
      receiptResult.workspaceId !== binding.targetWorkspaceId ||
      !("lifecycle" in receiptResult) ||
      receiptResult.lifecycle !== "Open" ||
      !("revision" in receiptResult) ||
      receiptResult.revision !== 0
    ) {
      return "ReceiptMismatch";
    }
    const parent = yield* input.tx.transact(
      input.workspaces.findById(binding.parentWorkspaceId),
    );
    const target = yield* input.tx.transact(
      input.workspaces.findById(binding.targetWorkspaceId),
    );
    const parentWork = yield* input.tx.transact(
      input.works.findById(binding.parentWorkId),
    );
    const work = yield* input.tx.transact(input.works.findById(binding.workId));
    if (
      Option.isNone(parent) ||
      Option.isNone(target) ||
      parent.value.projectId !== binding.projectId ||
      target.value.projectId !== binding.projectId ||
      target.value.parentWorkspaceId !== binding.parentWorkspaceId
    ) {
      return "ForeignTarget";
    }
    if (
      Option.isNone(parentWork) ||
      parentWork.value.projectId !== binding.projectId ||
      parentWork.value.workspaceId !== binding.parentWorkspaceId ||
      binding.parentWorkId !== workEpisode(execution)?.workId
    ) {
      return "PlacementMismatch";
    }
    const expectedProvenance = {
      predecessorWorkId: binding.parentWorkId,
      reason: action.reason,
    };
    if (
      binding.predecessorWorkId !== binding.parentWorkId ||
      binding.workProvenanceJson !== JSON.stringify(expectedProvenance)
    ) {
      return "ProvenanceMismatch";
    }
    if (
      Option.isNone(work) ||
      work.value.projectId !== binding.projectId ||
      work.value.workspaceId !== binding.targetWorkspaceId ||
      work.value.objective !== action.objective ||
      work.value.why !== action.why ||
      JSON.stringify(work.value.constraints) !==
        JSON.stringify(action.constraints) ||
      work.value.completionExpectation !== action.completionExpectation ||
      JSON.stringify(work.value.verificationMission) !==
        JSON.stringify(action.verificationMission) ||
      JSON.stringify(work.value.provenance) !== binding.workProvenanceJson
    ) {
      return "WorkMismatch";
    }
    if (binding.authority._tag === "PermissionGrant") {
      const grant = yield* input.tx.transact(
        input.grants.findById(binding.authority.permissionGrantId),
      );
      if (
        Option.isNone(grant) ||
        grant.value.revision !== binding.authority.permissionGrantRevision ||
        grant.value.capability !== binding.authority.capability ||
        grant.value.target !== binding.authority.targetRef ||
        grant.value.validFrom !== binding.authority.validFrom ||
        (grant.value.expiresAt ?? null) !== binding.authority.expiresAt ||
        (binding.authority.subjectKind === "WorkspaceAgent" &&
          (grant.value.subject?._tag !== "WorkspaceAgent" ||
            grant.value.subject.workspaceId !==
              binding.authority.subjectRef)) ||
        (binding.authority.subjectKind === "Execution" &&
          (grant.value.subject?._tag !== "Execution" ||
            grant.value.subject.executionId !== binding.authority.subjectRef))
      ) {
        return "AuthorityMismatch";
      }
    } else {
      const approval = yield* input.tx.transact(
        input.approvals.findById(binding.authority.approvalId),
      );
      if (
        Option.isNone(approval) ||
        approval.value.bindingProven !== true ||
        approval.value.state !== "Consumed" ||
        approval.value.revision !== binding.authority.approvalRevision + 1 ||
        approval.value.consumedBy !== binding.commandId ||
        approval.value.projectId !== binding.authority.projectId ||
        approval.value.workspaceId !== binding.authority.workspaceId ||
        approval.value.executionId !== binding.authority.executionId ||
        approval.value.stableActionId !== binding.authority.stableActionId ||
        approval.value.actionDigest !== binding.authority.actionDigest ||
        approval.value.targetRef !== binding.authority.targetRef ||
        approval.value.controlBasisDigest !==
          binding.authority.controlBasisDigest ||
        approval.value.expiresAt !== binding.authority.expiresAt
      ) {
        return "AuthorityMismatch";
      }
    }
    const events = yield* input.tx.transact(
      Effect.gen(function* () {
        const last = yield* input.journal.lastSequence(binding.projectId);
        return last === 0
          ? []
          : yield* input.journal.readAfter(binding.projectId, 0, last);
      }),
    );
    const workAssigned = events.filter((event) => {
      if (
        event.eventType !== "WorkAssigned" ||
        event.causedByCommandId !== binding.commandId ||
        event.aggregateRef !== binding.targetWorkspaceId
      ) {
        return false;
      }
      const payload =
        typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : {};
      return (
        payload.workId === binding.workId &&
        payload.workspaceId === binding.targetWorkspaceId &&
        payload.projectId === binding.projectId &&
        payload.objective === action.objective
      );
    });
    if (workAssigned.length !== 1) return "EventMismatch";
    return null;
  }).pipe(
    Effect.mapError(actionOperationalFailure("AssignWork.bindingValidation")),
  );

/** DID v1.26 VDC-5: model authors bounded Work semantics and the readable
 * provenance reason. Runtime binds target, identities, revisions,
 * predecessor and authority. */
export const assignWorkHandler = (
  dependencies: AssignWorkDependencies,
): AgentActionHandler => ({
  action: "AssignWork",
  handle: ({
    action,
    invocation,
    execution,
    context,
    logicalActionId,
    assignWorkEvidence,
    assignWorkReplay,
    assignWorkCommandReplay,
  }) =>
    Effect.gen(function* () {
      if (action._tag !== "AssignWork") {
        return yield* Effect.fail(
          actionOperationalFailure("AssignWork.dispatch")(
            "AssignWork handler received a different AgentAction",
          ),
        );
      }
      const episode = executionEpisode(execution);
      if (
        episode?._tag === "ConversationResponseEpisode" &&
        action.targetWorkspaceId !== undefined &&
        action.targetWorkspaceId !== execution.workspaceId
      ) {
        return yield* Effect.fail(
          actionError(
            "Root conversation can assign Work only to its current Workspace",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      if (assignWorkReplay === true) {
        if (
          context._tag !== "ExecutionOrigin" ||
          logicalActionId === undefined
        ) {
          return yield* Effect.fail(
            actionOperationalFailure("AssignWork.receiptFirst")(
              "receipt-first recovery omitted its pinned execution action",
            ),
          );
        }
        const block = (
          committedCommandId: CommandIdType,
          failureCode: AssignWorkBindingFailureCode,
        ) =>
          Effect.gen(function* () {
            if (dependencies.bindingAttention === undefined) {
              return yield* Effect.fail<AgentActionError>(
                actionOperationalFailure("AssignWork.bindingAttentionStore")(
                  "P9 AssignWork binding failure store is unavailable",
                ),
              );
            }
            yield* dependencies.tx.transact(
              dependencies.bindingAttention.recordAssignWorkBindingFailure({
                projectId: execution.projectId,
                executionId: execution.executionId,
                targetWorkspaceId: execution.workspaceId,
                logicalActionId,
                committedCommandId,
                failureCode,
                firstDetectedAt: yield* dependencies.clock.now(),
              }),
            );
            if (dependencies.bindingAttentionQualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  dependencies.bindingAttentionQualificationProbe?.({
                    boundary: "AH10AfterAssignWorkBindingAttentionCommit",
                    executionId: execution.executionId,
                    logicalActionId,
                    committedCommandId,
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail<AgentActionError>({
              _tag: "AgentActionRecoveryBlocked",
              executionId: execution.executionId,
              logicalActionId,
            });
          }).pipe(
            Effect.mapError(
              actionOperationalFailure("AssignWork.bindingAttention"),
            ),
          );
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "assign-work-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          tx: dependencies.tx,
          projectId: execution.projectId,
          commandType: "AssignWork",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          onCommittedDecodeFailure: (commandId) =>
            block(commandId, "ReceiptMismatch"),
          operation: "AssignWork.priorReceipt",
          errorOperation: "AssignWork",
          lookupOperation: "AssignWork.receiptLookup",
          identityErrorMessage:
            "prior Command receipt belongs to another Project",
        });
        if (prior._tag !== "Committed") {
          return yield* Effect.fail(
            actionOperationalFailure("AssignWork.receiptFirst")(
              "authorizer observed a prior Committed receipt which receipt-first lookup could not reproduce",
            ),
          );
        }
        if (
          dependencies.bindings === undefined ||
          dependencies.works === undefined ||
          dependencies.grants === undefined ||
          dependencies.approvals === undefined ||
          dependencies.journal === undefined
        ) {
          return yield* Effect.fail(
            actionOperationalFailure("AssignWork.bindingRecovery")(
              "proof-complete AssignWork binding recovery dependencies are unavailable",
            ),
          );
        }
        const rows = yield* dependencies.tx
          .transact(
            dependencies.bindings.findByExecutionAndAction(
              execution.executionId,
              logicalActionId,
            ),
          )
          .pipe(
            Effect.catchTag("PersistenceCorruption", () =>
              Effect.succeed(
                null as unknown as ReadonlyArray<AssignWorkTargetBinding>,
              ),
            ),
          );
        if (rows === null)
          return yield* block(prior.receipt.commandId, "MalformedBinding");
        if (rows.length > 1)
          return yield* block(prior.receipt.commandId, "DuplicateBinding");
        const binding = rows[0];
        if (binding === undefined)
          return yield* block(prior.receipt.commandId, "LegacyUnbound");
        if (binding.commandId !== prior.receipt.commandId) {
          return yield* block(prior.receipt.commandId, "SourceActionMismatch");
        }
        const exact = yield* dependencies.tx
          .transact(
            dependencies.bindings.findByCommandId(prior.receipt.commandId),
          )
          .pipe(
            Effect.catchTag("PersistenceCorruption", () =>
              Effect.succeed(Option.none<AssignWorkTargetBinding>()),
            ),
          );
        if (Option.isNone(exact))
          return yield* block(prior.receipt.commandId, "MalformedBinding");
        const validation = yield* validateAssignWorkReceiptBinding({
          binding,
          prior: prior.receipt,
          action,
          execution,
          invocation,
          logicalActionId,
          workspaces: dependencies.workspaces,
          works: dependencies.works,
          tx: dependencies.tx,
          journal: dependencies.journal,
          grants: dependencies.grants,
          approvals: dependencies.approvals,
        });
        if (validation !== null)
          return yield* block(prior.receipt.commandId, validation);
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `WorkAssigned(${binding.workId}, ${binding.targetWorkspaceId})`,
            truncated: false,
          },
        };
      }
      if (
        action.targetWorkspaceId !== undefined &&
        action.targetWorkspaceId !== execution.workspaceId
      ) {
        return yield* Effect.fail(
          actionError(
            "AssignWork direct-child targets must use a resolved opaque targetWorkspaceRef",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      let resolvedChild:
        | import("@arbor/ports").ResolvedChildPlacementRef
        | undefined;
      let targetWorkspaceId = action.targetWorkspaceId ?? execution.workspaceId;
      if (action.targetWorkspaceRef !== undefined) {
        if (action.targetWorkspaceRef === "current") {
          targetWorkspaceId = execution.workspaceId;
        } else {
          if (dependencies.placement === undefined) {
            return yield* Effect.fail(
              actionError(
                "Workspace placement resolver is unavailable",
                "action/tool-unavailable",
                "WaitForStateChange",
              ),
            );
          }
          const resolved = yield* dependencies.placement.resolveChildRef(
            execution.workspaceId,
            action.targetWorkspaceRef,
          );
          if (Option.isNone(resolved)) {
            return yield* Effect.fail(
              actionError(
                "targetWorkspaceRef is stale, foreign, retired, or not a direct child",
                "action/target-unavailable",
                "RetryWithChangedInput",
              ),
            );
          }
          resolvedChild = resolved.value;
          targetWorkspaceId = resolved.value.targetWorkspaceId;
        }
      }
      const target = yield* dependencies.tx.transact(
        dependencies.workspaces.findById(targetWorkspaceId),
      );
      if (Option.isNone(target)) {
        return yield* Effect.fail(
          actionError("AssignWork target Workspace is missing"),
        );
      }
      const structurallyAuthorized =
        targetWorkspaceId === execution.workspaceId ||
        target.value.parentWorkspaceId === execution.workspaceId;
      if (
        !structurallyAuthorized ||
        target.value.projectId !== execution.projectId ||
        target.value.lifecycle !== "Active"
      ) {
        return yield* Effect.fail(
          actionError(
            "AssignWork target must be the current Workspace or its active direct child",
            "action/target-unavailable",
          ),
        );
      }
      const payload: AssignWorkPayload = {
        workId: parse(WorkId)(`wrk_${newUuid7("assign-work", occurrence)}`),
        workspaceId: targetWorkspaceId,
        expectedWorkspaceRevision: target.value.revision,
        objective: action.objective,
        why: action.why,
        constraints: action.constraints,
        completionExpectation: action.completionExpectation,
        verificationMission: action.verificationMission,
        provenance: {
          predecessorWorkId: workEpisode(execution)?.workId ?? null,
          reason: action.reason,
        },
        revision: parse(WorkRevision)(0),
      };
      if (assignWorkCommandReplay !== undefined) {
        const journal = dependencies.journal;
        const blockReplay = () =>
          Effect.fail<AgentActionError>({
            _tag: "AgentActionRecoveryBlocked",
            executionId: execution.executionId,
            logicalActionId:
              logicalActionId ?? assignWorkCommandReplay.commandId,
          });
        if (
          context._tag !== "ExecutionOrigin" ||
          logicalActionId === undefined ||
          assignWorkEvidence?._tag !== "ActionApproval" ||
          assignWorkCommandReplay.approvalId !==
            assignWorkEvidence.approvalId ||
          assignWorkCommandReplay.approvalRevision !==
            assignWorkEvidence.approvalRevision ||
          assignWorkCommandReplay.consumedRevision !==
            assignWorkCommandReplay.approvalRevision + 1 ||
          targetWorkspaceId !== execution.workspaceId ||
          dependencies.commandReceipts === undefined ||
          dependencies.commandHandlerRegistry === undefined ||
          dependencies.works === undefined ||
          dependencies.approvals === undefined ||
          journal === undefined
        ) {
          return yield* blockReplay();
        }
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "assign-work-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          tx: dependencies.tx,
          projectId: execution.projectId,
          commandType: "AssignWork",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          operation: "AssignWork.currentWorkspaceReceiptReplay",
          errorOperation: "AssignWork",
          lookupOperation: "AssignWork.receiptLookup",
          identityErrorMessage:
            "prior current-Workspace AssignWork receipt belongs to another Project",
        });
        if (
          prior._tag !== "Committed" ||
          prior.receipt.commandId !== assignWorkCommandReplay.commandId ||
          prior.receipt.semanticRequestFingerprint !==
            semanticRequestFingerprint({
              commandType: "AssignWork",
              projectId: execution.projectId,
              actor: context.principal as never,
              schemaVersion: "1",
              payload,
            })
        ) {
          return yield* blockReplay();
        }
        const result = prior.receipt.resolution.result;
        if (
          typeof result !== "object" ||
          result === null ||
          !("workId" in result) ||
          result.workId !== payload.workId ||
          !("workspaceId" in result) ||
          result.workspaceId !== execution.workspaceId
        ) {
          return yield* blockReplay();
        }
        const approval = yield* dependencies.tx.transact(
          dependencies.approvals.findById(assignWorkCommandReplay.approvalId),
        );
        const authority = assignWorkEvidence;
        if (
          Option.isNone(approval) ||
          approval.value.state !== "Consumed" ||
          approval.value.bindingProven !== true ||
          approval.value.revision !==
            assignWorkCommandReplay.consumedRevision ||
          approval.value.consumedBy !== assignWorkCommandReplay.commandId ||
          approval.value.projectId !== execution.projectId ||
          approval.value.workspaceId !== execution.workspaceId ||
          approval.value.executionId !== execution.executionId ||
          approval.value.stableActionId !== authority.stableActionId ||
          approval.value.actionDigest !== authority.actionDigest ||
          approval.value.targetRef !== execution.workspaceId ||
          approval.value.controlBasisDigest !== authority.controlBasisDigest ||
          approval.value.expiresAt !== authority.expiresAt ||
          authority.actionDigest !==
            sha256Hex(
              JSON.stringify({
                stableActionId: "core.control.assign-work",
                action,
              }),
            )
        ) {
          return yield* blockReplay();
        }
        const work = yield* dependencies.tx.transact(
          dependencies.works.findById(result.workId as WorkId),
        );
        if (
          Option.isNone(work) ||
          work.value.projectId !== execution.projectId ||
          work.value.workspaceId !== execution.workspaceId ||
          work.value.objective !== action.objective ||
          work.value.why !== action.why ||
          JSON.stringify(work.value.constraints) !==
            JSON.stringify(action.constraints) ||
          work.value.completionExpectation !== action.completionExpectation ||
          JSON.stringify(work.value.verificationMission) !==
            JSON.stringify(action.verificationMission) ||
          work.value.provenance.reason !== action.reason ||
          work.value.provenance.predecessorWorkId !==
            (workEpisode(execution)?.workId ?? null)
        ) {
          return yield* blockReplay();
        }
        const assignedEvents = yield* dependencies.tx.transact(
          Effect.gen(function* () {
            const matches = [];
            let cursor = 0;
            for (;;) {
              const batch = yield* journal.readAfter(
                execution.projectId,
                cursor,
                512,
              );
              for (const event of batch) {
                if (
                  event.eventType === "WorkAssigned" &&
                  event.causedByCommandId === assignWorkCommandReplay.commandId
                ) {
                  matches.push(event);
                }
              }
              if (batch.length < 512) break;
              const last = batch[batch.length - 1];
              if (last === undefined || Number(last.sequence) <= cursor) {
                return yield* Effect.fail(
                  actionOperationalFailure(
                    "AssignWork.currentWorkspaceReceiptReplay",
                  )("WorkAssigned journal scan did not advance"),
                );
              }
              cursor = Number(last.sequence);
            }
            return matches;
          }),
        );
        if (
          assignedEvents.length !== 1 ||
          assignedEvents[0]?.aggregateRef !== execution.workspaceId ||
          typeof assignedEvents[0]?.payload !== "object" ||
          assignedEvents[0].payload === null ||
          !("workId" in assignedEvents[0].payload) ||
          assignedEvents[0].payload.workId !== result.workId ||
          !("workspaceId" in assignedEvents[0].payload) ||
          assignedEvents[0].payload.workspaceId !== execution.workspaceId ||
          !("projectId" in assignedEvents[0].payload) ||
          assignedEvents[0].payload.projectId !== execution.projectId ||
          !("objective" in assignedEvents[0].payload) ||
          assignedEvents[0].payload.objective !== action.objective
        ) {
          return yield* blockReplay();
        }
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `WorkAssigned(${result.workId}, ${execution.workspaceId})`,
            truncated: false,
          },
          approvalConsumption: {
            approvalId: approval.value.approvalId,
            commandId: assignWorkCommandReplay.commandId,
            consumedRevision: approval.value.revision,
          },
        };
      }
      if (context._tag === "ExecutionOrigin" && context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "assign-work-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "AssignWork",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "AssignWork.priorReceipt",
          errorOperation: "AssignWork",
          lookupOperation: "AssignWork.receiptLookup",
          identityErrorMessage:
            "prior Command receipt belongs to another Project",
        });
        if (prior._tag === "Committed") {
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("workId" in result) ||
            result.workId !== payload.workId ||
            !("workspaceId" in result) ||
            result.workspaceId !== targetWorkspaceId
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("AssignWork.priorReceipt")(
                "prior Committed result does not match the pinned action",
              ),
            );
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `WorkAssigned(${payload.workId}, ${targetWorkspaceId})`,
              truncated: false,
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return yield* Effect.fail(
            actionError(
              "earlier command was terminally rejected",
              "action/canonical-rejected",
              "WaitForStateChange",
            ),
          );
        }
      }
      const commandId = generationScopedCommandId(
        "assign-work-command",
        occurrence,
        context,
      );
      let commandEvidence: AssignWorkCommandEvidence | undefined;
      let approvalCommandEvidence:
        | AssignWorkApprovalCommandEvidence
        | undefined;
      if (resolvedChild !== undefined) {
        if (
          action.targetWorkspaceRef === undefined ||
          assignWorkEvidence === undefined ||
          logicalActionId === undefined ||
          payload.provenance.predecessorWorkId === null
        ) {
          return yield* Effect.fail(
            actionError(
              "Direct-child AssignWork is missing trusted target, source-action, or authorization evidence",
              "action/canonical-rejected",
              "WaitForStateChange",
            ),
          );
        }
        commandEvidence = {
          commandId,
          projectId: execution.projectId,
          executionId: execution.executionId,
          providerTurnId: invocation.providerTurnId,
          logicalActionId,
          callRef: invocation.callRef,
          parentWorkspaceId: execution.workspaceId,
          parentWorkId: payload.provenance.predecessorWorkId,
          targetWorkspaceRef: action.targetWorkspaceRef,
          target: resolvedChild,
          authority: assignWorkEvidence,
          action: {
            _tag: "AssignWork",
            targetWorkspaceRef: action.targetWorkspaceRef,
            objective: action.objective,
            why: action.why,
            constraints: action.constraints,
            completionExpectation: action.completionExpectation,
            verificationMission: action.verificationMission,
            reason: action.reason,
          },
        };
      } else if (
        assignWorkEvidence?._tag === "ActionApproval" &&
        context._tag === "ExecutionOrigin" &&
        logicalActionId !== undefined
      ) {
        approvalCommandEvidence = {
          commandId,
          projectId: execution.projectId,
          executionId: execution.executionId,
          providerTurnId: invocation.providerTurnId,
          logicalActionId,
          callRef: invocation.callRef,
          workspaceId: execution.workspaceId,
          authority: assignWorkEvidence,
          action,
        };
      }
      if (
        assignWorkEvidence?._tag === "ActionApproval" &&
        (context._tag !== "ExecutionOrigin" || logicalActionId === undefined)
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("AssignWork.approvalEvidence")(
            "approved AssignWork requires the pinned Runtime action identity",
          ),
        );
      }
      if (
        commandEvidence !== undefined &&
        dependencies.assignWorkAuthorizedBeforeCommandProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            dependencies.assignWorkAuthorizedBeforeCommandProbe?.({
              boundary: "AH10AfterAssignWorkAuthorizedBeforeCommandSubmission",
              providerTurnId: String(invocation.providerTurnId),
              executionId: String(execution.executionId),
              logicalActionId: commandEvidence?.logicalActionId,
              callRef: commandEvidence?.callRef,
              actionIndex: invocation.outputPosition,
            }) ?? Promise.resolve(),
        );
      }
      const receipt = yield* dependencies.gateway.execute<
        AssignWorkPayload,
        AssignWorkResult
      >(
        {
          commandType: "AssignWork",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
          ...(commandEvidence === undefined
            ? {}
            : { assignWorkEvidence: commandEvidence }),
          ...(approvalCommandEvidence === undefined
            ? {}
            : { assignWorkApprovalEvidence: approvalCommandEvidence }),
        },
        context,
        {
          _tag: "AssignWorkAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AssignWork",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          targetWorkspaceId,
        },
      );
      if (
        receipt.commandId !== commandId ||
        receipt.resolution._tag !== "Committed"
      ) {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "AssignWork failed operationally",
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `WorkAssigned(${receipt.resolution.result.workId}, ${targetWorkspaceId})`,
          truncated: false,
        },
        ...(commandEvidence?.authority._tag === "ActionApproval"
          ? {
              approvalConsumption: {
                approvalId: commandEvidence.authority.approvalId,
                commandId,
                consumedRevision:
                  commandEvidence.authority.approvalRevision + 1,
              },
            }
          : approvalCommandEvidence === undefined
            ? {}
            : {
                approvalConsumption: {
                  approvalId: approvalCommandEvidence.authority.approvalId,
                  commandId,
                  consumedRevision:
                    approvalCommandEvidence.authority.approvalRevision + 1,
                },
              }),
      };
    }).pipe(Effect.mapError(actionOperationalFailure("AssignWork"))),
});
