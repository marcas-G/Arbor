import type { CommandReceipt } from "@arbor/domain";
import {
  ID_SCHEMAS,
  type IdTypeName,
  ORDINAL_SCHEMAS,
  VerificationVerdict,
} from "@arbor/domain";
import type { CommandStoreError, StoredCommandResolution } from "@arbor/ports";
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

type ResultDecoderRegistry = Readonly<
  Record<RegisteredCommandType, Readonly<Record<string, Validator>>>
>;

/** Strict JSON DTO decoders for the current registered Handler/result pairs.
 * Command-specific result shape remains owned by each command contract. */
const resultDecoders: ResultDecoderRegistry = {
  CreateProject: {
    "1": (value) =>
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
  ConcludeVerification: { "1": concludeVerificationResult },
  GrantPermission: {
    "1": (value) =>
      objectWith(value, {
        permissionGrantId: id("PermissionGrantId"),
        state: permissionGrantLifecycle,
      }),
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

const rejectionDecoders = {
  IdempotencyConflict: tagged("IdempotencyConflict", {
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
    const byVersion = resultDecoders[commandType as RegisteredCommandType];
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
