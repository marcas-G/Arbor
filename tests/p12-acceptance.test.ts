import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { EnvironmentResolverLocalLive } from "../adapters/environment-resolver-local/src/index.js";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  LeaseServiceLive,
  layer,
  P11_MIGRATIONS,
  P12_MIGRATIONS,
  PermissionGrantRepositoryLive,
  ProjectRepositoryLive,
  ProjectToolRegistryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type OpenAISdkChunk,
  type OpenAISdkClient,
  OpenAISdkError,
} from "../adapters/provider-openai/src/index.js";
import {
  SANDBOX_ENV_ALLOWLIST,
  sandboxEnvironment,
} from "../adapters/sandbox-local/dist/index.js";
import { SecretEnvLive } from "../adapters/secret-env/dist/index.js";
import { selectProviderLayer } from "../apps/single-workspace/src/composition.js";
import {
  admitExecution,
  buildSliceLayer,
  evaluateAndSelect,
} from "../apps/single-workspace/src/index.js";
import { SliceCommandHandlerRegistryLive } from "../apps/single-workspace/src/registry.js";
import { runRestoreDrill } from "../apps/single-workspace/src/restore-drill.js";
import {
  isViewId,
  makeCliShell,
  makeConsumerLoopDaemon,
  makeDriftWatcherTrigger,
  makeExternalSubmissionFromServices,
  makeHttpShell,
  makeProductionDaemon,
  makeRecoveryDaemon,
  makeStaticAuthenticator,
  makeTransportCore,
  makeWebShell,
  makeWebSocketShell,
  recoveryDaemonFromPrincipal,
  SEARCH_TRANSPORT_BINDING,
  type ViewQueryFace,
} from "../apps/single-workspace/src/transport/index.js";
import type {
  TreeViewRes,
  ViewRequestMap,
  ViewResponseMap,
} from "../packages/api-contracts/src/index.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  CommandGatewayLive,
  type CommandHandlerRegistry,
  type ConsumerLoopResult,
  type CreateProjectPayload,
  type DriftReport,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/dist/index.js";
import { validateCommandAuthority } from "../packages/application/src/authority.js";
import {
  type AuthorityDecisionInput,
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../packages/application/src/authority-resolver.js";
import { makeRegisterProjectToolHandler } from "../packages/application/src/commands/register-project-tool.js";
import {
  assertRestoreIsolation,
  DEFAULT_DURABILITY_ENVELOPE,
  parseDuration,
  type RestoreDrillArtifact,
  reconcileRestoredLeases,
  withinDurabilityEnvelope,
} from "../packages/application/src/durability.js";
import { evaluateEnvironmentImpact } from "../packages/application/src/environment-impact.js";
import { verificationFreshness } from "../packages/application/src/environment-staleness.js";
import {
  RemoteWorkerMediationPort,
  RemoteWorkerMediationPortLive,
} from "../packages/application/src/index.js";
import {
  assessStorage,
  ENVELOPE_DIMENSIONS,
  type Measurement,
  type OperatingEnvelope,
  validateStorageScaleAssessment,
} from "../packages/application/src/storage-assessment.js";
import {
  Actor,
  type CanonicalResourceRegion,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
  canonicalRegionString,
  checkPluginSdkCompatibility,
  type Execution,
  ExecutionId,
  makeProjectPolicy,
  makeWorkspacePolicy,
  PermissionGrantId,
  PluginId,
  PluginSdkApiVersion,
  PluginVersion,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  type QueryResult,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SemanticRequestFingerprint,
  SessionId,
  ToolInvocationId,
  VIEW_IDS,
  type ViewId,
  WorkerId,
  WorkerIncarnationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
  type RuntimeSafetyPolicy,
  runExecution,
} from "../packages/execution-runtime/src/index.js";
import {
  type ContextFragment,
  canRaiseAuthority,
  contextFragment,
  DEFAULT_MODEL_CATALOG,
  type InstructionFragment,
  ModelContext,
  ModelContextLive,
  planContext,
  resolveModelCapability,
  resolveModelCatalogEntry,
  WORK_EXECUTION_PROGRAM,
} from "../packages/model-context/src/index.js";
import {
  type CanonicalProviderEvent,
  type PortableModelRequest,
  PROVIDER_FAILURE_KINDS,
  type ProviderExecutionContext,
  type ProviderFailure,
  ProviderPort,
  providerFailureDisposition,
  type SecretMaterial,
  type SecretStoreError,
  SecretStorePort,
  secretRef,
} from "../packages/ports/dist/index.js";
import type { ProjectionStale } from "../packages/ports/src/errors.js";
import {
  Clock,
  type CommandStore,
  type DomainEventJournal,
  EnvironmentResolverPort,
  type ExecutionOriginMutation,
  ExecutionRepository,
  HealthPort,
  type IdGenerator,
  type InformationTrustMetadata,
  LeaseService,
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  P12_MIGRATION_BASELINE,
  PermissionGrantRepository,
  PersistenceHealthProbe,
  type PersistenceHealthProbeService,
  ProjectEnvironmentPort,
  type ProjectRepository,
  ProjectToolRegistry,
  type ReadinessState,
  ResourceAdmission,
  ResourceOwnershipRepository,
  SandboxPort,
  type SessionRepository,
  SkillRegistry,
  type ToolCatalogError,
  ToolCatalogPort,
  type ToolDefinition,
  type ToolDefinitionRef,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
  type WorkRepository,
  type WorkspaceRepository,
  type WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  type AttentionReadDeps,
  deriveUsage,
  HealthPortLive,
  isReady,
  loadAttentionFacts,
  type UsageFacts,
  UsageService,
  UsageServiceLive,
} from "../packages/projection-runtime/src/index.js";
import {
  BUILTIN_EXECUTORS,
  BUILTIN_TOOLS,
  ToolCatalogPortLive,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "../packages/tool-runtime/src/index.js";

// P12-013 acceptance: the `14` §1 end-to-end story across contracts `01`–`10`,
// `12`, `13`. Mechanical evidence only; the per-contract suites carry the
// depth, this suite proves the production/extensibility plane is reachable
// end-to-end.

const repoRoot = join(import.meta.dirname, "..");
const readRepoFile = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

const suiteTmp = mkdtempSync(join(tmpdir(), "p12-acceptance-"));
afterAll(() => {
  rmSync(suiteTmp, { recursive: true, force: true });
});

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const PLUGIN = parse(PluginId)("plg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const VERSION = parse(PluginVersion)("1.0.0");
const HUMAN = parse(Principal)("user:governance");
const ACTOR = parse(Actor)("agent:worker");
const ISSUED_AT = "2026-09-22T00:00:00.000Z";

const ECHO_DEFINITION: ToolDefinition = {
  name: "project-echo",
  version: "1",
  hash: "project-echo-v1",
  description: "project-supplied echo tool",
  inputSchemaJson: JSON.stringify({
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: ["project:echo"],
  sideEffectSemantics: "ReadOnly",
  source: "Project",
};

// ---------------------------------------------------------------------------
// story 1–2 (`01` + `07`): plugin registration + explicit project-tool trust
// ---------------------------------------------------------------------------

type PluginServices =
  | SqlClient
  | TransactionPort
  | ProjectToolRegistry
  | ToolCatalogPort;

const pluginApp = (): Layer.Layer<PluginServices> => {
  const base = layer({ filename: ":memory:" });
  const registry = Layer.provide(ProjectToolRegistryLive, base);
  const catalog = Layer.provide(
    ToolCatalogPortLive({ projectId: PROJECT }),
    registry,
  );
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    registry,
    catalog,
  ) as Layer.Layer<PluginServices>;
};

const runPlugin = <A>(
  program: Effect.Effect<A, unknown, PluginServices>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, pluginApp())));

describe("p12-acceptance story 1-2 — plugin SDK + explicit project-tool registration", () => {
  it("story 1-2: registered plugin/project tool is content/version-bound; unregistered tool is not visible or invocable", async () => {
    const ref: ToolDefinitionRef = {
      name: ECHO_DEFINITION.name,
      version: ECHO_DEFINITION.version,
      hash: ECHO_DEFINITION.hash,
    };

    const mismatch = checkPluginSdkCompatibility(
      parse(PluginSdkApiVersion)("2.0.0"),
      parse(PluginSdkApiVersion)("1.4.0"),
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error._tag).toBe("PluginCompatibilityError");
    }

    await runPlugin(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const registry = yield* ProjectToolRegistry;
        const catalog = yield* ToolCatalogPort;

        // story 2: unregistered -> absent from the model-facing catalog
        const before = yield* catalog.visibleRefs();
        expect(
          before.some((candidate) => candidate.name === ECHO_DEFINITION.name),
        ).toBe(false);
        const unresolved = (yield* Effect.flip(
          catalog.resolveForModel(ref),
        )) as ToolCatalogError;
        expect(unresolved._tag).toBe("ToolNotRegistered");
        expect(
          Option.isNone(
            yield* tx.transact(
              registry.lookup({
                projectId: PROJECT,
                pluginId: PLUGIN,
                pluginVersion: VERSION,
                contentHash: "plugin-content-hash",
              }),
            ),
          ),
        ).toBe(true);

        // story 1: explicit, content/version-bound registration
        yield* tx.transact(
          registry.register({
            projectId: PROJECT,
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            contentHash: "plugin-content-hash",
            definitions: [ECHO_DEFINITION],
          }),
        );

        const after = yield* catalog.visibleRefs();
        expect(
          after.some((candidate) => candidate.name === ECHO_DEFINITION.name),
        ).toBe(true);
        const resolved: ModelFacingToolDefinition =
          yield* catalog.resolveForModel(ref);
        expect(resolved.description).toBe(ECHO_DEFINITION.description);
        expect(resolved.schemaJson).toBe(ECHO_DEFINITION.inputSchemaJson);
        expect(resolved.version).toBe(ECHO_DEFINITION.version);
        expect(resolved.schemaJson).not.toBe("{}");

        // a registered project tool stays authority-gated (exact identity)
        const handler = makeRegisterProjectToolHandler({ registry });
        const command = parse(CommandId)(
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
        );
        const fingerprint = parse(SemanticRequestFingerprint)("fp-story-1");
        const authority = {
          _tag: "RegisterProjectToolAuthority" as const,
          principal: HUMAN,
          commandId: command,
          semanticRequestFingerprint: fingerprint,
          projectId: PROJECT,
          pluginId: PLUGIN,
          pluginVersion: VERSION,
          contentHash: "plugin-content-hash",
        };
        const facts = {
          principal: HUMAN,
          commandId: command,
          projectId: PROJECT,
          semanticRequestFingerprint: fingerprint,
          submissionOrigin: "External",
          payload: {
            pluginId: PLUGIN,
            pluginVersion: VERSION,
            definitions: [ECHO_DEFINITION],
            contentHash: "plugin-content-hash",
          },
        };
        expect(
          Option.isNone(
            validateCommandAuthority(authority, handler.authority, facts),
          ),
        ).toBe(true);
        expect(
          Option.isSome(
            validateCommandAuthority(
              { ...authority, contentHash: "other-hash" },
              handler.authority,
              facts,
            ),
          ),
        ).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// story 3 (`02`): Authority Resolver produces trusted facts; no canonical write
// ---------------------------------------------------------------------------

type AuthorityServices =
  | SqlClient
  | TransactionPort
  | PermissionGrantRepository
  | AuthorityResolverPort;

const authorityApp = (): Layer.Layer<AuthorityServices> => {
  const base = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(PermissionGrantRepositoryLive, base),
    AuthorityResolverPortLive,
  ) as Layer.Layer<AuthorityServices>;
};

const runAuthority = <A>(
  program: Effect.Effect<A, unknown, AuthorityServices>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, authorityApp())));

describe("p12-acceptance story 3 — Authority Resolver production plane", () => {
  it("story 3: External Stop resolves to a trusted fact without mutating canonical state", async () => {
    const executionId = parse(ExecutionId)(
      "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const workspaceId = parse(WorkspaceId)(
      "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
    );
    const grantId = parse(PermissionGrantId)(
      "pgr_018f2b3c-4d5e-7abc-8def-0123456789e1",
    );

    const outcome = await runAuthority(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const grants = yield* PermissionGrantRepository;
        const resolver = yield* AuthorityResolverPort;

        const eventsBefore = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events",
        );

        yield* tx.transact(
          grants.put(
            {
              permissionGrantId: grantId,
              scope: `StopExecution@${executionId}`,
              issuer: HUMAN,
              lifetime: "PT1H",
              state: "Active",
            },
            PROJECT,
          ),
        );
        const activeGrants = yield* tx.transact(grants.activeGrants(PROJECT));
        expect(activeGrants).toHaveLength(1);

        const input: AuthorityDecisionInput = {
          principal: HUMAN,
          submissionContext: { _tag: "External", principal: HUMAN },
          envelope: {
            commandType: "StopExecution",
            commandId,
            projectId: PROJECT,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: { executionId },
          },
          semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
            "fp-story-3",
          ),
          canonicalFacts: {
            projectId: PROJECT,
            execution: { executionId, projectId: PROJECT, workspaceId },
          },
          grants: activeGrants,
          governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
          policy: makeProjectPolicy({}),
        };
        const fact = yield* resolver.resolve(input);

        const eventsAfter = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events",
        );
        return {
          fact,
          eventsBefore: Number(eventsBefore[0]?.count ?? 0),
          eventsAfter: Number(eventsAfter[0]?.count ?? 0),
        };
      }),
    );

    expect(outcome.fact._tag).toBe("StopExecutionAuthority");
    if (outcome.fact._tag === "StopExecutionAuthority") {
      expect(outcome.fact.submissionOrigin).toBe("External");
      expect(outcome.fact.executionId).toBe(executionId);
    }
    expect(outcome.eventsAfter).toBe(outcome.eventsBefore);

    const source = readRepoFile(
      "packages/application/src/authority-resolver.ts",
    );
    for (const forbidden of [
      "CommandGateway",
      ".transact",
      "consumeApproval",
      ".invoke(",
      ".put(",
      ".revoke(",
      ".register(",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// story 4 (`03`): SecretStorePort resolves a SecretRef; no material leaks
// ---------------------------------------------------------------------------

const secretProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const secretWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const secretSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const secretWorkId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const secretPrincipal = parse(Principal)("user:test");
const secretContext: CommandSubmissionContext = {
  _tag: "System",
  principal: secretPrincipal,
  causationRef: "c",
};
const secretDefinition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
const secretProjectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: secretWorkspaceId,
  primarySession: {
    sessionId: secretSessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: secretDefinition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: "." }],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(secretWorkspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});
const secretWorkPayload = (): AssignWorkPayload => ({
  workId: secretWorkId,
  workspaceId: secretWorkspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P12-013",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
});
const secretEnvelope = <P>(
  commandType: string,
  payload: P,
  suffix: string,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`,
  ),
  projectId: secretProjectId,
  actor: parse(Actor)("user:test"),
  issuedAt: "t",
  payload,
});
const secretAuthority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  suffix: string,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal: secretPrincipal,
    commandId: parse(CommandId)(
      `cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`,
    ),
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId: secretProjectId,
      actor: parse(Actor)("user:test"),
      schemaVersion: "1",
      payload,
    }),
    projectId: secretProjectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: secretWorkspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

describe("p12-acceptance story 4 — secret store + no-leak invariant", () => {
  it("story 4: a resolved SecretRef is redacted and never reaches any durable/observable surface", async () => {
    const store = SecretEnvLive({
      ambient: { PROVIDER_KEY: "env-secret", OLD_KEY: "stale" },
      expiries: { OLD_KEY: "2000-01-01T00:00:00.000Z" },
    });
    const adapter = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const port = yield* SecretStorePort;
          const ok = yield* port.resolve(secretRef("PROVIDER_KEY"));
          const missing = yield* Effect.flip(port.resolve(secretRef("ABSENT")));
          const expired = yield* Effect.flip(
            port.resolve(secretRef("OLD_KEY")),
          );
          return { ok, missing, expired };
        }),
        store,
      ) as Effect.Effect<
        {
          ok: SecretMaterial;
          missing: SecretStoreError;
          expired: SecretStoreError;
        },
        unknown,
        never
      >,
    );
    expect(adapter.ok.reveal()).toBe("env-secret");
    expect(JSON.stringify({ material: adapter.ok })).toBe(
      '{"material":"[REDACTED]"}',
    );
    expect(String(adapter.ok)).toBe("[REDACTED]");
    expect(adapter.missing._tag).toBe("SecretNotFound");
    expect(adapter.expired._tag).toBe("SecretExpired");

    const sentinelKey = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const projected = sandboxEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      [sentinelKey]: "must-not-leak",
    });
    expect(sentinelKey in projected).toBe(false);
    expect(
      Object.keys(projected).every((key) =>
        SANDBOX_ENV_ALLOWLIST.includes(key),
      ),
    ).toBe(true);

    // end-to-end: a sentinel secret resolved during a real slice run never
    // appears in any SQLite table or stdout/stderr
    const sentinelEnv = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const sentinelValue = `sentinel-value-${randomUUID()}`;
    process.env[sentinelEnv] = sentinelValue;
    const dir = mkdtempSync(join(tmpdir(), "p12-acceptance-secret-"));
    const app = buildSliceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: [
        [
          {
            _tag: "ToolCallProposed",
            callRef: "c1",
            toolName: "arbor_directive",
            argumentsJson: JSON.stringify({
              _tag: "CompletionClaim",
              claim: { claimRef: "claim-1", workRevision: 0 },
            }),
          },
          { _tag: "TurnCompleted", finishReason: "ToolCall" },
        ],
      ],
      secretRef: secretRef(sentinelEnv),
    });

    const captured: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const capture =
      (orig: typeof origOut) =>
      (chunk: unknown, ...args: ReadonlyArray<unknown>) => {
        captured.push(typeof chunk === "string" ? chunk : String(chunk));
        return (orig as (...a: ReadonlyArray<unknown>) => boolean)(
          chunk,
          ...args,
        );
      };
    process.stdout.write = capture(origOut) as typeof process.stdout.write;
    process.stderr.write = capture(origErr) as typeof process.stderr.write;

    let allRows = "";
    let settlement = "";
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P12_MIGRATIONS);
            const gateway = yield* CommandGateway;
            yield* gateway.execute(
              secretEnvelope("CreateProject", secretProjectPayload(), "1"),
              secretContext,
              secretAuthority(
                "CreateProjectAuthority",
                secretProjectPayload(),
                "1",
              ),
            );
            yield* gateway.execute(
              secretEnvelope("AssignWork", secretWorkPayload(), "2"),
              secretContext,
              secretAuthority("AssignWorkAuthority", secretWorkPayload(), "2"),
            );
            const ownership = yield* ResourceOwnershipRepository;
            const tx0 = yield* TransactionPort;
            yield* tx0.transact(
              ownership.insertClaim({
                claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
                workspaceId: secretWorkspaceId,
                region: {
                  resourceSpaceId: "filesystem",
                  normalizedRegion: { kind: "FileTree", path: "." },
                },
                sourceAddressSnapshot: { _tag: "FileTree", path: "." },
                resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
                resolvedAtEnvironmentRevision: "local",
                createdAt: "t",
                releasedAt: null,
              }),
            );
            yield* evaluateAndSelect(secretWorkspaceId, secretPrincipal, {
              _tag: "WorkSelected",
            });
            yield* admitExecution(
              secretWorkspaceId,
              parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
              { _tag: "Work", workId: secretWorkId },
              secretPrincipal,
            );
            const settled = yield* runExecution(
              parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
              { _tag: "WorkSelected" },
              secretPrincipal,
            );
            const sql = yield* SqlClient;
            const tables = yield* sql.unsafe<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table'",
            );
            let dump = "";
            for (const table of tables) {
              if (table.name.startsWith("sqlite_")) {
                continue;
              }
              const rows = yield* sql.unsafe(`SELECT * FROM "${table.name}"`);
              dump += JSON.stringify(rows);
            }
            return { dump, settlement: settled._tag };
          }),
          app,
        ) as unknown as Effect.Effect<
          { dump: string; settlement: string },
          unknown,
          never
        >,
      );
      allRows = result.dump;
      settlement = result.settlement;
    } finally {
      process.stdout.write = origOut as typeof process.stdout.write;
      process.stderr.write = origErr as typeof process.stderr.write;
      delete process.env[sentinelEnv];
    }

    expect(settlement).toBe("Completed");
    expect(allRows).not.toContain(sentinelValue);
    expect(captured.join("")).not.toContain(sentinelValue);
    expect(captured.join("")).not.toContain(sentinelEnv);
  });
});

// ---------------------------------------------------------------------------
// story 5 (`04`): observable usage derived from real facts; unknown cost ≠ 0
// ---------------------------------------------------------------------------

describe("p12-acceptance story 5 — observability / health / usage plane", () => {
  it("story 5: usage is derived-only (unknown cost = Unknown) and readiness tracks the migration baseline", async () => {
    const facts: UsageFacts = {
      turns: [
        {
          providerTurnId: "ptn-1",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      ],
      attempts: [{ providerTurnId: "ptn-1", attemptNo: 1, outcome: "Success" }],
      toolInvocations: [{ invocationId: "inv-1", outcome: "Success" }],
      executions: [
        {
          executionId: "exe-1",
          admittedAt: "2026-09-22T00:00:00.000Z",
          settledAt: "2026-09-22T00:00:02.000Z",
        },
      ],
    };

    const serviceDerived = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* UsageService;
          return service.derive(facts);
        }),
        UsageServiceLive,
      ),
    );
    expect(serviceDerived.cost).toEqual({
      _tag: "Unknown",
      reason: "PricingUnavailable",
    });
    expect(serviceDerived).toEqual(deriveUsage(facts));

    const known = deriveUsage({
      ...facts,
      priceSheet: {
        version: "ps-2026-09",
        currency: "USD",
        unitPrices: { inputTokens: 2, outputTokens: 3 },
      },
    });
    expect(known.cost._tag).toBe("Known");
    if (known.cost._tag === "Known") {
      expect(known.cost.amount).toBe(100 * 2 + 50 * 3);
      expect(known.cost.priceSheetVersion).toBe("ps-2026-09");
    }

    expect(P12_MIGRATION_BASELINE).toBe(
      Math.max(...P12_MIGRATIONS.map((migration) => migration.id)),
    );
    const base = layer({ filename: ":memory:" });
    const probe = Layer.provide(
      Layer.effect(
        PersistenceHealthProbe,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return {
            probe: () =>
              sql.unsafe<{ user_version: number }>("PRAGMA user_version").pipe(
                Effect.map((rows) => ({
                  dbOpen: true,
                  migrationBaseline:
                    Number(rows[0]?.user_version ?? 0) ===
                    P12_MIGRATION_BASELINE,
                  t1RecoveryComplete: true,
                })),
                Effect.orDie,
              ),
          } satisfies PersistenceHealthProbeService;
        }),
      ),
      base,
    );
    const healthApp = Layer.mergeAll(
      base,
      probe,
      Layer.provide(HealthPortLive, probe),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const health = yield* HealthPort;
            const before: ReadinessState = yield* health.readiness();
            expect(isReady(before)).toBe(false);
            yield* runMigrations(P12_MIGRATIONS);
            const after: ReadinessState = yield* health.readiness();
            expect(isReady(after)).toBe(true);
          }),
          healthApp,
        ),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// story 6 (`05`): StorageScaleAssessment + DurabilityEnvelope + restore drill
// ---------------------------------------------------------------------------

describe("p12-acceptance story 6 — storage scale + durability envelope", () => {
  it("story 6: the checked-in assessment yields a verdict and the declared envelope holds", () => {
    const assessment = JSON.parse(
      readRepoFile("planning/results/P12.storage-assessment.json"),
    ) as {
      operatingEnvelope: OperatingEnvelope;
      measurements: ReadonlyArray<Measurement>;
      verdict: string;
    };
    expect(validateStorageScaleAssessment(assessment)).toEqual([]);
    expect(["SQLiteSufficient", "PostgreSQLRequired"]).toContain(
      assessment.verdict,
    );
    const covered = new Set(
      assessment.measurements.map((entry) => entry.dimension),
    );
    for (const dimension of ENVELOPE_DIMENSIONS) {
      expect(covered.has(dimension), dimension).toBe(true);
    }
    expect(
      assessStorage(assessment.operatingEnvelope, assessment.measurements)
        .verdict,
    ).toBe(assessment.verdict);
    expect(assessStorage(assessment.operatingEnvelope, []).verdict).toBe(
      "InsufficientEvidence",
    );

    const artifact = JSON.parse(
      readRepoFile("planning/results/P12.restore-drill.json"),
    ) as RestoreDrillArtifact;
    expect(artifact.migrationUserVersion).toBe(13);
    expect(
      withinDurabilityEnvelope(artifact, DEFAULT_DURABILITY_ENVELOPE),
    ).toBe(true);
    expect(
      parseDuration(artifact.measuredRto) <=
        parseDuration(DEFAULT_DURABILITY_ENVELOPE.declaredRto),
    ).toBe(true);
    expect(artifact.restoredDbHash.startsWith("sha256:")).toBe(true);

    expect(() =>
      assertRestoreIsolation("/db/canonical.db", "/db/canonical.db"),
    ).toThrow();
    const reconciliation = reconcileRestoredLeases([
      {
        executionId: "exe_1",
        workerId: "wkr_A",
        workerIncarnationId: "wic_A1",
        generation: 3,
      },
    ]);
    expect(reconciliation.invalidatedCount).toBe(1);
    expect(reconciliation.advancedGeneration).toBe(4);
  });

  it("story 6: the restore drill actually executes end-to-end and emits its artifact", async () => {
    const artifact = await runRestoreDrill();
    expect(artifact.migrationUserVersion).toBe(13);
    expect(
      withinDurabilityEnvelope(artifact, DEFAULT_DURABILITY_ENVELOPE),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// story 7 (`06`): remote worker fenced mutation; one transaction; no worker DB
// ---------------------------------------------------------------------------

const rwProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwWorkerA = parse(WorkerId)("wkr_018f2b3c-4d5e-7abc-8def-0123456789b1");
const rwInc1 = parse(WorkerIncarnationId)(
  "wic_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const rwInc2 = parse(WorkerIncarnationId)(
  "wic_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const rwActor = parse(Actor)("agent:remote-worker");

const rwExecution: Execution = {
  executionId: rwExecutionId,
  projectId: rwProjectId,
  workspaceId: rwWorkspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: rwWorkspaceId,
    focus: { _tag: "Coordination" },
  },
  sessionId: rwSessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const countingTransaction = (counter: {
  count: number;
}): Layer.Layer<TransactionPort, never, SqlClient> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = (statement: string) =>
        sql.unsafe(statement).pipe(
          Effect.mapError((cause) => ({
            _tag: "TransactionOperationalFailure" as const,
            cause,
          })),
        );
      const transact = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ) =>
        Effect.gen(function* () {
          counter.count += 1;
          const existing = yield* Effect.serviceOption(TransactionScope);
          if (Option.isSome(existing)) {
            return yield* Effect.fail({
              _tag: "TransactionOperationalFailure" as const,
              cause: "nested transaction rejected",
            });
          }
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (exit._tag === "Success") {
            yield* run("COMMIT");
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact } as never);
    }),
  );

const rwBuildApp = (dbFile: string, counter: { count: number }) => {
  const base = layer({ filename: dbFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const tx = Layer.provide(countingTransaction(counter), base);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const leases = Layer.provide(LeaseServiceLive, Layer.merge(infra, repo));
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  const commandStore = Layer.provide(CommandStoreLive, infra);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const sessions = Layer.provide(SessionRepositoryLive, infra);
  const workWaits = Layer.provide(WorkWaitStoreLive, infra);
  const projects = Layer.provide(ProjectRepositoryLive, infra);
  const workspaces = Layer.provide(WorkspaceRepositoryLive, infra);
  const registry = Layer.provide(
    P2CommandHandlerRegistryLive,
    Layer.mergeAll(projects, workspaces, sessions, repo, workWaits),
  );
  const gateway = Layer.provide(
    CommandGatewayLive,
    Layer.mergeAll(infra, registry, commandStore, journal, tx, fence),
  );
  const mediation = Layer.provide(
    RemoteWorkerMediationPortLive,
    Layer.mergeAll(gateway, registry, infra),
  );
  return Layer.mergeAll(
    base,
    infra,
    tx,
    repo,
    leases,
    fence,
    commandStore,
    journal,
    sessions,
    workWaits,
    projects,
    workspaces,
    registry,
    gateway,
    mediation,
  );
};

const rwSeed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          rwProjectId,
          "p",
          rwWorkspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [rwSessionId, "WorkspacePrimary", rwWorkspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          rwWorkspaceId,
          rwProjectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          rwSessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
    }),
  );
});

const rwMutation = (
  workerId: WorkerId,
  workerIncarnationId: WorkerIncarnationId,
  fencingGeneration: number,
): ExecutionOriginMutation => ({
  workerId,
  workerIncarnationId,
  executionId: rwExecutionId,
  fencingGeneration: fencingGeneration as never,
  envelope: {
    commandType: "SettleExecution",
    commandId: parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1"),
    projectId: rwProjectId,
    actor: rwActor,
    issuedAt: ISSUED_AT,
    payload: {
      executionId: rwExecutionId,
      settlement: {
        _tag: "Completed" as const,
        result: { _tag: "CoordinationCompleted" as const },
      },
      expectedFencingGeneration: 0,
    },
  },
});

const rwRun = <A>(
  body: (counter: { count: number }) => Effect.Effect<A, any, any>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "p12-acceptance-rw-"));
  const counter = { count: 0 };
  const app = rwBuildApp(join(dir, "worker.db"), counter);
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* rwSeed;
        const tx = yield* TransactionPort;
        const repo = yield* ExecutionRepository;
        yield* tx.transact(repo.tryAdmitMainExecution(rwExecution));
        return yield* body(counter);
      }),
      app,
    ) as Effect.Effect<A, unknown, never>,
  );
};

describe("p12-acceptance story 7 — remote worker fenced mediation", () => {
  it("story 7: a fenced mutation commits fence+mutate+event in one transaction; stale incarnations are rejected; no worker DB", async () => {
    // -- committed mutation: fence + mutate + resolve + event in one tx --
    const committed = await rwRun((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(rwExecutionId, rwWorkerA, rwInc1),
        );
        counter.count = 0;
        const receipt = yield* mediation.submit(
          { workerId: rwWorkerA, workerIncarnationId: rwInc1 },
          rwMutation(rwWorkerA, rwInc1, lease.generation),
        );
        const transacts = counter.count;
        const sql = yield* SqlClient;
        const events = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ExecutionSettled'",
        );
        const repo = yield* ExecutionRepository;
        const settled = yield* tx.transact(repo.findById(rwExecutionId));
        return {
          receipt,
          events: Number(events[0]?.count ?? 0),
          transacts,
          status: Option.getOrThrow(settled).state.status,
        };
      }),
    );
    expect(committed.receipt.resolution._tag).toBe("Committed");
    expect(committed.events).toBe(1);
    expect(committed.transacts).toBe(1);
    expect(committed.status).toBe("Settled");

    // -- stale incarnation: typed FencingRejected with no journal row --
    const stale = await rwRun((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(rwExecutionId, rwWorkerA, rwInc1),
        );
        counter.count = 0;
        const staleIncarnation = yield* mediation.submit(
          { workerId: rwWorkerA, workerIncarnationId: rwInc2 },
          rwMutation(rwWorkerA, rwInc2, lease.generation),
        );
        const staleGeneration = yield* mediation.submit(
          { workerId: rwWorkerA, workerIncarnationId: rwInc1 },
          rwMutation(rwWorkerA, rwInc1, Number(lease.generation) + 1),
        );
        const sql = yield* SqlClient;
        const events = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ExecutionSettled'",
        );
        return {
          staleIncarnation,
          staleGeneration,
          events: Number(events[0]?.count ?? 0),
        };
      }),
    );
    expect(stale.staleIncarnation.resolution).toEqual({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });
    expect(stale.staleGeneration.resolution).toEqual({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });
    expect(stale.events).toBe(0);

    const source = readRepoFile("adapters/worker-transport/src/index.ts");
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain("@arbor/persistence-sqlite");
    expect(importSpecifiers).not.toContain("effect/unstable/sql/SqlClient");
  });
});

// ---------------------------------------------------------------------------
// story 8 (`07`): model-facing ToolCatalogPort; compiled request carries real metadata
// ---------------------------------------------------------------------------

const story8Input = () => ({
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  contextEpoch: parse(ContextEpochNumber)(0),
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  binding: {
    _tag: "ResponsibilityBoundAgentBinding" as const,
    workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  },
  workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  cognitiveMode: "execute",
  program: WORK_EXECUTION_PROGRAM,
  fragments: [
    {
      identity: "work-objective",
      revision: 1,
      hash: "h",
      semanticKind: "K",
      source: "Canonical",
      scope: "work-objective",
      authorityRole: "A3",
      strength: "Hard",
      compositionMode: "Constrain",
      activationCondition: "always",
      lifetime: "Pinned",
      cacheClass: "Stable",
      budgetClass: "b",
      modelCompatibility: [],
      contentRef: "work-objective",
    } satisfies InstructionFragment,
  ],
  contextFragments: [] as ReadonlyArray<ContextFragment>,
  budget: {
    modelWindow: 4000,
    outputReserve: 512,
    protocolReserve: 100,
    toolReserve: 100,
  },
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "d",
    environmentRevision: "e",
  },
  maxOutputTokens: 128,
  bodySkillIds: [],
});

describe("p12-acceptance story 8 — model-facing tool catalog in the compiled request", () => {
  it("story 8: the compiled PortableModelRequest carries the real project tool metadata (no placeholder)", async () => {
    const base = layer({ filename: ":memory:" });
    const registry = Layer.provide(ProjectToolRegistryLive, base);
    const tx = Layer.provide(TransactionPortLive, base);
    const catalog = Layer.provide(
      ToolCatalogPortLive({ projectId: PROJECT }),
      registry,
    );
    const capability = Layer.succeed(ModelCapabilityPort, {
      resolve: () =>
        Effect.succeed({
          modelRef: "model-a",
          family: "family-a",
          contextWindow: 4000,
          outputCeiling: 512,
          toolProtocol: "json",
        }),
    });
    const skills = Layer.succeed(SkillRegistry, {
      available: () => Effect.succeed([]),
      load: () => Effect.die("no skills"),
    });
    const modelContext = Layer.provide(
      ModelContextLive,
      Layer.mergeAll(capability, skills, catalog),
    );
    const app = Layer.mergeAll(base, registry, tx, catalog, modelContext);

    const prepared = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P12_MIGRATIONS);
          const txPort = yield* TransactionPort;
          const reg = yield* ProjectToolRegistry;
          yield* txPort.transact(
            reg.register({
              projectId: PROJECT,
              pluginId: PLUGIN,
              pluginVersion: VERSION,
              contentHash: "story-8-content-hash",
              definitions: [ECHO_DEFINITION],
            }),
          );
          const modelContextPort = yield* ModelContext;
          return yield* modelContextPort.prepareTurn(story8Input() as never);
        }),
        app,
      ) as never,
    );

    const turn = prepared as {
      readonly _tag: string;
      readonly turn: {
        readonly request: {
          readonly toolDefinitions: ReadonlyArray<{
            readonly name: string;
            readonly description: string;
            readonly schemaJson: string;
          }>;
        };
      };
    };
    expect(turn._tag).toBe("Ready");
    const compiled = turn.turn.request.toolDefinitions.find(
      (tool) => tool.name === ECHO_DEFINITION.name,
    );
    expect(compiled).toBeDefined();
    expect(compiled?.description).toBe(ECHO_DEFINITION.description);
    expect(compiled?.schemaJson).toBe(ECHO_DEFINITION.inputSchemaJson);
    expect(compiled?.description).not.toBe(ECHO_DEFINITION.name);
    expect(compiled?.schemaJson).not.toBe("{}");
    for (const builtin of BUILTIN_TOOLS) {
      expect(
        turn.turn.request.toolDefinitions.some(
          (tool) => tool.name === builtin.name,
        ),
      ).toBe(true);
    }
  });
});

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

const safetyProjectPayload: CreateProjectPayload = {
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
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: "." }],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(safetyWorkspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
};

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
      schemaVersion: "1",
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
      toolName: "arbor_directive",
      argumentsJson: JSON.stringify({
        _tag: "CompletionClaim",
        claim: { claimRef: "claim-1", workRevision: 0 },
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
      toolName: "shell",
      argumentsJson: JSON.stringify({
        command: "echo hello",
        cwd: { _tag: "FileTree", path: "." },
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
  const app = buildSliceLayer({
    databaseFile: join(dir, "slice.db"),
    providerTurns,
    runtimeSafetyPolicy: safetyPolicyConfig,
  });
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const gateway = yield* CommandGateway;
        const created = yield* gateway.execute(
          safetyEnvelope("CreateProject", safetyProjectPayload, "1"),
          safetyContext,
          safetyAuthority("CreateProjectAuthority", safetyProjectPayload, "1"),
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
          throw new Error(`AssignWork: ${JSON.stringify(assigned.resolution)}`);
        }
        const ownership = yield* ResourceOwnershipRepository;
        const tx0 = yield* TransactionPort;
        yield* tx0.transact(
          ownership.insertClaim({
            claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
            workspaceId: safetyWorkspaceId,
            region: {
              resourceSpaceId: "filesystem",
              normalizedRegion: { kind: "FileTree", path: "." },
            },
            sourceAddressSnapshot: { _tag: "FileTree", path: "." },
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
    it(`story 9 ${testCase.dim}: a violation interrupts with RuntimeSafetyStop and Work remains Open`, async () => {
      const result = await runSafetyScenario(
        testCase.safetyPolicy,
        testCase.turns,
      );
      expect(result.settlementTag).toBe("Interrupted");
      expect(result.settlementReason).toBe("RuntimeSafetyStop");
      expect(result.workLifecycle).toBe("Open");
    });
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

// ---------------------------------------------------------------------------
// story 10 (`09`): region-encoding convergence + narrow invalidation
// ---------------------------------------------------------------------------

const regionProject = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const RESOURCE_SPACE_IDS: ReadonlySet<string> = new Set([
  "filesystem",
  "database",
  "external",
]);
const assertProducerRegion = (
  region: CanonicalResourceRegion,
  label: string,
): void => {
  expect(
    RESOURCE_SPACE_IDS.has(region.resourceSpaceId),
    `${label}: resourceSpaceId`,
  ).toBe(true);
  expect(typeof region.normalizedRegion, `${label}: normalizedRegion`).toBe(
    "object",
  );
};

const runRegionResolver = <A, E>(
  program: Effect.Effect<A, E, EnvironmentResolverPort | SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        Layer.provideMerge(
          EnvironmentResolverLocalLive,
          layer({ filename: ":memory:" }),
        ),
      ),
    ),
  );

describe("p12-acceptance story 10 — region-encoding convergence", () => {
  it("story 10: resolver output is the frozen object encoding and narrow invalidation is reachable", async () => {
    const dir = join(suiteTmp, "region-tree");
    await mkdir(dir, { recursive: true });
    await runRegionResolver(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const resolver = yield* EnvironmentResolverPort;
        const observation = yield* resolver.observe(regionProject, [
          { _tag: "FileTree", path: dir },
        ]);
        for (const entry of observation.entries) {
          assertProducerRegion(entry.resolved, "resolver entry");
        }
        for (const region of observation.changedRegions) {
          assertProducerRegion(region, "resolver changedRegions");
        }
        const changed = observation.changedRegions[0];
        if (changed === undefined) {
          throw new Error("resolver emitted no changed region");
        }
        const normalized = changed.normalizedRegion as { path: string };
        const boundInside: CanonicalResourceRegion = {
          resourceSpaceId: changed.resourceSpaceId,
          normalizedRegion: {
            kind: "FileTree",
            path: join(normalized.path, "module-1"),
          },
        };
        expect(
          verificationFreshness(
            { targetEnvironmentRevision: "1", boundRegions: [boundInside] },
            [{ toRevision: "2", changedRegions: observation.changedRegions }],
          ),
        ).toBe("STALE");
        expect(
          verificationFreshness(
            {
              targetEnvironmentRevision: "1",
              boundRegions: [
                {
                  resourceSpaceId: "filesystem",
                  normalizedRegion: {
                    kind: "FileTree",
                    path: join(suiteTmp, "unrelated"),
                  },
                },
              ],
            },
            [{ toRevision: "2", changedRegions: observation.changedRegions }],
          ),
        ).toBe("CURRENT");
        const impact = evaluateEnvironmentImpact({
          changedRegions: observation.changedRegions,
          workspaces: [
            {
              workspaceId: parse(WorkspaceId)(
                "ws_018f2b3c-4d5e-7abc-8def-0123456789e1",
              ),
              boundaryRegions: [boundInside],
            },
          ],
          works: [],
          activeClaims: [],
        });
        expect(impact.affectedWorkspaceIds).toHaveLength(1);
      }),
    );

    expect(
      canonicalRegionString({
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: "/a" },
      }),
    ).not.toBe(
      canonicalRegionString({
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: "/b" },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// story 11 (`10`): transport renders DTOs, forwards Commands, no canonical write
// ---------------------------------------------------------------------------

const transportProject = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const transportWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const transportSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const transportCommand = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ab",
);

const transportTreeDto: TreeViewRes = {
  nodes: [
    {
      workspaceId: transportWorkspace,
      name: "root",
      status: "executing",
      subtreeAttention: { attention: 1, actionRequired: 0 },
    },
  ],
};
const transportTreeResult: QueryResult<TreeViewRes> = {
  value: transportTreeDto,
  watermark: 7,
  lag: 2,
};
const transportStaleError: ProjectionStale = {
  _tag: "ProjectionStale",
  code: "projection/stale",
  category: "stale",
  correlationId: "corr-1",
  retryDisposition: "retryable",
  safeDetails: { watermark: 1, lag: 5 },
};
const transportViews = (): ViewQueryFace => ({
  query: (<V extends ViewId>(view: V, _request: ViewRequestMap[V]) =>
    view === "responsibility-tree"
      ? Effect.succeed(
          transportTreeResult as unknown as QueryResult<ViewResponseMap[V]>,
        )
      : Effect.fail(transportStaleError)) as ViewQueryFace["query"],
});

const transportCreateProjectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: transportWorkspace,
  primarySession: {
    sessionId: transportSession,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: {
      purpose: "p",
      ownedResponsibilities: [],
      obligations: [],
      includes: [],
      excludes: [],
      interfaces: [],
    },
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(transportWorkspace),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const transportCreateEnvelope = () => ({
  commandType: "CreateProject",
  commandId: transportCommand,
  projectId: transportProject,
  actor: parse(Actor)("user:human"),
  issuedAt: ISSUED_AT,
  payload: transportCreateProjectPayload() as unknown,
});

type TransportDbServices =
  | SqlClient
  | AuthorityResolverPort
  | CommandGateway
  | CommandHandlerRegistry
  | TransactionPort
  | ProjectRepository
  | WorkspaceRepository
  | ExecutionRepository
  | WorkRepository
  | PermissionGrantRepository
  | CommandStore
  | DomainEventJournal
  | SessionRepository
  | WorkWaitStore
  | Clock
  | IdGenerator;

const transportApp = (): Layer.Layer<TransportDbServices> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(PermissionGrantRepositoryLive, infra),
    // P14: the registry also wires SubmitHumanMessage (human chat-turn).
    Layer.provide(HumanMessageStoreLive, infra),
    // P13: the external registry also wires the Human-actionable governance
    // handlers (RecordDecision/SteerWork/AcceptWorkOutcome/Grant/Revoke).
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
  );
  const all = Layer.mergeAll(
    infra,
    deps,
    FenceStopCheckInertLive,
    Layer.provide(SliceCommandHandlerRegistryLive, deps),
    AuthorityResolverPortLive,
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<TransportDbServices>;
};

const transportRun = <A>(
  program: Effect.Effect<A, unknown, TransportDbServices>,
): Promise<A> => Effect.runPromise(Effect.provide(program, transportApp()));

describe("p12-acceptance story 11 — transport shells + daemons", () => {
  it("story 11: shells render the frozen DTOs, forward Commands, hold no canonical write, and Search stays deferred", async () => {
    const core = makeTransportCore({
      views: transportViews(),
      authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
      submission: {
        submit: () =>
          Effect.succeed({
            ok: true as const,
            status: 200,
            body: {
              commandId: transportCommand,
              resolution: "Committed" as const,
            },
          }),
      },
    });
    const http = makeHttpShell(core);
    const ws = makeWebSocketShell(core);
    const cli = makeCliShell(core);
    const web = makeWebShell(core);

    const viaHttp = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/responsibility-tree",
        body: { projectId: transportProject },
      }),
    );
    const viaWs = await Effect.runPromise(
      ws.handleFrame({
        kind: "view",
        view: "responsibility-tree",
        request: { projectId: transportProject },
      }),
    );
    const viaCli = await Effect.runPromise(
      cli.run([
        "view",
        "responsibility-tree",
        JSON.stringify({ projectId: transportProject }),
      ]),
    );
    for (const response of [viaHttp, viaWs, viaCli]) {
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.body).toEqual(transportTreeResult);
      }
    }
    const rendered = await Effect.runPromise(
      web.renderView("responsibility-tree", { projectId: transportProject }),
    );
    expect(rendered.html).toContain(JSON.stringify(transportTreeResult));

    const failure = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/attention",
        body: { projectId: transportProject },
      }),
    );
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(Object.keys(failure.problem).sort()).toEqual([
        "category",
        "code",
        "correlationId",
        "message",
        "retryDisposition",
        "safeDetails",
      ]);
    }

    const outcome = await transportRun(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [],
          directParentOf: [],
        });
        const dbCore = makeTransportCore({
          views: transportViews(),
          authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
          submission,
        });
        const response = yield* dbCore.submitCommand(
          { token: "human-token" },
          transportCreateEnvelope(),
        );
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM projects",
        );
        return { response, projects: Number(rows[0]?.count ?? 0) };
      }),
    );
    expect(outcome.response.ok).toBe(true);
    expect(outcome.projects).toBe(1);

    expect(SEARCH_TRANSPORT_BINDING.implemented).toBe(false);
    expect(SEARCH_TRANSPORT_BINDING.owner).toBe("P10");
    expect(isViewId("search")).toBe(false);
    expect((VIEW_IDS as ReadonlyArray<string>).includes("search")).toBe(false);

    const order: string[] = [];
    const emptyConsumer: ConsumerLoopResult = {
      fromSequence: 0,
      lastSequence: 0,
      applied: 0,
      quarantined: 0,
      records: [],
    };
    const recovery = makeRecoveryDaemon({
      startupRecovery: Effect.sync(() => {
        order.push("startup");
      }),
      sweepRecovery: Effect.sync(() => {
        order.push("sweep");
      }),
    });
    const consumers = [
      makeConsumerLoopDaemon({
        consumerId: "verification",
        projectId: transportProject,
        batchSize: 10,
        poll: Effect.sync(() => {
          order.push("poll");
          return emptyConsumer;
        }),
      }),
    ];
    const daemon = makeProductionDaemon({
      migrate: Effect.sync(() => {
        order.push("migrate");
      }),
      recovery,
      consumers,
    });
    await Effect.runPromise(daemon.start);
    expect(order).toEqual(["migrate", "startup"]);
    const watcher = makeDriftWatcherTrigger({
      probe: () =>
        Effect.succeed({ _tag: "NoDrift", atRevision: "3" } as DriftReport),
    });
    expect(
      (await Effect.runPromise(watcher.trigger(transportProject, [])))._tag,
    ).toBe("NoDrift");
    expect(recoveryDaemonFromPrincipal(HUMAN).startup).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// story 12 (`12`): real provider adapter + catalog + non-minimal tool
// ---------------------------------------------------------------------------

const providerRequest: PortableModelRequest = {
  modelRef: "model-openai",
  instructions: [],
  messages: [],
  toolDefinitions: [],
  outputContractRef: "agent-directive-v1",
  budget: { maxOutputTokens: 128 },
  cacheHints: [],
};
const providerContext: ProviderExecutionContext = {
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  attemptNo: 0,
  timeoutMs: 1000,
  cancellationRef: "cancel-1",
};
const sdkClient = (
  chunks: ReadonlyArray<OpenAISdkChunk>,
  error?: OpenAISdkError,
): OpenAISdkClient => ({
  streamChat: () =>
    (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (error !== undefined) {
        throw error;
      }
    })(),
});

const story12ToolContext = {
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  actor: parse(Actor)("worker:a"),
  authenticatedPrincipal: parse(Principal)("worker:a"),
  authority: {
    principal: parse(Principal)("worker:a"),
    workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    toolName: "list",
    toolVersion: "1",
    resourceSpaceIds: ["filesystem"],
    allowedCapabilities: ["fs:read"],
    controlBasisDigest: "d",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "d",
  requestedAt: "t",
} as never;

const runProvider = <A, E>(
  providerLayer: Layer.Layer<ProviderPort>,
  program: Effect.Effect<A, E, ProviderPort>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, providerLayer) as Effect.Effect<A, E, never>,
  );

describe("p12-acceptance story 12 — real provider adapter + non-minimal tool", () => {
  it("story 12: the real adapter emits canonical events, the catalog resolves the model, and `list` runs the unchanged P4 pipeline", async () => {
    const selected = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([
        { type: "text", text: "hello" },
        { type: "completed", finishReason: "stop" },
      ]),
    });
    const events = await runProvider(
      selected,
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        const chunk = yield* Stream.runCollect(
          provider.runTurn({
            request: providerRequest,
            context: providerContext,
          }),
        );
        return Array.from(chunk);
      }),
    );
    expect(events.map((event) => event._tag)).toContain("TurnCompleted");

    const failing = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([], new OpenAISdkError(429, "rate_limit_exceeded")),
    });
    const failure = (await runProvider(
      failing,
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        return yield* Effect.flip(
          Stream.runCollect(
            provider.runTurn({
              request: providerRequest,
              context: providerContext,
            }),
          ),
        );
      }),
    )) as ProviderFailure;
    expect(failure._tag).toBe("ProviderFailure");
    expect(failure.kind).toBe("RateLimited");
    expect(providerFailureDisposition(failure.kind)).toBe("retryable");

    expect(
      resolveModelCatalogEntry(DEFAULT_MODEL_CATALOG, "model-openai")
        ?.adapterId,
    ).toBe("provider-openai");
    const capabilityError = await Effect.runPromise(
      Effect.flip(resolveModelCapability(DEFAULT_MODEL_CATALOG, "ghost")),
    );
    expect(capabilityError._tag).toBe("ModelCapabilityError");
    expect([...PROVIDER_FAILURE_KINDS].sort()).toEqual([
      "AuthenticationFailed",
      "ProtocolViolation",
      "ProviderUnavailable",
      "RateLimited",
      "RequestRejected",
      "StreamInterrupted",
    ]);

    const root = mkdtempSync(join(tmpdir(), "p12-acceptance-tool-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "sub", "b.txt"), "b");
    const txFake = Layer.succeed(TransactionPort, {
      transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
        Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
    } as never);
    const toolDeps = Layer.mergeAll(
      txFake,
      ToolDefinitionStoreLive,
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "s",
            rootPath: root,
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      } as never),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: () => Effect.void,
        settle: () => Effect.void,
        consumeApproval: () => Effect.succeed(true),
        findApproval: () => Effect.succeed(Option.none()),
        findUnsettled: () => Effect.succeed([]),
      } as never),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: (_p: ProjectId, addresses: ReadonlyArray<unknown>) =>
          Effect.succeed({
            regions: addresses.map((address) => ({
              resourceSpaceId: "filesystem",
              normalizedRegion: address,
            })),
            observedEnvironmentRevision: "rev",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-01-01T00:00:00.000Z"),
      }),
    );
    const toolApp = Layer.mergeAll(
      toolDeps,
      Layer.provide(ToolRuntimeLive(BUILTIN_EXECUTORS), toolDeps),
    );
    const listInvocation = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              callRef: "c",
              toolName: "list",
              toolVersion: "1",
              argumentsJson: JSON.stringify({
                path: { _tag: "FileTree", path: "." },
                depth: 2,
              }),
              invocationId: parse(ToolInvocationId)(
                "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
              ),
              approvalId: null,
            } as never,
            story12ToolContext,
          );
        }),
        toolApp,
      ) as Effect.Effect<{ _tag: string }, unknown, never>,
    );
    expect(listInvocation._tag).toBe("Success");
  });
});

// ---------------------------------------------------------------------------
// story 13 (`13`): Information Trust Plane + sandbox + operating envelope
// ---------------------------------------------------------------------------

const trust = (
  provenanceKind: InformationTrustMetadata["provenanceKind"],
): InformationTrustMetadata => ({
  provenanceKind,
  instructionCapability: "DataOnly",
  epistemicStatus: "Established",
});

describe("p12-acceptance story 13 — security hardening + performance", () => {
  it("story 13: DataOnly fragments cannot raise authority and the operating envelope is measured", () => {
    const dataKinds: ReadonlyArray<InformationTrustMetadata["provenanceKind"]> =
      [
        "ToolObservation",
        "ExternalRetrieved",
        "AuthenticatedAgent",
        "AuthenticatedHuman",
        "ImportedArtifact",
        "ModelDerived",
      ];
    for (const kind of dataKinds) {
      const fragment = contextFragment({
        ref: `f-${kind}`,
        layer: "C3",
        retention: "Evictable",
        cacheClass: "TurnDynamic",
        tokens: 10,
        provenance: trust(kind),
      });
      expect(fragment.provenance.instructionCapability).toBe("DataOnly");
      expect(canRaiseAuthority(fragment.provenance)).toBe(false);
    }
    const canonical = contextFragment({
      ref: "canonical",
      layer: "C0",
      retention: "Pinned",
      cacheClass: "Stable",
      tokens: 10,
      provenance: {
        provenanceKind: "CanonicalInternal",
        instructionCapability: "DataOnly",
        epistemicStatus: "Established",
      },
    });
    expect(canonical.provenance.instructionCapability).toBe(
      "CanonicalInstruction",
    );
    expect(canRaiseAuthority(canonical.provenance)).toBe(true);
    const planned = planContext([canonical], {
      modelWindow: 100,
      outputReserve: 20,
      protocolReserve: 10,
      toolReserve: 10,
    });
    expect(planned.selected[0]?.provenance).toEqual(canonical.provenance);

    const sentinel = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const projected = sandboxEnvironment({
      PATH: "/usr/bin:/bin",
      [sentinel]: "must-not-leak",
    });
    expect(sentinel in projected).toBe(false);
    expect(
      Object.keys(projected).every((key) =>
        SANDBOX_ENV_ALLOWLIST.includes(key),
      ),
    ).toBe(true);

    const assessment = JSON.parse(
      readRepoFile("planning/results/P12.storage-assessment.json"),
    ) as {
      operatingEnvelope: OperatingEnvelope;
      measurements: ReadonlyArray<Measurement>;
      verdict: string;
    };
    expect(validateStorageScaleAssessment(assessment)).toEqual([]);
    for (const dimension of ENVELOPE_DIMENSIONS) {
      expect(typeof assessment.operatingEnvelope[dimension].value).toBe(
        "number",
      );
    }
    for (const measurement of assessment.measurements) {
      expect(measurement.method.length).toBeGreaterThan(0);
    }
  });
});
