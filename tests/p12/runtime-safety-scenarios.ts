import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  admitExecution,
  buildSingleWorkspaceLayer,
  evaluateAndSelect,
} from "../../apps/single-workspace/src/index.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../apps/single-workspace/src/project-resource-profiles.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/dist/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
  ExecutionId,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  type RuntimeSafetyPolicy,
  runExecution,
} from "../../packages/execution-runtime/src/index.js";
import {
  type CanonicalProviderEvent,
  type ProviderFailureKind,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkReadmissionGateStore,
} from "../../packages/ports/src/index.js";
import { currentSchema44Factory } from "./schema44-factory.js";

export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
export const scenarioExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const actor = parse(Actor)("user:test");
export const principal = parse(Principal)("user:test");
export const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

export const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

export const projectPayload = (
  resourceSelection: CreateProjectPayload["rootWorkspace"]["resourceSelection"],
): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: workspaceId,
  primarySession: {
    sessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: definition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceSelection,
    agentBinding: responsibilityBound(workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

export const workPayload: AssignWorkPayload = {
  workId,
  workspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P12-008",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

export const commandId = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`);

export const p1Authority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  id: CommandId,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal,
    commandId: id,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId,
      actor,
      schemaVersion: tag === "CreateProjectAuthority" ? "2" : "1",
      payload,
    }),
    projectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: workspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

export const envelope = <P>(
  commandType: string,
  payload: P,
  id: CommandId,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: id,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

export const waitTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>> = [
  [
    {
      _tag: "ToolCallProposed",
      callRef: "c1",
      toolName: "wait",
      argumentsJson: JSON.stringify({
        reason: "wait for a wake",
        waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
      }),
    },
    { _tag: "TurnCompleted", finishReason: "ToolCall" },
  ],
];

export const toolTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>> = [
  [
    {
      _tag: "ToolCallProposed",
      callRef: "c1",
      toolName: "read",
      argumentsJson: JSON.stringify({
        target: { mount: "workspace", path: "." },
      }),
    },
    { _tag: "TurnCompleted", finishReason: "ToolCall" },
  ],
];

interface ScenarioResult {
  readonly settlementTag: string;
  readonly settlementReason: string | null;
  readonly settlementKind: string | null;
  readonly workLifecycle: string | null;
  readonly settledEventPayload: string;
  readonly agentExecutionEpisodeJson: string | null;
  readonly readmissionHold: unknown;
  readonly runtimeFailure?: unknown;
}

export const runScenario = async (
  safetyPolicy: RuntimeSafetyPolicy,
  providerTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>,
  providerFailures?: ReadonlyArray<ProviderFailureKind>,
  initialEpisodeJson?: string,
  leaseOccupied = false,
): Promise<ScenarioResult> => {
  const dir = mkdtempSync(join(tmpdir(), "p12-safety-"));
  const projectResourceProfiles = makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment({ ARBOR_PROJECT_ROOT: dir }),
  );
  const profile = Effect.runSync(projectResourceProfiles.list())[0];
  if (profile === undefined || !profile.available) {
    throw new Error("P12 runtime-safety Project Profile must be available");
  }
  const resolvedProfile = Effect.runSync(
    projectResourceProfiles.resolve(
      profile.resourceProfileRef,
      profile.version,
    ),
  );
  if (Option.isNone(resolvedProfile)) {
    throw new Error("P12 runtime-safety Project Profile did not resolve");
  }
  const canonicalRoot = resolvedProfile.value.canonicalAddress.path;
  expect(canonicalRoot).toBe(realpathSync(dir));
  const selectedProjectPayload = projectPayload({
    _tag: "Profile",
    resourceProfileRef: profile.resourceProfileRef,
    version: profile.version,
  });
  const database = currentSchema44Factory().create();
  const app = buildSingleWorkspaceLayer({
    databaseFile: database.databaseFilename,
    providerTurns,
    ...(providerFailures !== undefined ? { providerFailures } : {}),
    runtimeSafetyPolicy: safetyPolicy,
    projectResourceProfiles,
  });
  try {
    return await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const gateway = yield* CommandGateway;
          yield* gateway.execute(
            envelope("CreateProject", selectedProjectPayload, commandId("1")),
            context,
            p1Authority(
              "CreateProjectAuthority",
              selectedProjectPayload,
              commandId("1"),
            ),
          );
          yield* gateway.execute(
            envelope("AssignWork", workPayload, commandId("2")),
            context,
            p1Authority("AssignWorkAuthority", workPayload, commandId("2")),
          );
          const ownership = yield* ResourceOwnershipRepository;
          const tx0 = yield* TransactionPort;
          yield* tx0.transact(
            ownership.insertClaim({
              claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
              workspaceId,
              region: {
                resourceSpaceId: "filesystem",
                normalizedRegion: { kind: "FileTree", path: canonicalRoot },
              },
              sourceAddressSnapshot: {
                _tag: "FileTree",
                path: canonicalRoot,
              },
              resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
              resolvedAtEnvironmentRevision: "local",
              createdAt: "t",
              releasedAt: null,
            }),
          );
          yield* evaluateAndSelect(workspaceId, principal, {
            _tag: "WorkSelected",
          });
          yield* admitExecution(
            workspaceId,
            scenarioExecutionId,
            { _tag: "Work", workId },
            principal,
          );
          const sql = yield* SqlClient;
          if (leaseOccupied) {
            yield* sql.unsafe(
              `INSERT INTO execution_leases (
              execution_id, worker_id, worker_incarnation_id, generation,
              expires_at, updated_at
            ) VALUES (?, 'worker:other', 'wic_other', 9, '2999-01-01T00:00:00.000Z', 'seed')`,
              [scenarioExecutionId],
            );
          }
          if (initialEpisodeJson !== undefined || leaseOccupied) {
            if (initialEpisodeJson !== undefined) {
              yield* sql.unsafe(
                `INSERT INTO agent_execution_state (
              execution_id, episode_json, wake_reason, current_mode,
              active_skill_refs_json, turn_no, recent_directive_refs_json,
              recent_action_fingerprints_json, updated_at
            ) VALUES (?, ?, 'WorkSelected', NULL, '[]', 0, '[]', '[]', 'seed')`,
                [scenarioExecutionId, initialEpisodeJson],
              );
            }
            const runOutcome = yield* Effect.match(
              runExecution(
                scenarioExecutionId,
                { _tag: "WorkSelected" },
                principal,
              ),
              {
                onFailure: (error) => ({ _tag: "Failure" as const, error }),
                onSuccess: (result) => ({ _tag: "Success" as const, result }),
              },
            );
            const states = yield* sql.unsafe<{ episode_json: string }>(
              "SELECT episode_json FROM agent_execution_state WHERE execution_id = ?",
              [scenarioExecutionId],
            );
            return {
              settlementTag: "NotSettled",
              settlementReason: null,
              settlementKind: null,
              workLifecycle: "Open",
              settledEventPayload: "",
              agentExecutionEpisodeJson: states[0]?.episode_json ?? null,
              readmissionHold: null,
              runtimeFailure:
                runOutcome._tag === "Failure" ? runOutcome.error : null,
            };
          }
          const settled = yield* runExecution(
            scenarioExecutionId,
            { _tag: "WorkSelected" },
            principal,
          );

          const executions = yield* sql.unsafe<{
            settlement_kind: string | null;
            settlement_json: string | null;
          }>(
            "SELECT settlement_kind, settlement_json FROM executions WHERE execution_id = ?",
            [scenarioExecutionId],
          );
          const works = yield* sql.unsafe<{ lifecycle: string }>(
            "SELECT lifecycle FROM works WHERE work_id = ?",
            [workId],
          );
          const events = yield* sql.unsafe<{ payload_json: string }>(
            "SELECT payload_json FROM domain_events WHERE event_type = 'ExecutionSettled'",
          );
          const agentStates = yield* sql.unsafe<{
            episode_json: string;
          }>(
            "SELECT episode_json FROM agent_execution_state WHERE execution_id = ?",
            [scenarioExecutionId],
          );
          const readmissionGate = yield* WorkReadmissionGateStore;
          const readmissionHold = yield* tx0.transact(
            readmissionGate.hasBlockingSource({
              projectId,
              workspaceId,
              workId,
              workRevision: parse(WorkRevision)(0),
            }),
          );
          const settlement =
            settled._tag === "Interrupted"
              ? settled.result._tag === "ControlledInterruption"
                ? settled.result.reason
                : null
              : null;
          return {
            settlementTag: settled._tag,
            settlementReason: settlement,
            settlementKind: executions[0]?.settlement_kind ?? null,
            workLifecycle: works[0]?.lifecycle ?? null,
            settledEventPayload: events[0]?.payload_json ?? "",
            agentExecutionEpisodeJson: agentStates[0]?.episode_json ?? null,
            readmissionHold: Option.isSome(readmissionHold)
              ? readmissionHold.value
              : null,
          };
        }),
        app,
      ) as unknown as Effect.Effect<ScenarioResult, unknown, never>,
    );
  } finally {
    database.cleanup();
  }
};
