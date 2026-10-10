import { ControlActionAuthorizer } from "@arbor/agent-runtime";
import { newUuid7 } from "@arbor/application";
import {
  CommandId,
  ExecutionId,
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
  ControlApprovalStore,
  InboxProjectionStore,
  PermissionGrantRepository,
  type StoredCommandResolution,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ControlActionAuthorizerLive } from "../src/control-action-authorizer.js";

const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const providerTurnId = "ptn_legacy_raw" as never;
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocation = {
  providerTurnId,
  outputPosition: 0,
  callRef: "call_legacy_raw",
  toolName: "assign_work",
  argumentsJson: "{}",
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
  admittedAt: "2026-10-10T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
} as never;

const generationContext = (generation: number) =>
  ({
    _tag: "ExecutionOrigin" as const,
    principal: parse(Principal)("worker:ah10"),
    executionId,
    fencingGeneration: generation,
  }) as never;

const authorizeRawChildAction = async (
  priorReceipt: "Committed" | "FencingRejected" | "Missing",
  exactRawTargetGrant = false,
) => {
  const action = {
    _tag: "AssignWork" as const,
    targetWorkspaceId: childWorkspaceId,
    objective: "legacy child assignment",
    why: "recover the already committed action",
    constraints: [],
    completionExpectation: "the legacy assignment is accounted for",
    verificationMission: {
      goal: "verify legacy receipt recovery",
      criteria: [
        {
          criterionId: "legacy-binding",
          requirement: "the action cannot bypass binding validation",
          required: true,
        },
      ],
      riskRequirements: [],
    },
    reason: "legacy raw child id from an old action record",
  };
  const occurrence = `${providerTurnId}:0`;
  const commandId = parse(CommandId)(
    `cmd_${newUuid7("assign-work-command", occurrence)}`,
  );
  let pendingApprovals = 0;
  let inboxAdmissions = 0;
  const storedReceipt: StoredCommandResolution | undefined =
    priorReceipt === "Missing"
      ? undefined
      : {
          commandId,
          projectId,
          semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
            "ah10-legacy-fixture-fingerprint",
          ),
          schemaVersion: "1",
          fingerprintAlgorithmVersion: 1,
          resolution:
            priorReceipt === "Committed" ? "Committed" : "TerminalRejected",
          resultJson:
            priorReceipt === "Committed"
              ? JSON.stringify({
                  workId: "wrk_legacy",
                  workspaceId: childWorkspaceId,
                })
              : null,
          terminalErrorJson:
            priorReceipt === "FencingRejected"
              ? JSON.stringify({ _tag: "FencingRejected" })
              : null,
          createdAt: "2026-10-10T00:00:00.000Z",
          settledAt: "2026-10-10T00:00:00.000Z",
        };
  const services = Layer.mergeAll(
    Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-10-10T00:00:00.000Z"),
    } as never),
    Layer.succeed(CommandStore, {
      findResolution: () =>
        Effect.succeed(
          storedReceipt === undefined
            ? Option.none()
            : Option.some(storedReceipt),
        ),
      insertCommitted: () => Effect.void,
      insertTerminalRejected: () => Effect.void,
      recordResolvingAttempt: () => Effect.void,
      recordRetryableAttempt: () => Effect.void,
    }),
    Layer.succeed(ControlApprovalStore, {
      findById: () => Effect.succeed(Option.none()),
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
      activeGrants: () =>
        Effect.succeed(
          exactRawTargetGrant
            ? [
                {
                  permissionGrantId: "pgr_exact_legacy_raw",
                  scope: "project",
                  issuer: "user:local",
                  lifetime: "test",
                  subject: { _tag: "WorkspaceAgent", workspaceId },
                  capability: "core.control.assign-work",
                  target: childWorkspaceId,
                  validFrom: "2026-10-09T00:00:00.000Z",
                  expiresAt: "2026-10-11T00:00:00.000Z",
                  revision: 1,
                  state: "Active",
                } as never,
              ]
            : [],
        ),
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
          invocation: { ...invocation, providerTurnId },
          logicalActionId: "lac_legacy_raw",
          execution,
          context: generationContext(1),
          controlBasis: {} as never,
        });
      }),
      authorizerLayer,
    ),
  );
  return { result, pendingApprovals, inboxAdmissions };
};

describe("AH10 raw direct-child AssignWork authorization routing", () => {
  it("routes a committed legacy raw-child-id action to binding validation", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizeRawChildAction("Committed");
    expect(result).toMatchObject({
      _tag: "Authorized",
      authorityRef: "receipt-first:assign-work",
      assignWorkReplay: true,
    });
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it("denies a new raw-child-id action before creating approval or Inbox rows", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizeRawChildAction("Missing");
    expect(result).toMatchObject({ _tag: "Denied" });
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });

  it("fails closed for a prior FencingRejected raw-ID action even with an exact raw-ID Grant", async () => {
    const { result, pendingApprovals, inboxAdmissions } =
      await authorizeRawChildAction("FencingRejected", true);
    expect(result).toMatchObject({ _tag: "Denied" });
    expect(pendingApprovals).toBe(0);
    expect(inboxAdmissions).toBe(0);
  });
});
