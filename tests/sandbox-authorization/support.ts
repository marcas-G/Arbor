import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import {
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  PermissionGrantRepositoryLive,
  ProjectRepositoryLive,
  runMigrations,
  SandboxPolicyDecisionStoreLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkspaceRepositoryLive,
  WorkspaceSandboxAuthorizationStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION } from "../../adapters/persistence-sqlite/src/p57-workspace-sandbox-authorization-migration.js";
import { ToolAuthorityResolverLive } from "../../apps/single-workspace/src/tool-authority-resolver.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../../packages/application/src/authority-resolver.js";
import { makeBindWorkspaceSandboxPolicyHandler } from "../../packages/application/src/commands/bind-workspace-sandbox-policy.js";
import type { DecideSandboxPolicyPreparation } from "../../packages/application/src/commands/decide-sandbox-policy.js";
import {
  type AuthorizeWorkspaceSandboxPayload,
  makeWorkspaceSandboxAuthorizationHandlers,
  type RevokeWorkspaceSandboxAuthorizationPayload,
  type WorkspaceSandboxAuthorizationResult,
} from "../../packages/application/src/commands/workspace-sandbox-authorization.js";
import { semanticRequestFingerprint } from "../../packages/application/src/fingerprint.js";
import {
  CommandGateway,
  CommandGatewayLive,
  CommandHandlerRegistry,
  eraseCommandHandler,
  FenceStopCheck,
} from "../../packages/application/src/gateway.js";
import {
  loadWorkspaceSandboxAuthorizationSnapshot,
  resolveCurrentWorkspaceSandboxAuthorization,
} from "../../packages/application/src/workspace-sandbox-authorization.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  encodeEffectivePolicySummaryV1,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  executionEpisode,
  LeaseGeneration,
  makeProjectPolicy,
  networkBrokerControlsV1ForMode,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  ExecutionRepository,
  SandboxPolicyDecisionStore,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
} from "../../packages/ports/src/index.js";
import {
  type CurrentSchemaTestDatabaseFactory,
  createSchema42TestDatabaseFactory,
} from "../support/schema44-database.js";

export const uuid = (n: number) =>
  `018f2b3c-4d5e-7abc-8def-${String(n).padStart(12, "0")}`;
export const projectId = parse(ProjectId)(`prj_${uuid(1)}`);
export const root = parse(WorkspaceId)(`ws_${uuid(1)}`);
export const child = parse(WorkspaceId)(`ws_${uuid(2)}`);
export const sibling = parse(WorkspaceId)(`ws_${uuid(3)}`);
export const human = parse(Principal)("user:local");
export const agent = parse(Principal)("agent:parent");
export const parentExecution = parse(ExecutionId)(`exe_${uuid(1)}`);
export const now = "2026-11-16T00:00:00Z";
export const humanContext: CommandSubmissionContext = {
  _tag: "External",
  principal: human,
};
export const parentContext: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal: agent,
  executionId: parentExecution,
  fencingGeneration: parse(LeaseGeneration)(1),
};
export const payload = (
  workspaceId = root,
): AuthorizeWorkspaceSandboxPayload => ({
  workspaceId,
  expectedAuthorizationRevision: 0,
  expectedResourceBoundaryRevision: 0,
  expectedWorkspacePolicyRevision: 0,
  profile: "WorkspaceWrite",
  providerId: "linux-bwrap",
  networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
  expiresAt: null,
  source: { kind: "Human" },
});

export let factory: CurrentSchemaTestDatabaseFactory;
beforeAll(async () => {
  factory = await createSchema42TestDatabaseFactory({
    targetSchemaVersion: 56,
    prefix: ".workspace-authority-template-",
  });
}, 120_000);
afterAll(() => factory?.cleanup());

export const seed = (filename: string) => {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO projects (project_id,name,root_workspace_id,project_policy,project_policy_revision,
      default_configuration,environment_ref,lifecycle,revision,created_at,updated_at)
      VALUES (?, 'authorization', ?, '{}', 0, '{}', 'local', 'Open', 0, ?, ?)`).run(
      projectId,
      root,
      now,
      now,
    );
    for (const [index, workspaceId] of [root, child, sibling].entries()) {
      const sessionId = `ses_${uuid(index + 1)}`;
      db.prepare(`INSERT INTO sessions (session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at)
        VALUES (?, 'WorkspacePrimary', ?, NULL, 0, ?)`).run(
        sessionId,
        workspaceId,
        now,
      );
      db.prepare(`INSERT INTO workspaces (workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
        responsibility_revision,resource_boundary,resource_boundary_revision,agent_binding,primary_session_id,
        current_work_id,workspace_policy,workspace_policy_revision,revision,lifecycle,created_at,updated_at)
        VALUES (?, ?, ?, 'authorization', ?, 0, ?, 0, ?, ?, NULL, '{}', 0, 0, 'Active', ?, ?)`).run(
        workspaceId,
        projectId,
        index === 0 ? null : root,
        JSON.stringify({
          purpose: "test",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        }),
        JSON.stringify({ basisResponsibilityRevision: 0, addresses: [] }),
        JSON.stringify({
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId,
        }),
        sessionId,
        now,
        now,
      );
    }
    db.prepare(`INSERT INTO executions (execution_id,project_id,binding_kind,workspace_id,episode_kind,episode_ref,
      episode_revision,parent_execution_id,mission,session_id,admitted_at,stop_requested_at,settlement_kind,settlement_json,settled_at)
      VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`).run(
      parentExecution,
      projectId,
      root,
      `wrk_${uuid(1)}`,
      `ses_${uuid(1)}`,
      now,
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};

export const app = (
  filename: string,
  options: {
    readonly fenceRejected?: boolean;
    readonly now?: string;
    readonly bindingPreparation?: DecideSandboxPolicyPreparation;
  } = {},
) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(
    base,
    ClockTest(options.now ?? now),
    IdGeneratorLive,
  );
  const repos = Layer.provide(
    Layer.mergeAll(
      TransactionPortLive,
      CommandStoreLive,
      DomainEventJournalLive,
      WorkspaceRepositoryLive,
      ExecutionRepositoryLive,
      ProjectRepositoryLive,
      WorkspaceSandboxAuthorizationStoreLive,
      SandboxPolicyDecisionStoreLive,
      PermissionGrantRepositoryLive,
      VerificationRepositoryLive,
      ToolInvocationStoreLive,
    ),
    infra,
  );
  const services = Layer.mergeAll(
    infra,
    repos,
    AuthorityResolverPortLive,
    Layer.succeed(FenceStopCheck, {
      check: () =>
        Effect.succeed(
          options.fenceRejected
            ? ("FencingRejected" as const)
            : ("Pass" as const),
        ),
    }),
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const handlers = makeWorkspaceSandboxAuthorizationHandlers({
          clock: yield* Clock,
          workspaces: yield* WorkspaceRepository,
          executions: yield* ExecutionRepository,
          authorizations: yield* WorkspaceSandboxAuthorizationStore,
        });
        if (options.bindingPreparation !== undefined)
          handlers.push(
            eraseCommandHandler(
              makeBindWorkspaceSandboxPolicyHandler({
                clock: yield* Clock,
                workspaces: yield* WorkspaceRepository,
                executions: yield* ExecutionRepository,
                authorizations: yield* WorkspaceSandboxAuthorizationStore,
                decisions: yield* SandboxPolicyDecisionStore,
                preparation: options.bindingPreparation,
              }),
            ),
          );
        return CommandHandlerRegistry.of({
          lookup: (kind) =>
            Option.fromUndefinedOr(
              handlers.find((h) => h.commandType === kind),
            ),
        });
      }),
    ),
    services,
  );
  const dependencies = Layer.merge(services, registry);
  return Layer.mergeAll(
    dependencies,
    Layer.provide(CommandGatewayLive, dependencies),
    Layer.provide(
      ToolAuthorityResolverLive({
        authenticatedHumans: [human],
        directParentOf: [],
      }),
      dependencies,
    ),
  );
};

export const resolveRequest = (
  id: number,
  request:
    | AuthorizeWorkspaceSandboxPayload
    | RevokeWorkspaceSandboxAuthorizationPayload,
  context: CommandSubmissionContext = humanContext,
  authenticated = true,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    const executions = yield* ExecutionRepository;
    const authorizations = yield* WorkspaceSandboxAuthorizationStore;
    const clock = yield* Clock;
    const resolver = yield* AuthorityResolverPort;
    const envelope = {
      commandId: parse(CommandId)(`cmd_${uuid(id)}`),
      projectId,
      commandType:
        "source" in request
          ? "AuthorizeWorkspaceSandbox"
          : "RevokeWorkspaceSandboxAuthorization",
      actor: parse(Actor)(context.principal),
      issuedAt: "2000-01-01T00:00:00Z",
      payload: request,
    };
    const authority = yield* tx.transact(
      Effect.gen(function* () {
        const workspace = Option.getOrThrow(
          yield* workspaces.findById(request.workspaceId),
        );
        const execution =
          context._tag === "ExecutionOrigin"
            ? yield* executions.findById(context.executionId)
            : Option.none();
        const snapshot = yield* loadWorkspaceSandboxAuthorizationSnapshot(
          { workspaces, authorizations },
          projectId,
          workspace.parentWorkspaceId ?? workspace.workspaceId,
        );
        return yield* resolver.resolve({
          principal: context.principal,
          submissionContext: context,
          envelope,
          semanticRequestFingerprint: semanticRequestFingerprint({
            ...envelope,
            schemaVersion: "1",
          }),
          canonicalFacts: {
            projectId,
            workspace,
            ...(Option.isNone(execution)
              ? {}
              : {
                  execution: {
                    executionId: execution.value.executionId,
                    projectId: execution.value.projectId,
                    workspaceId: execution.value.workspaceId,
                    status: execution.value.state.status,
                    ...(executionEpisode(execution.value) === undefined
                      ? {}
                      : {
                          episodeBinding: executionEpisode(
                            execution.value,
                          ) as NonNullable<ReturnType<typeof executionEpisode>>,
                        }),
                  },
                }),
          },
          grants: [],
          governance: {
            authenticatedHumans: authenticated ? [human] : [],
            directParentOf: [],
          },
          policy: makeProjectPolicy(),
          workspaceSandboxAuthorizationSnapshot: snapshot,
          workspaceSandboxAuthorizationNow: yield* clock.now(),
        });
      }),
    );
    return { envelope, authority, context };
  });
export const execute = (
  id: number,
  request:
    | AuthorizeWorkspaceSandboxPayload
    | RevokeWorkspaceSandboxAuthorizationPayload,
  context: CommandSubmissionContext = humanContext,
) =>
  resolveRequest(id, request, context).pipe(
    Effect.flatMap(({ envelope, authority }) =>
      Effect.flatMap(CommandGateway, (gateway) =>
        gateway.execute<typeof request, WorkspaceSandboxAuthorizationResult>(
          envelope,
          context,
          authority,
        ),
      ),
    ),
  );
export const read = (workspaceId = root, at = now) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    return yield* tx.transact(
      resolveCurrentWorkspaceSandboxAuthorization(
        {
          workspaces: yield* WorkspaceRepository,
          authorizations: yield* WorkspaceSandboxAuthorizationStore,
        },
        { projectId, workspaceId, now: at },
      ),
    );
  });
export const modify = (filename: string, sql: string) => {
  const db = new DatabaseSync(filename);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};
export const withDatabase = async (
  use: (filename: string) => Promise<void>,
) => {
  const fixture = factory.create();
  try {
    await Effect.runPromise(
      Effect.provide(
        runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: fixture.databaseFilename }),
      ),
    );
    seed(fixture.databaseFilename);
    await use(fixture.databaseFilename);
  } finally {
    fixture.cleanup();
  }
};

/** Qualification-only legacy seed: real schema56 FK relationships and a fully
 * decodable V1 receipt, including an inbound provider-unavailable fact. */
export const seedLegacySandboxDecision = (filename: string) => {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    const decisionCommand = parse(CommandId)(`cmd_${uuid(900)}`);
    const grantCommand = parse(CommandId)(`cmd_${uuid(901)}`);
    const episodeBinding = {
      _tag: "InboxEpisode" as const,
      entryKey: "legacy:policy",
      inputKind: "HumanMessage",
    };
    const networkPolicy = {
      version: 1 as const,
      mode: "Disabled" as const,
      destinations: [],
    };
    const snapshot = {
      version: 1 as const,
      kind: "OsEnforced" as const,
      projectId,
      workspaceId: root,
      executionId: parentExecution,
      episodeBinding,
      workspaceRevision: 0,
      resourceBoundaryRevision: 0,
      resourceBoundaryDigest: "a".repeat(64),
      sandboxEnvironmentBasisDigest: "b".repeat(64),
      policyRevision: 1,
      expiresAt: "2026-11-17T00:00:00.000Z",
      profile: "ReadOnly" as const,
      providerId: "bwrap",
      providerVersion: "0.8",
      capabilityRevision: 1,
      osFamily: "Linux" as const,
      osBuild: "linux",
      qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
      networkPolicy,
      networkPolicyDigest: sha256Hex(encodeNetworkPolicyV1(networkPolicy)),
      networkBrokerControls: networkBrokerControlsV1ForMode("Disabled"),
      providerRegistryRevision: 1,
      providerRegistryDigest: "c".repeat(64),
      sandboxHandleBindingDigest: "d".repeat(64),
      mounts: [
        {
          mountId: "workspace",
          targetRef: {
            version: 1 as const,
            kind: "RegionDigest" as const,
            resourceSpace: "filesystem" as const,
            regionIdentityDigest: "e".repeat(64),
          },
          targetIdentityDigest: "f".repeat(64),
          access: "ReadOnly" as const,
        },
      ],
      environmentAllowlist: ["PATH"],
      limits: {
        wallTimeMs: 1000,
        stdoutBytes: 1000,
        stderrBytes: 1000,
        processCount: 1,
        memoryBytes: 1024,
        cpuTimeMs: 1000,
      },
      auditRefs: [],
      authorityBundleRevision: 1,
      authorityBundleDigest: "a".repeat(64),
      operatorConfigRevision: 1,
      operatorConfigDigest: "b".repeat(64),
    };
    const policyDigest = sha256Hex(encodeEffectivePolicySummaryV1(snapshot));
    const result = {
      version: 1 as const,
      commandId: decisionCommand,
      projectId,
      workspaceId: root,
      executionId: parentExecution,
      episodeBinding,
      policyRevision: 1,
      policyDigest,
      effectivePolicySnapshot: snapshot,
    };
    const bytes = encodeSandboxPolicyDecisionCommittedInternalV1(result);
    const grantId = `pgr_${uuid(900)}`;
    for (const [commandId, value] of [
      [grantCommand, '{"state":"Active"}'],
      [decisionCommand, bytes],
    ] as const) {
      db.prepare(`INSERT INTO commands (command_id,project_id,semantic_request_fingerprint,schema_version,
        fingerprint_algorithm_version,resolution,result_json,created_at,settled_at)
        VALUES (?, ?, ?, '1', 1, 'Committed', ?, ?, ?)`).run(
        commandId,
        projectId,
        "a".repeat(64),
        value,
        now,
        now,
      );
    }
    db.prepare(`INSERT INTO permission_grants (permission_grant_id,project_id,scope,issuer,lifetime,state,revision)
      VALUES (?, ?, 'DecideSandboxPolicy', 'user:issuer', 'Bounded', 'Active', 1)`).run(
      grantId,
      projectId,
    );
    db.prepare(
      `INSERT INTO sandbox_policy_grant_issuer_provenance VALUES (?, ?, 'user:issuer', 1, ?)`,
    ).run(grantId, grantCommand, "b".repeat(64));
    db.prepare(`INSERT INTO sandbox_policy_decisions VALUES (?, ?, ?, ?, 1, 0, 0, 'ReadOnly', 'bwrap', ?, ?, ?, ?,
      'user:issuer', 1, ?, 'user:local', ?, ?, ?)`).run(
      projectId,
      root,
      parentExecution,
      encodeExecutionEpisodeBinding(episodeBinding),
      JSON.stringify({ kind: "OsEnforced", policy: networkPolicy }),
      policyDigest,
      grantId,
      grantCommand,
      "b".repeat(64),
      decisionCommand,
      now,
      snapshot.expiresAt,
    );
    db.prepare(`INSERT INTO sandbox_provider_unavailable_facts (attention_fact_id,event_id,project_id,execution_id,workspace_id,
      episode_binding_json,policy_revision,policy_digest,profile_id,provider_id,provider_version,probe_evidence_ref,failure_code,first_detected_at)
      VALUES ('att:legacy-policy', 'evt:legacy-policy', ?, ?, ?, ?, 1, ?, 'ReadOnly', 'bwrap', '0.8', NULL, 'Unavailable', ?)`).run(
      projectId,
      parentExecution,
      root,
      encodeExecutionEpisodeBinding(episodeBinding),
      policyDigest,
      now,
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("COMMIT");
    return {
      snapshot,
      result,
      bytes,
      decisionCommand,
      grantCommand,
      grantId,
      policyDigest,
      episodeBinding,
    };
  } finally {
    db.close();
  }
};
