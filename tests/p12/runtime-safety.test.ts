import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
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
import type { CanonicalProviderEvent } from "../../packages/ports/dist/index.js";
import {
  ResourceOwnershipRepository,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  type AttentionReadDeps,
  loadAttentionFacts,
} from "../../packages/projection-runtime/src/index.js";
import {
  createSchema44CaseDatabase,
  itWithCurrentAppTimeout,
} from "./support.js";

// ---------------------------------------------------------------------------
// story 9 (`08`): every §8.16A dimension -> Interrupted(RuntimeSafetyStop), Work Open
// ---------------------------------------------------------------------------

const safetyProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const safetyWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const safetySessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const safetyWorkId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const safetyExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const safetyPrincipal = parse(Principal)("user:test");
const safetyActor = parse(Actor)("user:test");
const safetyContext: CommandSubmissionContext = {
  _tag: "System",
  principal: safetyPrincipal,
  causationRef: "c",
};

const safetyDefinition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const safetyProjectPayload = (
  resourceSelection: CreateProjectPayload["rootWorkspace"]["resourceSelection"],
): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: safetyWorkspaceId,
  primarySession: {
    sessionId: safetySessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: safetyDefinition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceSelection,
    agentBinding: responsibilityBound(safetyWorkspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const safetyWorkPayload: AssignWorkPayload = {
  workId: safetyWorkId,
  workspaceId: safetyWorkspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P12-013",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

const safetyCommandId = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`);

const safetyAuthority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  suffix: string,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal: safetyPrincipal,
    commandId: safetyCommandId(suffix),
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId: safetyProjectId,
      actor: safetyActor,
      schemaVersion: tag === "CreateProjectAuthority" ? "2" : "1",
      payload,
    }),
    projectId: safetyProjectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: safetyWorkspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

const safetyEnvelope = <P>(
  commandType: string,
  payload: P,
  suffix: string,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: safetyCommandId(suffix),
  projectId: safetyProjectId,
  actor: safetyActor,
  issuedAt: "t",
  payload,
});

const safetyPolicy = (
  overrides: Partial<RuntimeSafetyPolicy> = {},
): RuntimeSafetyPolicy => ({
  maxRetries: 100,
  maxRepeatedFingerprints: 100,
  maxRecursionDepth: 100,
  maxNoProgressTurns: 100,
  concurrencyCeiling: 100,
  rateLimit: 100,
  rateWindowMs: 1000,
  ...overrides,
});

const claimTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>> = [
  [
    {
      _tag: "ToolCallProposed",
      callRef: "c1",
      toolName: "wait",
      argumentsJson: JSON.stringify({
        reason: "secret-store sentinel completion",
        waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
      }),
    },
    { _tag: "TurnCompleted", finishReason: "ToolCall" },
  ],
];

const toolTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>> = [
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

interface SafetyScenario {
  readonly settlementTag: string;
  readonly settlementReason: string | null;
  readonly workLifecycle: string | null;
}

const runSafetyScenario = async (
  safetyPolicyConfig: RuntimeSafetyPolicy,
  providerTurns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>,
): Promise<SafetyScenario> => {
  const dir = mkdtempSync(join(tmpdir(), "p12-acceptance-safety-"));
  const projectResourceProfiles = makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment({ ARBOR_PROJECT_ROOT: dir }),
  );
  const profile = Effect.runSync(projectResourceProfiles.list())[0];
  if (profile === undefined || !profile.available) {
    throw new Error("P12 acceptance Project Profile must be available");
  }
  const resolvedProfile = Effect.runSync(
    projectResourceProfiles.resolve(
      profile.resourceProfileRef,
      profile.version,
    ),
  );
  if (Option.isNone(resolvedProfile)) {
    throw new Error("P12 acceptance Project Profile did not resolve");
  }
  const canonicalRoot = resolvedProfile.value.canonicalAddress.path;
  expect(canonicalRoot).toBe(realpathSync(dir));
  const selectedSafetyProjectPayload = safetyProjectPayload({
    _tag: "Profile",
    resourceProfileRef: profile.resourceProfileRef,
    version: profile.version,
  });
  const database = createSchema44CaseDatabase();
  const app = buildSingleWorkspaceLayer({
    databaseFile: database.databaseFilename,
    providerTurns,
    runtimeSafetyPolicy: safetyPolicyConfig,
    projectResourceProfiles,
  });
  try {
    return await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const gateway = yield* CommandGateway;
          const created = yield* gateway.execute(
            safetyEnvelope("CreateProject", selectedSafetyProjectPayload, "1"),
            safetyContext,
            safetyAuthority(
              "CreateProjectAuthority",
              selectedSafetyProjectPayload,
              "1",
            ),
          );
          if (created.resolution._tag !== "Committed") {
            throw new Error(
              `CreateProject: ${JSON.stringify(created.resolution)}`,
            );
          }
          const assigned = yield* gateway.execute(
            safetyEnvelope("AssignWork", safetyWorkPayload, "2"),
            safetyContext,
            safetyAuthority("AssignWorkAuthority", safetyWorkPayload, "2"),
          );
          if (assigned.resolution._tag !== "Committed") {
            throw new Error(
              `AssignWork: ${JSON.stringify(assigned.resolution)}`,
            );
          }
          const ownership = yield* ResourceOwnershipRepository;
          const tx0 = yield* TransactionPort;
          yield* tx0.transact(
            ownership.insertClaim({
              claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
              workspaceId: safetyWorkspaceId,
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
          yield* evaluateAndSelect(safetyWorkspaceId, safetyPrincipal, {
            _tag: "WorkSelected",
          });
          yield* admitExecution(
            safetyWorkspaceId,
            safetyExecutionId,
            { _tag: "Work", workId: safetyWorkId },
            safetyPrincipal,
          );
          const settled = yield* runExecution(
            safetyExecutionId,
            { _tag: "WorkSelected" },
            safetyPrincipal,
          );
          const sql = yield* SqlClient;
          const works = yield* sql.unsafe<{ lifecycle: string }>(
            "SELECT lifecycle FROM works WHERE work_id = ?",
            [safetyWorkId],
          );
          const reason =
            settled._tag === "Interrupted" &&
            settled.result._tag === "ControlledInterruption"
              ? settled.result.reason
              : null;
          return {
            settlementTag: settled._tag,
            settlementReason: reason,
            workLifecycle: works[0]?.lifecycle ?? null,
          };
        }),
        app,
      ) as unknown as Effect.Effect<SafetyScenario, unknown, never>,
    );
  } finally {
    database.cleanup();
  }
};

describe("p12-acceptance story 9 — §8.16A six dimensions", () => {
  const cases: ReadonlyArray<{
    readonly dim: string;
    readonly safetyPolicy: RuntimeSafetyPolicy;
    readonly turns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  }> = [
    {
      dim: "D1",
      safetyPolicy: safetyPolicy({ maxRetries: 0 }),
      turns: claimTurns,
    },
    {
      dim: "D2",
      safetyPolicy: safetyPolicy({ maxRepeatedFingerprints: 0 }),
      turns: claimTurns,
    },
    {
      dim: "D3",
      safetyPolicy: safetyPolicy({ maxRecursionDepth: 0 }),
      turns: toolTurns,
    },
    {
      dim: "D4",
      safetyPolicy: safetyPolicy({ maxNoProgressTurns: 0 }),
      turns: claimTurns,
    },
    {
      dim: "D5",
      safetyPolicy: safetyPolicy({ concurrencyCeiling: 0 }),
      turns: claimTurns,
    },
    {
      dim: "D6",
      safetyPolicy: safetyPolicy({ rateLimit: 0 }),
      turns: claimTurns,
    },
  ];

  for (const testCase of cases) {
    itWithCurrentAppTimeout(
      `story 9 ${testCase.dim}: a violation interrupts with RuntimeSafetyStop and Work remains Open`,
      async () => {
        const result = await runSafetyScenario(
          testCase.safetyPolicy,
          testCase.turns,
        );
        expect(result.settlementTag).toBe("Interrupted");
        expect(result.settlementReason).toBe("RuntimeSafetyStop");
        expect(result.workLifecycle).toBe("Open");
      },
    );
  }

  it("story 9: the RuntimeSafetyStop settlement is derived as an Attention fact", async () => {
    const deps: AttentionReadDeps = {
      listWorkspacesByProject: () => Effect.succeed([]),
      listWorksByWorkspace: () => Effect.succeed([]),
      listExecutionSettlementFacts: () =>
        Effect.succeed([
          {
            executionId: safetyExecutionId,
            workspaceId: safetyWorkspaceId,
            settlement: {
              _tag: "Interrupted",
              result: {
                _tag: "ControlledInterruption",
                reason: "RuntimeSafetyStop",
              },
            },
            settledAt: "t",
          },
        ]),
      listAttentionSourceExecutionBindings: (targetProjectId, executionIds) =>
        Effect.succeed(
          executionIds.map((executionId) => ({
            executionId,
            projectId: targetProjectId,
            workspaceId: safetyWorkspaceId,
            episodeJson: JSON.stringify({
              _tag: "WorkEpisode",
              workId: safetyWorkId,
              targetWorkRevision: 0,
            }),
            workId: safetyWorkId,
            workProjectId: targetProjectId,
            workWorkspaceId: safetyWorkspaceId,
            workRevision: 0,
          })),
        ),
      listOpenVerifications: () => Effect.succeed([]),
      listUnsatisfiedDependencies: () => Effect.succeed([]),
      findDependency: () => Effect.succeed(Option.none()),
      readEvents: () => Effect.succeed([]),
    };
    const facts = await Effect.runPromise(
      loadAttentionFacts(safetyProjectId, deps),
    );
    expect(facts.safetyStopSettlements).toHaveLength(1);
  });
});
