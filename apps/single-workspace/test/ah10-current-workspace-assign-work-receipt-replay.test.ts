import { ControlActionAuthorizer } from "@arbor/agent-runtime";
import { newUuid7 } from "@arbor/application";
import {
  CommandId,
  ExecutionId,
  type PermissionGrant,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  CommandStore,
  type ControlApprovalRecord,
  ControlApprovalStore,
  InboxProjectionStore,
  PermissionGrantRepository,
  type StoredCommandResolution,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ControlActionAuthorizerLive } from "../src/control-action-authorizer.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const providerTurnId = "ptn_current_assign_work_receipt" as never;
const invocation = {
  providerTurnId,
  outputPosition: 0,
  callRef: "call_current_assign_work_receipt",
  toolName: "assign_work",
  argumentsJson: "{}",
};
const action = {
  _tag: "AssignWork" as const,
  objective: "receipt-first current Workspace Work",
  why: "recover the committed current-Workspace assignment",
  constraints: ["preserve the committed Work"],
  completionExpectation: "one WorkAssigned event exists",
  verificationMission: {
    goal: "verify current-Workspace AssignWork receipt replay",
    criteria: [
      {
        criterionId: "one-work-assigned",
        requirement: "the exact committed assignment is adopted once",
        required: true,
      },
    ],
    riskRequirements: [],
  },
  reason: "AH10 receipt-first test",
};
const execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    episode: {
      _tag: "WorkEpisode",
      workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
      targetWorkRevision: 0,
    },
  },
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  admittedAt: "2026-10-15T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
} as never;
const principal = parse(Principal)("worker:ah10-current-assign-work");
const occurrence = `${providerTurnId}:0`;
const priorCommandId = parse(CommandId)(
  `cmd_${newUuid7("assign-work-command", occurrence)}`,
);
const controlBasis = {} as never;
const actionDigest = sha256Hex(
  JSON.stringify({ stableActionId: "core.control.assign-work", action }),
);
const controlBasisDigest = sha256Hex(JSON.stringify(controlBasis));
const approvalId = `cap_${sha256Hex(
  JSON.stringify({
    executionId,
    callRef: invocation.callRef,
    actionDigest,
    controlBasisDigest,
  }),
)}`;

const committedReceipt = (
  resultWorkspaceId: string = workspaceId,
): StoredCommandResolution => ({
  commandId: priorCommandId,
  projectId,
  semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
    "ah10-current-assign-work-receipt-fingerprint",
  ),
  schemaVersion: "1",
  fingerprintAlgorithmVersion: 1,
  resolution: "Committed",
  resultJson: JSON.stringify({
    workId: "wrk_committed_current_assign_work",
    workspaceId: resultWorkspaceId,
    lifecycle: "Open",
    revision: 0,
  }),
  terminalErrorJson: null,
  createdAt: "2026-10-15T00:00:00.000Z",
  settledAt: "2026-10-15T00:00:00.000Z",
});

const exactGrant: PermissionGrant = {
  permissionGrantId: "pgr_exact_current_assign_work" as never,
  scope: "project",
  issuer: "user:local" as never,
  lifetime: "test",
  subject: { _tag: "WorkspaceAgent", workspaceId },
  capability: "core.control.assign-work",
  target: workspaceId,
  validFrom: "2026-10-14T00:00:00.000Z",
  expiresAt: "2026-10-16T00:00:00.000Z",
  revision: 3,
  state: "Active",
};

const invalidGrantCases: ReadonlyArray<{
  readonly name: string;
  readonly grant: PermissionGrant;
}> = [
  {
    name: "expired",
    grant: { ...exactGrant, expiresAt: "2026-10-15T11:59:59.000Z" },
  },
  {
    name: "future validFrom",
    grant: { ...exactGrant, validFrom: "2026-10-15T12:00:01.000Z" },
  },
  {
    name: "HumanPrincipal subject",
    grant: {
      ...exactGrant,
      subject: {
        _tag: "HumanPrincipal",
        principal: parse(Principal)("user:local"),
      },
    },
  },
  {
    name: "other WorkspaceAgent subject",
    grant: {
      ...exactGrant,
      subject: {
        _tag: "WorkspaceAgent",
        workspaceId: parse(WorkspaceId)(
          "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
        ),
      },
    },
  },
  {
    name: "other Execution subject",
    grant: {
      ...exactGrant,
      subject: {
        _tag: "Execution",
        executionId: parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
        ),
      },
    },
  },
  {
    name: "wrong capability",
    grant: { ...exactGrant, capability: "core.control.accept-result" },
  },
  {
    name: "wildcard capability",
    grant: { ...exactGrant, capability: "*" },
  },
  {
    name: "missing revision",
    grant: (({ revision: _revision, ...grant }) => grant)(exactGrant),
  },
  {
    name: "NaN revision",
    grant: { ...exactGrant, revision: Number.NaN },
  },
  {
    name: "negative revision",
    grant: { ...exactGrant, revision: -1 },
  },
  {
    name: "fractional revision",
    grant: { ...exactGrant, revision: 1.5 },
  },
];

const exactConsumedApproval: ControlApprovalRecord = {
  approvalId,
  projectId,
  workspaceId,
  executionId,
  stableActionId: "core.control.assign-work",
  actionDigest,
  argumentsJson: invocation.argumentsJson,
  targetRef: workspaceId,
  controlBasisDigest,
  state: "Consumed",
  revision: 2,
  requestedAt: "2026-10-15T00:00:00.000Z",
  expiresAt: "2026-10-16T00:00:00.000Z",
  decidedAt: "2026-10-15T00:00:01.000Z",
  decidedBy: "user:local" as never,
  decisionReason: "approved",
  consumedAt: "2026-10-15T00:00:02.000Z",
  bindingProven: true,
  consumedBy: priorCommandId,
};

const authorizePriorReceipt = async (input: {
  readonly grants?: ReadonlyArray<PermissionGrant>;
  readonly approval?: ControlApprovalRecord;
  readonly receipt?: StoredCommandResolution;
}) => {
  let pendingApprovals = 0;
  let inboxAdmissions = 0;
  const receipt = input.receipt ?? committedReceipt();
  const services = Layer.mergeAll(
    Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-10-15T12:00:00.000Z"),
    } as never),
    Layer.succeed(CommandStore, {
      findResolution: () => Effect.succeed(Option.some(receipt)),
      insertCommitted: () => Effect.void,
      insertTerminalRejected: () => Effect.void,
      recordResolvingAttempt: () => Effect.void,
      recordRetryableAttempt: () => Effect.void,
    }),
    Layer.succeed(ControlApprovalStore, {
      findById: (id: string) =>
        Effect.succeed(
          input.approval?.approvalId === id
            ? Option.some(input.approval)
            : Option.none(),
        ),
      putPending: () =>
        Effect.sync(() => {
          pendingApprovals += 1;
        }),
    } as never),
    Layer.succeed(InboxProjectionStore, {
      admitUpsert: () =>
        Effect.sync(() => {
          inboxAdmissions += 1;
        }),
    } as never),
    Layer.succeed(PermissionGrantRepository, {
      activeGrants: () => Effect.succeed(input.grants ?? []),
    } as never),
    Layer.succeed(TransactionPort, {
      transact: (effect: Effect.Effect<unknown, unknown, never>) => effect,
    } as never),
    Layer.succeed(WorkspaceRepository, {
      findById: () =>
        Effect.succeed(
          Option.some({
            workspaceId,
            projectId,
            workspacePolicy: {},
          } as never),
        ),
    } as never),
  );
  const authorizerLayer = Layer.provide(ControlActionAuthorizerLive, services);
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const authorizer = yield* ControlActionAuthorizer;
        return yield* authorizer.authorize({
          action,
          invocation,
          logicalActionId: "lac_current_assign_work_receipt",
          execution,
          context: {
            _tag: "ExecutionOrigin" as const,
            principal,
            executionId,
            fencingGeneration: 1,
          } as never,
          controlBasis,
        });
      }),
      authorizerLayer,
    ),
  );
  return { result, pendingApprovals, inboxAdmissions };
};

describe("AH10 current-Workspace AssignWork receipt-first authorization", () => {
  it("replays an exact active PermissionGrant without approval admission or a new-command replay flag", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizePriorReceipt({ grants: [exactGrant] });

    expect(result).toMatchObject({
      _tag: "Authorized",
      authorityRef: "receipt-first:assign-work-current-workspace-grant",
      assignWorkEvidence: {
        _tag: "PermissionGrant",
        permissionGrantId: exactGrant.permissionGrantId,
        permissionGrantRevision: 3,
        projectId,
        subjectKind: "WorkspaceAgent",
        subjectRef: workspaceId,
        capability: "core.control.assign-work",
        targetRef: workspaceId,
        validFrom: exactGrant.validFrom,
        expiresAt: exactGrant.expiresAt,
        actionDigest,
        controlBasisDigest,
      },
    });
    expect("assignWorkReplay" in result).toBe(false);
    expect("assignWorkCommandReplay" in result).toBe(false);
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it("accepts an exact active Execution-subject grant", async () => {
    const { result } = await authorizePriorReceipt({
      grants: [
        {
          ...exactGrant,
          permissionGrantId: "pgr_exact_execution_assign_work" as never,
          subject: { _tag: "Execution", executionId },
        },
      ],
    });

    expect(result).toMatchObject({
      _tag: "Authorized",
      authorityRef: "receipt-first:assign-work-current-workspace-grant",
      assignWorkEvidence: {
        _tag: "PermissionGrant",
        subjectKind: "Execution",
        subjectRef: executionId,
      },
    });
    expect("assignWorkReplay" in result).toBe(false);
    expect("assignWorkCommandReplay" in result).toBe(false);
  });

  it("blocks a committed receipt when no exact active PermissionGrant exists", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizePriorReceipt({});

    expect(result).toEqual({ _tag: "RecoveryBlocked" });
    expect("assignWorkReplay" in result).toBe(false);
    expect("assignWorkCommandReplay" in result).toBe(false);
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it("blocks a mismatched PermissionGrant", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizePriorReceipt({
        grants: [
          {
            ...exactGrant,
            target: "ws_other" as never,
          },
        ],
      });

    expect(result).toEqual({ _tag: "RecoveryBlocked" });
    expect("assignWorkReplay" in result).toBe(false);
    expect("assignWorkCommandReplay" in result).toBe(false);
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it.each(invalidGrantCases)(
    "blocks a prior Committed receipt with $name PermissionGrant evidence without side effects",
    async ({ grant }) => {
      const { result, pendingApprovals, inboxAdmissions } =
        await authorizePriorReceipt({ grants: [grant] });

      expect(result).toEqual({ _tag: "RecoveryBlocked" });
      expect("assignWorkReplay" in result).toBe(false);
      expect("assignWorkCommandReplay" in result).toBe(false);
      expect(pendingApprovals).toBe(0);
      expect(inboxAdmissions).toBe(0);
    },
  );

  it("does not fall back to a matching grant when a deterministic Approval row exists but mismatches", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizePriorReceipt({
        grants: [exactGrant],
        approval: {
          ...exactConsumedApproval,
          actionDigest: "sha256:mismatched-action",
        },
      });

    expect(result).toEqual({ _tag: "RecoveryBlocked" });
    expect("assignWorkReplay" in result).toBe(false);
    expect("assignWorkCommandReplay" in result).toBe(false);
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it("preserves exact consumed-Approval command replay", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizePriorReceipt({ approval: exactConsumedApproval });

    expect(result).toMatchObject({
      _tag: "Authorized",
      authorityRef: "receipt-first:assign-work-current-workspace",
      assignWorkEvidence: {
        _tag: "ActionApproval",
        approvalId,
        approvalRevision: 1,
      },
      assignWorkCommandReplay: {
        commandId: priorCommandId,
        approvalId,
        approvalRevision: 1,
        consumedRevision: 2,
      },
    });
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it("blocks a Committed receipt whose result names another Workspace before grant fallback", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizePriorReceipt({
        grants: [exactGrant],
        receipt: committedReceipt("ws_other"),
      });

    expect(result).toEqual({ _tag: "RecoveryBlocked" });
    expect("assignWorkReplay" in result).toBe(false);
    expect("assignWorkCommandReplay" in result).toBe(false);
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });
});
