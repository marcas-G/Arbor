import type { CommandReceipt } from "@arbor/domain";
import {
  aggregateVerdict,
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  ID_SCHEMAS,
  type IdTypeName,
  NO_EFFECT_DENIAL_CODES,
  ORDINAL_SCHEMAS,
  Sha256,
  VerificationVerdict,
} from "@arbor/domain";
import {
  type CommandStoreError,
  type StoredCommandResolution,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Schema } from "effect";
import type { RegisteredCommandType } from "./external-command-codec.js";
import type { CommandRejection } from "./rejection.js";

type Validator = (value: unknown) => boolean;
type StringKeyedRecord = Readonly<Record<string, unknown>>;
type OrdinalName = keyof typeof ORDINAL_SCHEMAS;

const recordOf = (value: unknown): StringKeyedRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as StringKeyedRecord)
    : undefined;

const hasExactKeys = (
  value: unknown,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): value is StringKeyedRecord => {
  const record = recordOf(value);
  if (record === undefined) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => allowed.has(key))
  );
};

const objectWith = (
  value: unknown,
  required: Readonly<Record<string, Validator>>,
  optional: Readonly<Record<string, Validator>> = {},
): boolean => {
  const requiredKeys = Object.keys(required);
  const optionalKeys = Object.keys(optional);
  if (!hasExactKeys(value, requiredKeys, optionalKeys)) return false;
  const record = value as StringKeyedRecord;
  for (const [key, validate] of Object.entries(required)) {
    if (!validate(record[key])) return false;
  }
  for (const [key, validate] of Object.entries(optional)) {
    if (Object.hasOwn(record, key) && !validate(record[key])) return false;
  }
  return true;
};

const literal =
  (expected: string | number | boolean): Validator =>
  (value) =>
    value === expected;

const stringValue: Validator = (value) => typeof value === "string";
const booleanValue: Validator = (value) => typeof value === "boolean";
const nonNegativeInteger: Validator = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf =
  (...values: ReadonlyArray<string>): Validator =>
  (value) =>
    typeof value === "string" && values.includes(value);
const arrayOf =
  (validate: Validator, nonEmpty = false): Validator =>
  (value) =>
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every(validate);

const schemaValue =
  (schema: unknown): Validator =>
  (value) => {
    try {
      Schema.decodeUnknownSync(schema as never)(value);
      return true;
    } catch {
      return false;
    }
  };

const id = (name: IdTypeName): Validator => schemaValue(ID_SCHEMAS[name]);
const ordinal = (name: OrdinalName): Validator =>
  schemaValue(ORDINAL_SCHEMAS[name]);
const revision = ordinal("Revision");
const workRevision = ordinal("WorkRevision");
const dependencyRevision = ordinal("DependencyRevision");
const verificationVerdict = schemaValue(VerificationVerdict);
const terminalDenial = (value: unknown): boolean =>
  taggedUnionMember(value, {
    P4NoEffectDenied: tagged("P4NoEffectDenied", {
      reasonCode: oneOf(
        ...NO_EFFECT_DENIAL_CODES.filter((code) => code !== "ApprovalRequired"),
      ),
    }),
    HandlerRejected: tagged("HandlerRejected", {
      routeKind: literal("Executable"),
    }),
  });
const blockedActionRef: Validator = (value) =>
  objectWith(
    value,
    {
      executionId: id("ExecutionId"),
      providerTurnId: id("ProviderTurnId"),
      logicalStepNo: nonNegativeInteger,
      repairAttempt: nonNegativeInteger,
      actionIndex: nonNegativeInteger,
      logicalActionId: stringValue,
      callRef: stringValue,
      resultRef: stringValue,
      settlementRef: stringValue,
      observationSourceRef: stringValue,
      terminalDenial,
    },
    { toolInvocationId: id("ToolInvocationId") },
  );

const tagged =
  (tag: string, fields: Readonly<Record<string, Validator>> = {}): Validator =>
  (value) =>
    objectWith(value, { _tag: literal(tag), ...fields });

const taggedUnionMember = (
  value: unknown,
  tags: Readonly<Record<string, Validator>>,
): boolean => {
  const record = recordOf(value);
  if (record === undefined || typeof record._tag !== "string") return false;
  if (!Object.hasOwn(tags, record._tag)) return false;
  const validate = tags[record._tag];
  return validate?.(value) ?? false;
};

const wakeReason = (value: unknown): boolean =>
  taggedUnionMember(value, {
    WorkSelected: tagged("WorkSelected"),
    InputArrived: tagged("InputArrived"),
    DependencySatisfied: tagged("DependencySatisfied"),
    VerificationReturned: tagged("VerificationReturned"),
    HumanIntervention: tagged("HumanIntervention"),
    ChildDelivered: tagged("ChildDelivered"),
    EnvironmentChanged: tagged("EnvironmentChanged"),
    Recovery: tagged("Recovery"),
  });

const wakeCondition = (value: unknown): boolean =>
  taggedUnionMember(value, {
    DependencyChanged: tagged("DependencyChanged", {
      dependencyId: id("DependencyId"),
      observedRevision: revision,
    }),
    DecisionChanged: tagged("DecisionChanged", {
      decisionId: id("DecisionId"),
      observedRevision: revision,
    }),
    VerificationChanged: tagged("VerificationChanged", {
      workId: id("WorkId"),
      targetWorkRevision: revision,
    }),
    InboxAdvanced: tagged("InboxAdvanced", {
      workspaceId: id("WorkspaceId"),
      observedSequence: nonNegativeInteger,
    }),
    EnvironmentChanged: tagged("EnvironmentChanged", {
      environmentRef: stringValue,
      observedRevision: stringValue,
    }),
    TimeReached: tagged("TimeReached", { instant: stringValue }),
    Manual: tagged("Manual"),
  });

const waitSpec: Validator = (value) =>
  objectWith(value, {
    mode: literal("Any"),
    conditions: arrayOf(wakeCondition, true),
  });

const completedResult = (value: unknown): boolean =>
  taggedUnionMember(value, {
    Blocked: tagged("Blocked", {
      workId: id("WorkId"),
      targetWorkRevision: workRevision,
      blockerId: schemaValue(Sha256),
      waitFor: waitSpec,
      request: stringValue,
      failedActionRefs: arrayOf(blockedActionRef, true),
    }),
    Yielded: tagged("Yielded", {
      reason: stringValue,
      waitSpec,
    }),
    CompletionClaimed: tagged("CompletionClaimed", {
      workRevision,
      claimRef: stringValue,
    }),
    // Historical variants remain readable in existing v1 receipts only.
    CoordinationCompleted: tagged("CoordinationCompleted"),
    QueryCompleted: tagged("QueryCompleted"),
    ConversationResponseProduced: tagged("ConversationResponseProduced", {
      messageId: id("MessageId"),
    }),
    InboxInputHandled: tagged("InboxInputHandled", { entryKey: stringValue }),
    DecisionSubmitted: tagged("DecisionSubmitted", {
      decisionId: id("DecisionId"),
    }),
    VerificationConcluded: tagged("VerificationConcluded", {
      verificationId: id("VerificationId"),
      verdict: verificationVerdict,
    }),
  });

const interruptedResult = (value: unknown): boolean =>
  taggedUnionMember(value, {
    StopRequested: tagged("StopRequested"),
    ControlledInterruption: tagged("ControlledInterruption", {
      reason: stringValue,
    }),
  });

const executionSettlement: Validator = (value) =>
  taggedUnionMember(value, {
    Completed: tagged("Completed", { result: completedResult }),
    Interrupted: tagged("Interrupted", { result: interruptedResult }),
    Failed: tagged("Failed", {
      failure: tagged("ExecutionFailure", { reason: stringValue }),
    }),
    OutcomeUnknown: tagged("OutcomeUnknown", {
      reconciliation: tagged("ReconciliationRequired", {
        invocationRefs: arrayOf(stringValue, true),
      }),
    }),
  });

const satisfyDependencyWakeSignal: Validator = (value) =>
  objectWith(value, {
    workspaceId: id("WorkspaceId"),
    reason: wakeReason,
    detail: (detail) =>
      objectWith(detail, {
        dependencyId: id("DependencyId"),
        fromRevision: dependencyRevision,
        toRevision: dependencyRevision,
      }),
  });

const concludeVerificationWakeSignal: Validator = (value) =>
  objectWith(value, {
    workspaceId: id("WorkspaceId"),
    reason: wakeReason,
    detail: (detail) =>
      objectWith(detail, {
        verificationId: id("VerificationId"),
        workId: id("WorkId"),
        workRevision: workRevision,
        verdict: verificationVerdict,
      }),
  });

const permissionGrantLifecycle = oneOf("Active", "Revoked");
const formationProposalState = oneOf("Pending", "Approved", "Rejected");
const humanMessageState = oneOf("Pending", "Claimed", "Answered", "Declined");
const conversationResponseState = oneOf("Queued", "Cancelled");

const concludeVerificationResult: Validator = (value) =>
  objectWith(
    value,
    {
      verificationId: id("VerificationId"),
      state: literal("Concluded"),
      verdict: verificationVerdict,
      summaryRef: stringValue,
      wakeSignals: arrayOf(concludeVerificationWakeSignal),
      channel1Release: (release) =>
        objectWith(release, {
          workId: id("WorkId"),
          targetWorkRevision: workRevision,
        }),
    },
    { conclusionReason: oneOf("Orphaned") },
  ) &&
  (() => {
    const record = recordOf(value);
    return (
      record !== undefined &&
      (record.conclusionReason === undefined ||
        (record.conclusionReason === "Orphaned" &&
          record.verdict === "Unknown"))
    );
  })();

const concludeVerificationResultV2: Validator = (value) => {
  if (
    !objectWith(
      value,
      {
        verificationId: id("VerificationId"),
        state: literal("Concluded"),
        verdict: verificationVerdict,
        summaryRef: (ref) => typeof ref === "string" && ref.length > 0,
        wakeSignals: arrayOf(concludeVerificationWakeSignal),
        channel1Release: (release) =>
          objectWith(release, {
            workId: id("WorkId"),
            targetWorkRevision: workRevision,
          }),
        missionSnapshot: (snapshot) =>
          objectWith(snapshot, {
            goal: stringValue,
            criteria: arrayOf((criterion) =>
              objectWith(criterion, {
                criterionId: stringValue,
                requirement: stringValue,
                required: booleanValue,
              }),
            ),
            riskRequirements: arrayOf(stringValue),
          }),
        criteriaResults: arrayOf((result) =>
          objectWith(result, {
            criterionId: stringValue,
            requirement: stringValue,
            required: booleanValue,
            verdict: verificationVerdict,
            evidenceRefs: arrayOf(id("EvidenceId")),
          }),
        ),
        snapshotStatus: oneOf("Available", "NotApplicableOrphaned"),
      },
      { conclusionReason: oneOf("Orphaned") },
    )
  ) {
    return false;
  }
  const record = recordOf(value);
  if (record === undefined) return false;
  const mission = recordOf(record.missionSnapshot);
  const criteria = mission?.criteria;
  const results = record?.criteriaResults;
  if (!Array.isArray(criteria) || !Array.isArray(results)) return false;
  if (record.snapshotStatus === "NotApplicableOrphaned") {
    return (
      record.verdict === "Unknown" &&
      record.conclusionReason === "Orphaned" &&
      results.length === 0
    );
  }
  if (
    record.conclusionReason === "Orphaned" ||
    results.length !== criteria.length
  )
    return false;
  for (const [index, criterionValue] of criteria.entries()) {
    const criterion = recordOf(criterionValue);
    const result = recordOf(results[index]);
    if (
      criterion === undefined ||
      result === undefined ||
      result.criterionId !== criterion.criterionId ||
      result.requirement !== criterion.requirement ||
      result.required !== criterion.required
    ) {
      return false;
    }
  }
  return (
    aggregateVerdict(
      results as ReadonlyArray<{
        readonly required: boolean;
        readonly verdict: import("@arbor/domain").VerificationVerdict;
      }>,
    ) === record.verdict
  );
};

type ReceiptCommandType = RegisteredCommandType | "UpdateResourceBoundary";
type ReceiptSchemaVersion = "1" | "2";
type ResultDecoderRegistry = Readonly<
  Record<
    ReceiptCommandType,
    Readonly<Partial<Record<ReceiptSchemaVersion, Validator>>>
  >
>;

/** Strict JSON DTO decoders for the current registered Handler/result pairs.
 * Command-specific result shape remains owned by each command contract. */
const resultDecoders: ResultDecoderRegistry = {
  // F21 v1 CreateProject receipts are preserve-only. The current Handler is v2.
  CreateProject: {
    "2": (value) =>
      objectWith(value, {
        projectId: id("ProjectId"),
        rootWorkspaceId: id("WorkspaceId"),
        primarySessionId: id("SessionId"),
      }),
  },
  CreateChildWorkspace: {
    "1": (value) =>
      objectWith(value, {
        workspaceId: id("WorkspaceId"),
        projectId: id("ProjectId"),
        parentWorkspaceId: id("WorkspaceId"),
        primarySessionId: id("SessionId"),
      }),
  },
  AssignWork: {
    "1": (value) =>
      objectWith(value, {
        workId: id("WorkId"),
        workspaceId: id("WorkspaceId"),
        lifecycle: literal("Open"),
        revision: workRevision,
      }),
  },
  UpdateResourceBoundary: {
    "1": (value) =>
      objectWith(value, {
        workspaceId: id("WorkspaceId"),
        revision,
        resourceBoundaryRevision: revision,
        releasedClaimIds: arrayOf(stringValue),
      }),
  },
  RenameProject: {
    "1": (value) => objectWith(value, { revision, name: stringValue }),
  },
  CloseProject: {
    "1": (value) =>
      objectWith(value, { revision, lifecycle: literal("Closed") }),
  },
  SelectCurrentWork: {
    "1": (value) =>
      objectWith(value, {
        workspaceId: id("WorkspaceId"),
        workId: id("WorkId"),
        revision,
      }),
  },
  AdmitExecution: {
    "1": (value) =>
      objectWith(value, {
        executionId: id("ExecutionId"),
        workspaceId: id("WorkspaceId"),
        sessionId: id("SessionId"),
        bindingKind: oneOf("WorkspaceMain", "ExecutionBound"),
      }),
  },
  StopExecution: {
    "1": (value) =>
      objectWith(value, {
        executionId: id("ExecutionId"),
        stopRequestedAt: stringValue,
      }),
  },
  SettleExecution: {
    "1": (value) =>
      objectWith(value, {
        executionId: id("ExecutionId"),
        settlement: executionSettlement,
      }),
  },
  SendMessage: {
    "1": (value) =>
      objectWith(value, {
        messageId: id("MessageId"),
        admitted: literal(true),
        promotion: (promotion) =>
          objectWith(promotion, {
            closesCorrelation: (candidate) =>
              candidate === null || stringValue(candidate),
            triggersReevaluation: booleanValue,
          }),
      }),
  },
  DeliverMessage: {
    "1": (value) =>
      objectWith(value, {
        messageId: id("MessageId"),
        deliverableId: id("DeliverableId"),
        senderWorkspaceId: id("WorkspaceId"),
        recipientWorkspaceId: id("WorkspaceId"),
        admitted: literal(true),
      }),
  },
  DeclareDependency: {
    "1": (value) =>
      objectWith(value, {
        dependencyId: id("DependencyId"),
        consumerWorkId: id("WorkId"),
        state: literal("Unsatisfied"),
        revision: dependencyRevision,
      }),
  },
  ProduceDeliverable: {
    "1": (value) =>
      objectWith(value, {
        deliverableId: id("DeliverableId"),
        sourceWorkId: id("WorkId"),
        sourceWorkRevision: workRevision,
        kind: stringValue,
        artifactRoles: arrayOf(stringValue),
      }),
  },
  SatisfyDependency: {
    "1": (value) =>
      objectWith(value, {
        dependencyId: id("DependencyId"),
        state: literal("Satisfied"),
        dependencyRevision,
        deliverableId: id("DeliverableId"),
        satisfiedAtDependencyRevision: dependencyRevision,
        wakeSignals: arrayOf(satisfyDependencyWakeSignal),
      }),
  },
  RecordDecision: {
    "1": (value) =>
      objectWith(value, {
        proposalId: id("FormationProposalId"),
        proposalRevision: nonNegativeInteger,
        decision: oneOf("Approve", "Reject", "Modify"),
        state: formationProposalState,
      }),
  },
  ResolveControlApproval: {
    "1": (value) =>
      objectWith(value, {
        approvalId: stringValue,
        executionId: stringValue,
        state: oneOf("Approved", "Rejected", "Expired"),
        revision: nonNegativeInteger,
      }),
  },
  ResolveExecutableApproval: {
    "1": (value) =>
      objectWith(value, {
        approvalId: stringValue,
        executionId: stringValue,
        state: oneOf("Approved", "Rejected"),
        revision: nonNegativeInteger,
      }),
  },
  SteerWork: {
    "1": (value) =>
      objectWith(value, {
        workId: id("WorkId"),
        workspaceId: id("WorkspaceId"),
        lifecycle: literal("Open"),
        fromRevision: workRevision,
        toRevision: workRevision,
        severity: oneOf("Normal", "Critical"),
      }),
  },
  AcceptWorkOutcome: {
    "1": (value) =>
      objectWith(value, {
        acceptanceId: id("AcceptanceId"),
        workId: id("WorkId"),
        targetWorkRevision: workRevision,
        verificationId: id("VerificationId"),
      }),
  },
  CompleteWork: {
    "1": (value) =>
      objectWith(value, {
        workId: id("WorkId"),
        workspaceId: id("WorkspaceId"),
        lifecycle: literal("Completed"),
        revision: workRevision,
        clearedCurrentWork: booleanValue,
      }),
  },
  StartVerification: {
    "1": (value) =>
      objectWith(value, {
        verificationId: id("VerificationId"),
        workId: id("WorkId"),
        targetWorkRevision: workRevision,
        ownerWorkspaceId: id("WorkspaceId"),
        state: literal("Open"),
        verifierExecutionId: id("ExecutionId"),
      }),
  },
  RecordVerificationEvidence: {
    "1": (value) =>
      objectWith(value, {
        verificationId: id("VerificationId"),
        evidenceId: id("EvidenceId"),
        state: literal("Recorded"),
      }),
  },
  ConcludeVerification: {
    "1": concludeVerificationResult,
    "2": concludeVerificationResultV2,
  },
  RetryVerification: {
    "1": (value) =>
      objectWith(value, {
        workId: id("WorkId"),
        orphanedVerificationId: id("VerificationId"),
        successorVerificationId: id("VerificationId"),
        verifierExecutionId: id("ExecutionId"),
        state: literal("OrphanedAndRetried"),
      }),
  },
  GrantPermission: {
    "1": (value) =>
      objectWith(value, {
        permissionGrantId: id("PermissionGrantId"),
        state: permissionGrantLifecycle,
      }),
  },
  DecideSandboxPolicy: {
    "1": (value) => {
      try {
        return (
          decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
            JSON.stringify(value),
            sha256Hex,
          ) !== undefined
        );
      } catch {
        return false;
      }
    },
  },
  RevokePermission: {
    "1": (value) =>
      objectWith(value, {
        permissionGrantId: id("PermissionGrantId"),
        state: permissionGrantLifecycle,
      }),
  },
  SubmitHumanMessage: {
    "1": (value) =>
      objectWith(value, {
        // The current result DTO intentionally exposes this identity as string.
        messageId: stringValue,
        state: humanMessageState,
      }),
  },
  ResumeConversationResponse: {
    "1": (value) =>
      objectWith(value, {
        messageId: id("MessageId"),
        state: conversationResponseState,
        revision: nonNegativeInteger,
      }),
  },
  CancelConversationResponse: {
    "1": (value) =>
      objectWith(value, {
        messageId: id("MessageId"),
        state: conversationResponseState,
        revision: nonNegativeInteger,
      }),
  },
};

export interface CommandReceiptDecoderDescriptor {
  readonly commandType: ReceiptCommandType;
  readonly schemaVersion: ReceiptSchemaVersion;
  readonly source: "External" | "Internal";
  /** False only for ResolveControlApproval, whose handler is optional. */
  readonly required: boolean;
}

/** Trusted, closed inventory of decodable receipt pairs. It is deliberately
 * independent of persisted row contents: a row cannot select its own codec. */
export const COMMAND_RECEIPT_DECODER_DESCRIPTORS: ReadonlyArray<CommandReceiptDecoderDescriptor> =
  Object.freeze(
    Object.entries(resultDecoders).flatMap(([commandType, versions]) =>
      Object.keys(versions).map((schemaVersion) => ({
        commandType: commandType as ReceiptCommandType,
        schemaVersion: schemaVersion as ReceiptSchemaVersion,
        source:
          commandType === "UpdateResourceBoundary"
            ? ("Internal" as const)
            : ("External" as const),
        required: commandType !== "ResolveControlApproval",
      })),
    ),
  );

const rejectionDecoders = {
  IdempotencyConflict: tagged("IdempotencyConflict", {
    commandId: id("CommandId"),
  }),
  ProjectResourceUnavailable: tagged("ProjectResourceUnavailable", {
    commandId: id("CommandId"),
  }),
  AuthorityDenied: tagged("AuthorityDenied", { reason: stringValue }),
  RevisionConflict: tagged("RevisionConflict", {
    expected: revision,
    actual: revision,
  }),
  InvalidProjectName: tagged("InvalidProjectName", { reason: stringValue }),
  WorkNotOpen: tagged("WorkNotOpen", { workId: id("WorkId") }),
  TerminalLifecycleMutation: tagged("TerminalLifecycleMutation", {
    entity: stringValue,
    lifecycle: stringValue,
  }),
  RetirePreconditionFailed: tagged("RetirePreconditionFailed", {
    workspaceId: id("WorkspaceId"),
    reason: stringValue,
  }),
  ActiveExecutionConflict: tagged("ActiveExecutionConflict", {
    workspaceId: id("WorkspaceId"),
  }),
  VerificationAcceptanceMismatch: tagged("VerificationAcceptanceMismatch", {
    workId: id("WorkId"),
  }),
  DependencyNotSatisfiable: tagged("DependencyNotSatisfiable", {
    dependencyId: id("DependencyId"),
  }),
  PermissionRevoked: tagged("PermissionRevoked", {
    permissionGrantId: id("PermissionGrantId"),
  }),
  WorkPlanInvalid: tagged("WorkPlanInvalid", { reason: stringValue }),
  FencingRejected: tagged("FencingRejected"),
  ExecutionStopping: tagged("ExecutionStopping"),
  WorkspaceNotFound: tagged("WorkspaceNotFound", {
    workspaceId: id("WorkspaceId"),
  }),
  ExecutionNotFound: tagged("ExecutionNotFound", {
    executionId: id("ExecutionId"),
  }),
  WorkNotFound: tagged("WorkNotFound", { workId: id("WorkId") }),
  FormationProposalNotFound: tagged("FormationProposalNotFound", {
    proposalId: id("FormationProposalId"),
  }),
  ResourceExhausted: tagged("ResourceExhausted", { reason: stringValue }),
  DependencyNotFound: tagged("DependencyNotFound", {
    dependencyId: id("DependencyId"),
  }),
  DeliverableNotFound: tagged("DeliverableNotFound", {
    deliverableId: id("DeliverableId"),
  }),
  VerificationAlreadyOpen: tagged("VerificationAlreadyOpen", {
    workId: id("WorkId"),
  }),
  InvalidVerificationMission: tagged("InvalidVerificationMission", {
    reason: stringValue,
  }),
  VerificationNotFound: tagged("VerificationNotFound", {
    verificationId: id("VerificationId"),
  }),
  AcceptanceAlreadyExists: tagged("AcceptanceAlreadyExists", {
    workId: id("WorkId"),
  }),
  WorktreeNotFound: tagged("WorktreeNotFound", { worktreeId: stringValue }),
  WorktreeAlreadyExists: tagged("WorktreeAlreadyExists", {
    worktreeId: stringValue,
  }),
  WorkspaceNotActive: tagged("WorkspaceNotActive", {
    workspaceId: id("WorkspaceId"),
    lifecycle: literal("Retired"),
  }),
  WorktreeAlreadyRetired: tagged("WorktreeAlreadyRetired", {
    worktreeId: stringValue,
  }),
  ActiveClaimsExist: tagged("ActiveClaimsExist", {
    worktreeId: stringValue,
    claimIds: arrayOf(stringValue),
  }),
  StaleSandboxPolicyInputs: tagged("StaleSandboxPolicyInputs", {
    safeDetails: (details) =>
      objectWith(details, {
        field: oneOf(
          "EpisodeRevision",
          "PolicyRevision",
          "WorkspaceRevision",
          "ResourceBoundaryRevision",
          "SandboxHandleBindingDigest",
          "AuthorityBundleRevision",
          "OperatorConfigRevision",
          "ProviderRegistryRevision",
        ),
      }),
  }),
  SandboxPolicySummaryTooLarge: tagged("SandboxPolicySummaryTooLarge"),
  SandboxAuthorityUnavailable: tagged("SandboxAuthorityUnavailable"),
  ExecutionTerminal: tagged("ExecutionTerminal"),
  DecisionExpiryInvalid: tagged("DecisionExpiryInvalid"),
} satisfies Record<CommandRejection["_tag"], Validator>;

export const isCommandRejection = (
  value: unknown,
): value is CommandRejection => {
  const record = recordOf(value);
  if (record === undefined || typeof record._tag !== "string") return false;
  if (!Object.hasOwn(rejectionDecoders, record._tag)) return false;
  const validator = rejectionDecoders[record._tag as CommandRejection["_tag"]];
  return validator?.(value) ?? false;
};

const corruption = (): CommandStoreError => ({
  _tag: "PersistenceCorruption",
  repository: "CommandStore",
  operation: "decodeReceipt",
  reason: "stored command receipt does not match its registered schema",
});

export const decodeRegisteredCommandReceipt = <R>(
  stored: StoredCommandResolution,
  commandType: string,
  schemaVersion: string,
): Effect.Effect<CommandReceipt<R, CommandRejection>, CommandStoreError> => {
  try {
    if (
      !Object.hasOwn(resultDecoders, commandType) ||
      stored.schemaVersion !== schemaVersion
    ) {
      return Effect.fail(corruption());
    }
    const byVersion = resultDecoders[commandType as ReceiptCommandType];
    if (schemaVersion !== "1" && schemaVersion !== "2") {
      return Effect.fail(corruption());
    }
    if (!Object.hasOwn(byVersion, schemaVersion)) {
      return Effect.fail(corruption());
    }
    const validateResult = byVersion[schemaVersion];
    if (validateResult === undefined) return Effect.fail(corruption());

    if (stored.resolution === "Committed") {
      if (
        typeof stored.resultJson !== "string" ||
        stored.terminalErrorJson !== null
      ) {
        return Effect.fail(corruption());
      }
      const parsed: unknown = JSON.parse(stored.resultJson);
      if (!validateResult(parsed)) return Effect.fail(corruption());
      if (
        commandType === "DecideSandboxPolicy" &&
        (recordOf(parsed)?.commandId !== stored.commandId ||
          recordOf(parsed)?.projectId !== stored.projectId)
      ) {
        return Effect.fail(corruption());
      }
      const result =
        commandType === "ConcludeVerification" &&
        recordOf(parsed) !== undefined &&
        !Object.hasOwn(recordOf(parsed) ?? {}, "conclusionReason")
          ? { ...recordOf(parsed), conclusionReason: undefined }
          : parsed;
      return Effect.succeed({
        commandId: stored.commandId,
        projectId: stored.projectId,
        semanticRequestFingerprint: stored.semanticRequestFingerprint,
        schemaVersion: stored.schemaVersion,
        fingerprintAlgorithmVersion: stored.fingerprintAlgorithmVersion,
        createdAt: stored.createdAt,
        settledAt: stored.settledAt,
        resolution: { _tag: "Committed", result: result as R },
      });
    }

    if (
      stored.resolution !== "TerminalRejected" ||
      stored.resultJson !== null
    ) {
      return Effect.fail(corruption());
    }
    if (typeof stored.terminalErrorJson !== "string") {
      return Effect.fail(corruption());
    }
    const error: unknown = JSON.parse(stored.terminalErrorJson);
    if (!isCommandRejection(error)) return Effect.fail(corruption());
    return Effect.succeed({
      commandId: stored.commandId,
      projectId: stored.projectId,
      semanticRequestFingerprint: stored.semanticRequestFingerprint,
      schemaVersion: stored.schemaVersion,
      fingerprintAlgorithmVersion: stored.fingerprintAlgorithmVersion,
      createdAt: stored.createdAt,
      settledAt: stored.settledAt,
      resolution: { _tag: "TerminalRejected", error },
    });
  } catch {
    return Effect.fail(corruption());
  }
};
