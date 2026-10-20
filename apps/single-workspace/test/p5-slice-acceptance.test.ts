import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
  ExecutionId,
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  makeProjectPolicy,
  makeWorkspacePolicy,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  type SandboxPolicyCandidateReadV1,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { runExecution } from "@arbor/execution-runtime";
import {
  ExecutionScheduler,
  PermissionGrantRepository,
  ProjectionQueryPort,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureLegacyProjectResourceSourceFixture } from "../../../tests/support/legacy-project-resource-source.js";
import {
  createCurrentSchemaTestDatabaseFactory,
  type Schema44TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import {
  admitExecution,
  buildSingleWorkspaceLayer,
  evaluateAndSelect,
} from "../src/index.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../src/project-resource-profiles.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const exe1 = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
const exe2 = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a2");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};
const sandboxDecisionPrincipal = parse(Principal)("user:sandbox-decider");
const sandboxDecisionActor = parse(Actor)(String(sandboxDecisionPrincipal));
const sandboxGrantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const shellGrantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sandboxAuthorityFixture = (() => {
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [principal],
  };
  const issuerConfigJson = JSON.stringify(issuerConfig);
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: ["PATH"],
    limitsByProfile: (
      ["ReadOnly", "WorkspaceWrite", "FullAccess"] as const
    ).map((profile) => ({
      profile,
      limits: {
        wallTimeMs: 60_000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134_217_728,
        cpuTimeMs: 30_000,
      },
    })),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const operatorConfigJson =
    encodeSandboxOperatorPolicyConfigV1(operatorConfig);
  const providerRegistry = { version: 1 as const, revision: 1, entries: [] };
  const providerRegistryJson = JSON.stringify(providerRegistry);
  const bundle = {
    version: 2 as const,
    sourceIdentity: "host:p5-slice-current-schema",
    bundleRevision: 1,
    issuerConfigRevision: issuerConfig.revision,
    issuerConfigDigest: sha256(issuerConfigJson),
    issuerConfig,
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest: sha256(operatorConfigJson),
    operatorConfig,
    providerRegistryRevision: providerRegistry.revision,
    providerRegistryDigest: sha256(providerRegistryJson),
    providerRegistry,
  };
  const canonicalJson = encodeSandboxAuthorityBundleV2(bundle);
  const bundleDigest = sha256(canonicalJson);
  const highWaterJson = encodeSandboxAuthorityHighWaterV2({
    version: 2,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: bundle.bundleRevision,
    bundleDigest,
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
  });
  return {
    bundle,
    bundleDigest,
    source: {
      readVerifiedSandboxAuthorityBundle: () =>
        Effect.succeed({
          sourceIdentity: bundle.sourceIdentity,
          canonicalJson,
        }),
      readSandboxAuthorityHighWater: () => Effect.succeed(highWaterJson),
      commitSandboxAuthorityHighWater: () => Effect.succeed(false),
      appendSandboxAuthorityAudit: () => Effect.succeed(true),
    },
  };
})();
let schema44Factory: Schema44TestDatabaseFactory | undefined;
const schema44Cleanups: Array<() => void> = [];
const scratchDirectories: string[] = [];

beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory({
    prefix: ".p5-slice-acceptance-template-",
  });
}, 120_000);

afterAll(() => schema44Factory?.cleanup(), 120_000);

const createSchema44Case = () => {
  if (schema44Factory === undefined) {
    throw new Error("Schema-42 test database factory was not prepared.");
  }
  return schema44Factory.create();
};

afterEach(() => {
  for (const cleanup of schema44Cleanups.splice(0)) cleanup();
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}, 120_000);

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const projectPayload = (
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

const workPayload: AssignWorkPayload = {
  workId,
  workspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P5",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

const commandId = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`);

const p1Authority = (
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

const envelope = <P>(
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

const wait = (reason: string) => [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason,
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const turns = [
  [
    {
      _tag: "ToolCallProposed" as const,
      callRef: "c1",
      toolName: "shell",
      argumentsJson: JSON.stringify({
        command: "echo hello",
        cwd: { mount: "workspace", path: "." },
      }),
    },
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
  wait("wait for the first wake"),
  wait("wait for the second wake"),
];

describe("I0 executable/control vertical slice", () => {
  it("routes shell through ToolRuntime and Wait through ControlToolRegistry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-accept-"));
    scratchDirectories.push(dir);
    const fixture = createSchema44Case();
    schema44Cleanups.push(fixture.cleanup);
    const projectResourceProfiles = makeProjectResourceProfilePort(
      projectResourceProfilesFromEnvironment({ ARBOR_PROJECT_ROOT: dir }),
    );
    const profile = Effect.runSync(projectResourceProfiles.list())[0];
    if (profile === undefined || !profile.available) {
      throw new Error("P5 host Project Profile must be available");
    }
    const resolvedProfile = Effect.runSync(
      projectResourceProfiles.resolve(
        profile.resourceProfileRef,
        profile.version,
      ),
    );
    if (Option.isNone(resolvedProfile)) {
      throw new Error("P5 host Project Profile did not resolve");
    }
    const canonicalRoot = resolvedProfile.value.canonicalAddress.path;
    expect(canonicalRoot).toBe(realpathSync(dir));
    const selectedProjectPayload = projectPayload({
      _tag: "Profile",
      resourceProfileRef: profile.resourceProfileRef,
      version: profile.version,
    });
    const app = buildSingleWorkspaceLayer({
      databaseFile: fixture.databaseFilename,
      providerTurns: turns,
      projectResourceProfiles,
      trustedHostConfigurationSource: sandboxAuthorityFixture.source,
    });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* ensureLegacyProjectResourceSourceFixture();
          const gateway = yield* CommandGateway;
          const scheduler = yield* ExecutionScheduler;
          const sql = yield* SqlClient;

          const created = yield* gateway.execute(
            envelope("CreateProject", selectedProjectPayload, commandId("1")),
            context,
            p1Authority(
              "CreateProjectAuthority",
              selectedProjectPayload,
              commandId("1"),
            ),
          );
          const assigned = yield* gateway.execute(
            envelope("AssignWork", workPayload, commandId("2")),
            context,
            p1Authority("AssignWorkAuthority", workPayload, commandId("2")),
          );
          const shellGrantPayload = {
            permissionGrantId: shellGrantId,
            issuer: principal,
            subject: { _tag: "WorkspaceAgent" as const, workspaceId },
            capability: "shell:exec",
            target: workspaceId,
            expiresAt: "2099-12-31T00:00:00.000Z",
          };
          const shellGrantCommandId = commandId("5");
          const shellGrantReceipt = yield* gateway.execute(
            {
              commandType: "GrantPermission",
              commandId: shellGrantCommandId,
              projectId,
              actor,
              issuedAt: "2026-10-20T00:00:00.000Z",
              payload: shellGrantPayload,
            },
            { _tag: "External", principal },
            {
              _tag: "GrantPermissionAuthority",
              principal,
              commandId: shellGrantCommandId,
              semanticRequestFingerprint: semanticRequestFingerprint({
                commandType: "GrantPermission",
                projectId,
                actor,
                schemaVersion: "1",
                payload: shellGrantPayload,
              }),
              projectId,
              permissionGrantId: shellGrantId,
            },
          );
          if (shellGrantReceipt.resolution._tag !== "Committed") {
            return yield* Effect.die({
              _tag: "P5ShellGrantFailed",
              receipt: shellGrantReceipt,
            });
          }

          // Current P11/V6 sandbox policy candidates bind an exact managed
          // Git worktree, not the historical FileTree-only P5 fixture. Keep
          // the P1 creation path above, then model the host-owned activation
          // facts that exist before an executable Work action is admitted.
          const managedWorktreeRoot = realpathSync(process.cwd());
          yield* sql.unsafe(
            `UPDATE workspaces
                SET responsibility_revision = 1,
                    resource_boundary = ?,
                    resource_boundary_revision = 1,
                    revision = revision + 1,
                    updated_at = 't'
              WHERE workspace_id = ? AND project_id = ? AND lifecycle = 'Active'`,
            [
              JSON.stringify({
                basisResponsibilityRevision: 1,
                addresses: [{ _tag: "GitWorktree", path: managedWorktreeRoot }],
              }),
              workspaceId,
              projectId,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO worktrees (
               worktree_id, project_id, workspace_id, path,
               repository_ref, branch, state, created_at, retired_at
             ) VALUES ('wt_p5_slice_current', ?, ?, ?, NULL, NULL,
                       'Active', 't', NULL)`,
            [projectId, workspaceId, managedWorktreeRoot],
          );

          // Story precondition (out of P1–P4 slice scope): the Workspace already
          // holds the resource-ownership claim for its boundary region. No
          // P1–P4 command establishes ownership; it is a governance fact.
          const ownership = yield* ResourceOwnershipRepository;
          const tx0 = yield* TransactionPort;
          yield* tx0.transact(
            ownership.insertClaim({
              claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
              workspaceId,
              region: {
                resourceSpaceId: "filesystem",
                // P12 `09`: the production resolver emits the frozen object
                // encoding with an ABSOLUTE normalized path (P1 `04` §3.3);
                // the claim fixture must match it.
                normalizedRegion: {
                  kind: "GitWorktree",
                  path: managedWorktreeRoot,
                },
              },
              sourceAddressSnapshot: {
                _tag: "GitWorktree",
                path: managedWorktreeRoot,
              },
              resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
              resolvedAtEnvironmentRevision: "local",
              createdAt: "t",
              releasedAt: null,
            }),
          );

          const step = yield* evaluateAndSelect(workspaceId, principal, {
            _tag: "WorkSelected",
          });
          const decision = step.decision;

          const firstAdmit = yield* admitExecution(
            workspaceId,
            exe1,
            { _tag: "Work", workId },
            principal,
          );
          const conflict = yield* admitExecution(
            workspaceId,
            exe2,
            { _tag: "Work", workId },
            principal,
          );

          // The decision capability is a standing, exact grant before P4
          // captures the action's immutable authority-source revision. The
          // later human policy choice must not manufacture or widen tool
          // authority while that action is pending.
          const grantExpiresAt = "2099-12-31T00:00:00.000Z";
          const grantPayload = {
            permissionGrantId: sandboxGrantId,
            issuer: principal,
            subject: {
              _tag: "HumanPrincipal" as const,
              principal: sandboxDecisionPrincipal,
            },
            capability: "DecideSandboxPolicy",
            target: exe1,
            expiresAt: grantExpiresAt,
          };
          const grantCommandId = commandId("3");
          const grantFingerprint = semanticRequestFingerprint({
            commandType: "GrantPermission",
            projectId,
            actor,
            schemaVersion: "1",
            payload: grantPayload,
          });
          const grantReceipt = yield* gateway.execute(
            envelope("GrantPermission", grantPayload, grantCommandId),
            { _tag: "External", principal },
            {
              _tag: "GrantPermissionAuthority",
              principal,
              commandId: grantCommandId,
              semanticRequestFingerprint: grantFingerprint,
              projectId,
              permissionGrantId: sandboxGrantId,
              sandboxPolicyIssuerBinding: {
                executionId: exe1,
                operatorConfigRevision:
                  sandboxAuthorityFixture.bundle.issuerConfigRevision,
                operatorConfigDigest:
                  sandboxAuthorityFixture.bundle.issuerConfigDigest,
                authorityBundleRevision:
                  sandboxAuthorityFixture.bundle.bundleRevision,
                authorityBundleDigest: sandboxAuthorityFixture.bundleDigest,
                providerRegistryRevision:
                  sandboxAuthorityFixture.bundle.providerRegistryRevision,
                providerRegistryDigest:
                  sandboxAuthorityFixture.bundle.providerRegistryDigest,
              },
            },
          );
          if (grantReceipt.resolution._tag !== "Committed") {
            return yield* Effect.die({
              _tag: "P5SandboxPolicyGrantFailed",
              receipt: grantReceipt,
            });
          }

          const policyInterruption = yield* runExecution(
            exe1,
            { _tag: "WorkSelected" },
            principal,
          );
          if (policyInterruption._tag !== "SandboxPolicyRequiredInterruption") {
            return yield* Effect.die({
              _tag: "P5ExpectedSandboxPolicyInterruption",
              actual: policyInterruption._tag,
            });
          }

          const projection = yield* ProjectionQueryPort;
          const detail = yield* projection.query<
            { readonly workspaceId: WorkspaceId },
            {
              readonly sandboxPolicyCandidateRead?: SandboxPolicyCandidateReadV1;
            }
          >("workspace-detail", { workspaceId });
          const candidateRead = detail.value.sandboxPolicyCandidateRead;
          const trustedCandidate = candidateRead?.candidates.find(
            (candidate) => candidate.kind === "TrustedLocalUnconfinedV1",
          );
          if (candidateRead === undefined || trustedCandidate === undefined) {
            return yield* Effect.die({
              _tag: "P5SandboxPolicyCandidateMissing",
              detail: detail.value,
            });
          }

          const grants = yield* PermissionGrantRepository;
          const persistedGrant = yield* tx0.transact(
            grants.findById(sandboxGrantId),
          );
          const persistedProvenance = yield* tx0.transact(
            grants.findSandboxPolicyGrantIssuerProvenanceByGrantId(
              sandboxGrantId,
            ),
          );
          if (
            Option.isNone(persistedGrant) ||
            Option.isNone(persistedProvenance)
          ) {
            return yield* Effect.die({
              _tag: "P5SandboxPolicyGrantEvidenceMissing",
            });
          }

          const policyPayload = {
            projectId,
            workspaceId,
            executionId: exe1,
            episodeBinding: candidateRead.commonPreconditions.episodeBinding,
            expectedEpisodeRevision:
              candidateRead.commonPreconditions.expectedEpisodeRevision,
            expectedPolicyRevision:
              candidateRead.commonPreconditions.latestCommittedPolicyRevision,
            expectedWorkspaceRevision:
              candidateRead.commonPreconditions.workspaceRevision,
            expectedResourceBoundaryRevision:
              candidateRead.commonPreconditions.resourceBoundaryRevision,
            expectedSandboxHandleBindingDigest:
              trustedCandidate.sandboxHandleBindingDigest,
            expectedAuthorityBundleRevision:
              candidateRead.commonPreconditions.authorityBundleRevision,
            expectedAuthorityBundleDigest:
              candidateRead.commonPreconditions.authorityBundleDigest,
            expectedOperatorConfigRevision:
              candidateRead.commonPreconditions.operatorConfigRevision,
            expectedOperatorConfigDigest:
              candidateRead.commonPreconditions.operatorConfigDigest,
            profile: "FullAccess" as const,
            providerId: "TrustedLocal",
            networkPolicy: {
              kind: "TrustedLocalUnconfinedV1" as const,
              version: 1 as const,
            },
            decisionExpiresAt: "2099-12-30T00:00:00.000Z",
          };
          const policyCommandId = commandId("4");
          const policyFingerprint = semanticRequestFingerprint({
            commandType: "DecideSandboxPolicy",
            projectId,
            actor: sandboxDecisionActor,
            schemaVersion: "1",
            payload: policyPayload,
          });
          const policyReceipt = yield* gateway.execute(
            {
              commandType: "DecideSandboxPolicy",
              commandId: policyCommandId,
              projectId,
              actor: sandboxDecisionActor,
              issuedAt: "t",
              payload: policyPayload,
            },
            { _tag: "External", principal: sandboxDecisionPrincipal },
            {
              _tag: "SandboxPolicyDecisionAuthority",
              principal: sandboxDecisionPrincipal,
              commandId: policyCommandId,
              semanticRequestFingerprint: policyFingerprint,
              projectId,
              workspaceId,
              executionId: exe1,
              episodeBinding: candidateRead.commonPreconditions.episodeBinding,
              episodeRevision:
                candidateRead.commonPreconditions.expectedEpisodeRevision,
              permissionGrant: persistedGrant.value,
              issuerProvenance: persistedProvenance.value,
              authorityBundleRevision:
                candidateRead.commonPreconditions.authorityBundleRevision,
              authorityBundleDigest:
                candidateRead.commonPreconditions.authorityBundleDigest,
              providerRegistryRevision:
                sandboxAuthorityFixture.bundle.providerRegistryRevision,
              providerRegistryDigest:
                sandboxAuthorityFixture.bundle.providerRegistryDigest,
              operatorConfigRevision:
                candidateRead.commonPreconditions.operatorConfigRevision,
              operatorConfigDigest:
                candidateRead.commonPreconditions.operatorConfigDigest,
            },
          );
          if (policyReceipt.resolution._tag !== "Committed") {
            return yield* Effect.die({
              _tag: "P5SandboxPolicyDecisionFailed",
              receipt: policyReceipt,
            });
          }

          const firstSettlement = yield* runExecution(
            exe1,
            { _tag: "WorkSelected" },
            principal,
          );
          const settlementRows = yield* sql.unsafe<{
            settlement_kind: string | null;
            settlement_tag: string | null;
            reconciliation_tag: string | null;
            invocation_ref_count: number | null;
          }>(
            `SELECT settlement_kind,
                    json_extract(settlement_json, '$._tag') AS settlement_tag,
                    json_extract(settlement_json, '$.reconciliation._tag') AS reconciliation_tag,
                    json_array_length(settlement_json, '$.reconciliation.invocationRefs') AS invocation_ref_count
               FROM executions WHERE execution_id = ?`,
            [exe1],
          );
          const toolEvidenceRows = yield* sql.unsafe<{
            tool_name: string;
            effect_admission_state: string;
            recovery_binding_state: string;
            settlement_kind: string | null;
            settlement_tag: string | null;
            observation_format_version: string | null;
            observation_tag: string | null;
            observation_storage_type: string | null;
            observation_json_bytes: number | null;
            observation_sha_length: number | null;
            observation_sha_is_lower_hex: number | null;
            binding_tool_definition_hash_length: number | null;
            binding_tool_definition_hash_is_lower_hex: number | null;
          }>(
            `SELECT tool_name, effect_admission_state, recovery_binding_state,
                    settlement_kind,
                    json_extract(settlement_json, '$._tag') AS settlement_tag,
                    observation_format_version,
                    json_extract(CAST(observation_json AS TEXT), '$._tag') AS observation_tag,
                    typeof(observation_json) AS observation_storage_type,
                    length(observation_json) AS observation_json_bytes,
                    length(observation_sha256) AS observation_sha_length,
                    observation_sha256 NOT GLOB '*[^0-9a-f]*' AS observation_sha_is_lower_hex,
                    (SELECT length(a.tool_definition_hash)
                       FROM tool_invocation_effect_attempts AS a
                      WHERE a.invocation_id = tool_invocations.invocation_id
                        AND a.attempt_no = 0) AS binding_tool_definition_hash_length,
                    (SELECT a.tool_definition_hash NOT GLOB '*[^0-9a-f]*'
                       FROM tool_invocation_effect_attempts AS a
                      WHERE a.invocation_id = tool_invocations.invocation_id
                        AND a.attempt_no = 0) AS binding_tool_definition_hash_is_lower_hex
               FROM tool_invocations WHERE execution_id = ? ORDER BY invocation_id`,
            [exe1],
          );
          const sandboxDiagnostic = yield* sql.unsafe<{
            stop_requested_at: string | null;
            action_state: string | null;
            action_disposition: string | null;
            policy_result_json: string | null;
            pending_requirement_count: number;
            unavailable_fact_count: number;
          }>(
            `SELECT e.stop_requested_at,
                    a.state AS action_state,
                    a.disposition_json AS action_disposition,
                    (SELECT c.result_json
                       FROM sandbox_policy_decisions AS d
                       JOIN commands AS c
                         ON c.command_id = d.decision_command_id
                      WHERE d.execution_id = e.execution_id
                      ORDER BY d.policy_revision DESC LIMIT 1) AS policy_result_json,
                    (SELECT COUNT(*) FROM tool_invocations
                      WHERE execution_id = e.execution_id
                        AND effect_admission_state = 'NotAdmitted'
                        AND settled_at IS NULL) AS pending_requirement_count,
                    (SELECT COUNT(*) FROM sandbox_provider_unavailable_facts
                      WHERE execution_id = e.execution_id) AS unavailable_fact_count
               FROM executions AS e
               LEFT JOIN agent_loop_step_actions AS a
                 ON a.execution_id = e.execution_id AND a.action_index = 0
              WHERE e.execution_id = ?`,
            [exe1],
          );
          const readmissionDiagnostic = {
            firstSettlement: {
              tag: firstSettlement._tag,
              resultTag:
                firstSettlement._tag === "Completed"
                  ? (firstSettlement.result?._tag ?? null)
                  : null,
            },
            executionSettlement: settlementRows[0] ?? null,
            toolInvocations: toolEvidenceRows,
            sandbox: sandboxDiagnostic[0] ?? null,
          };
          if (
            firstSettlement._tag !== "Completed" ||
            firstSettlement.result?._tag !== "Yielded"
          ) {
            return yield* Effect.die({
              _tag: "P5ExpectedYieldedBeforeReadmission",
              diagnosticJson: JSON.stringify(readmissionDiagnostic),
            });
          }

          const waitsAfterYield = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM work_waits",
          );
          const tx = yield* TransactionPort;
          const waitStore = yield* WorkWaitStore;
          yield* tx.transact(waitStore.clear(workId));
          const woken = yield* scheduler.reevaluate(workspaceId, {
            _tag: "HumanIntervention",
          });
          const waitsAfterWake = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM work_waits",
          );

          const readmission = yield* Effect.match(
            admitExecution(
              workspaceId,
              exe2,
              { _tag: "Work", workId },
              principal,
            ),
            {
              onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
              onSuccess: () => ({ _tag: "Success" as const }),
            },
          );
          if (readmission._tag === "Failure") {
            const failure =
              typeof readmission.failure === "object" &&
              readmission.failure !== null
                ? {
                    tag:
                      "_tag" in readmission.failure
                        ? String(readmission.failure._tag)
                        : "Unknown",
                    sourceKind:
                      "sourceKind" in readmission.failure
                        ? String(readmission.failure.sourceKind)
                        : null,
                    executionId:
                      "executionId" in readmission.failure
                        ? String(readmission.failure.executionId)
                        : null,
                  }
                : String(readmission.failure).slice(0, 200);
            return yield* Effect.die({
              _tag: "P5ReadmissionBlockedAfterYield",
              diagnostic: {
                failure,
                ...readmissionDiagnostic,
              },
            });
          }
          const secondSettlement = yield* runExecution(
            exe2,
            { _tag: "WorkSelected" },
            principal,
          );

          const works = yield* sql.unsafe<{ lifecycle: string }>(
            "SELECT lifecycle FROM works WHERE work_id = ?",
            [workId],
          );
          const executions = yield* sql.unsafe<{
            execution_id: string;
            session_id: string;
            settlement_kind: string | null;
          }>(
            "SELECT execution_id, session_id, settlement_kind FROM executions ORDER BY execution_id",
          );
          const entries = yield* sql.unsafe<{
            entry_kind: string;
            payload_json: string;
          }>(
            "SELECT entry_kind, payload_json FROM session_entries WHERE session_id = ? ORDER BY sequence",
            [sessionId],
          );
          const verificationTables = yield* sql.unsafe<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%verification%'",
          );
          const invocations = yield* sql.unsafe<{
            tool_name: string;
            arguments_json: string;
            resolved_regions_json: string;
            settlement_kind: string | null;
          }>(
            "SELECT tool_name, arguments_json, resolved_regions_json, settlement_kind FROM tool_invocations ORDER BY invocation_id",
          );

          return {
            created: created.resolution._tag,
            assigned: assigned.resolution._tag,
            decision: decision._tag,
            selections: step.selections,
            focus: decision._tag === "AdmitWork" ? "Work" : decision._tag,
            firstAdmit: (firstAdmit as { resolution: { _tag: string } })
              .resolution._tag,
            conflict: (() => {
              const resolution = (
                conflict as {
                  resolution: { _tag: string; error?: { _tag: string } };
                }
              ).resolution;
              return resolution._tag === "TerminalRejected"
                ? (resolution.error?._tag ?? "TerminalRejected")
                : resolution._tag;
            })(),
            firstSettlement,
            secondSettlement,
            waitsAfterYield: Number(waitsAfterYield[0]?.count ?? 0),
            invocations,
            toolEvidenceRows,
            woken: woken._tag,
            waitsAfterWake: Number(waitsAfterWake[0]?.count ?? 0),
            works,
            executions,
            entries,
            verificationTables: verificationTables.map((t) => t.name),
          };
        }),
        app,
      ) as unknown as Effect.Effect<
        {
          created: string;
          assigned: string;
          selections: ReadonlyArray<string>;
          focus: string;
          decision: string;
          firstAdmit: string;
          conflict: string;
          firstSettlement: { _tag: string; result?: { _tag: string } };
          secondSettlement: { _tag: string; result?: { _tag: string } };
          invocations: ReadonlyArray<{
            tool_name: string;
            arguments_json: string;
            resolved_regions_json: string;
            settlement_kind: string | null;
          }>;
          toolEvidenceRows: ReadonlyArray<{
            tool_name: string;
            effect_admission_state: string;
            recovery_binding_state: string;
            settlement_kind: string | null;
            settlement_tag: string | null;
            observation_format_version: string | null;
            observation_tag: string | null;
            observation_storage_type: string | null;
            observation_json_bytes: number | null;
            observation_sha_length: number | null;
            observation_sha_is_lower_hex: number;
            binding_tool_definition_hash_length: number | null;
            binding_tool_definition_hash_is_lower_hex: number | null;
          }>;
          waitsAfterYield: number;
          woken: string;
          waitsAfterWake: number;
          works: ReadonlyArray<{ lifecycle: string }>;
          executions: ReadonlyArray<{
            execution_id: string;
            session_id: string;
            settlement_kind: string | null;
          }>;
          entries: ReadonlyArray<{ entry_kind: string; payload_json: string }>;
          verificationTables: ReadonlyArray<string>;
        },
        unknown,
        never
      >,
    );

    expect(result.created).toBe("Committed");
    expect(result.assigned).toBe("Committed");
    expect(result.selections).toEqual([workId]);
    expect(result.decision).toBe("AdmitWork");
    expect(result.focus).toBe("Work");
    expect(result.firstAdmit).toBe("Committed");
    expect(result.conflict).toBe("ActiveExecutionConflict");

    expect(result.firstSettlement._tag).toBe("Completed");
    expect(result.secondSettlement._tag).toBe("Completed");
    if (result.firstSettlement._tag === "Completed") {
      expect(result.firstSettlement.result?._tag).toBe("Yielded");
    }
    if (result.secondSettlement._tag === "Completed") {
      expect(result.secondSettlement.result?._tag).toBe("Yielded");
    }

    expect(result.waitsAfterYield).toBe(1);
    expect(result.woken).toBe("AdmitWork");
    expect(result.waitsAfterWake).toBe(0);
    expect(result.invocations).toHaveLength(1);
    expect(result.toolEvidenceRows).toHaveLength(1);
    expect(result.toolEvidenceRows[0]).toMatchObject({
      tool_name: "shell",
      effect_admission_state: "MayHaveStarted",
      recovery_binding_state: "Bound",
      settlement_kind: "Success",
      settlement_tag: "Success",
      observation_format_version: "p4-canonical-tool-observation-v1",
      observation_tag: "Success",
      observation_storage_type: "blob",
      observation_sha_length: 64,
      observation_sha_is_lower_hex: 1,
      binding_tool_definition_hash_length: 64,
      binding_tool_definition_hash_is_lower_hex: 1,
    });
    expect(result.toolEvidenceRows[0]?.observation_json_bytes).toBeGreaterThan(
      0,
    );
    expect(
      result.toolEvidenceRows[0]?.observation_json_bytes,
    ).toBeLessThanOrEqual(16_384);
    expect(result.invocations[0]?.tool_name).toBe("shell");
    expect(
      JSON.parse(result.invocations[0]?.arguments_json ?? "{}"),
    ).toMatchObject({
      command: "echo hello",
    });
    expect(
      result.invocations[0]?.settlement_kind,
      JSON.stringify({
        invocation: result.invocations[0],
        observations: result.entries
          .filter((entry) => entry.entry_kind === "Observation")
          .map((entry) => JSON.parse(entry.payload_json) as unknown),
      }),
    ).toBe("Success");
    expect(
      JSON.parse(result.invocations[0]?.resolved_regions_json ?? "[]"),
    ).not.toHaveLength(0);

    expect(result.works.map((w) => w.lifecycle)).toEqual(["Open"]);
    expect(new Set(result.executions.map((e) => e.session_id))).toEqual(
      new Set([sessionId]),
    );
    expect(result.executions.map((e) => e.settlement_kind)).toEqual([
      "Completed",
      "Completed",
    ]);

    const kinds = result.entries.map((e) => e.entry_kind);
    expect(kinds).toContain("ModelOutput");
    expect(kinds).toContain("Observation");
    const observations = result.entries
      .filter((e) => e.entry_kind === "Observation")
      .map(
        (e) =>
          JSON.parse(e.payload_json) as {
            _tag?: string;
            source?: string;
            observation?: { text?: string };
            outputText?: string;
            status?: string;
          },
      );
    const shellObservation = observations.find(
      (o) =>
        o._tag === "ToolResult" &&
        o.status === "Succeeded" &&
        JSON.stringify(o).includes("exitCode"),
    );
    expect(shellObservation).toBeDefined();
    expect(shellObservation?.outputText).toContain('"exitCode":0');
    expect(observations.some((o) => o._tag === "DirectiveUnsupported")).toBe(
      false,
    );

    // P8 verification tables remain available in the current schema fixture.
    expect([...result.verificationTables].sort()).toEqual([
      "retry_verification_legacy_dispositions",
      "retry_verification_origins",
      "verification_evidence",
      "verification_executions",
      "verifications",
    ]);
  }, 120_000);
});
