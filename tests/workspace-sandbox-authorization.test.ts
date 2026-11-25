import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "../adapters/persistence-sqlite/src/index.js";
import { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION } from "../adapters/persistence-sqlite/src/p57-workspace-sandbox-authorization-migration.js";
import { buildSingleWorkspaceLayer } from "../apps/single-workspace/src/composition.js";
import { allocateWorkspaceSandboxHandler } from "../apps/single-workspace/src/control-actions.js";
import { ToolAuthorityResolverLive } from "../apps/single-workspace/src/tool-authority-resolver.js";
import { makeExternalSubmissionFromServices } from "../apps/single-workspace/src/transport/composition.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../packages/application/src/authority-resolver.js";
import {
  type BindWorkspaceSandboxPolicyPayload,
  makeBindWorkspaceSandboxPolicyHandler,
} from "../packages/application/src/commands/bind-workspace-sandbox-policy.js";
import type { DecideSandboxPolicyPreparation } from "../packages/application/src/commands/decide-sandbox-policy.js";
import {
  type AuthorizeWorkspaceSandboxPayload,
  makeWorkspaceSandboxAuthorizationHandlers,
  type RevokeWorkspaceSandboxAuthorizationPayload,
  type WorkspaceSandboxAuthorizationResult,
} from "../packages/application/src/commands/workspace-sandbox-authorization.js";
import { semanticRequestFingerprint } from "../packages/application/src/fingerprint.js";
import {
  CommandGateway,
  CommandGatewayLive,
  CommandHandlerRegistry,
  eraseCommandHandler,
  FenceStopCheck,
} from "../packages/application/src/gateway.js";
import {
  loadWorkspaceSandboxAuthorizationSnapshot,
  resolveCurrentWorkspaceSandboxAuthorization,
} from "../packages/application/src/workspace-sandbox-authorization.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  encodeEffectivePolicySummaryV1,
  encodeEffectivePolicySummaryV2,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  executionEpisode,
  LeaseGeneration,
  makeProjectPolicy,
  networkBrokerControlsV1ForMode,
  networkBrokerControlsV2ForMode,
  Principal,
  ProjectId,
  parse,
  providerTurnInferenceId,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
  type WorkspaceSandboxAuthorization,
} from "../packages/domain/dist/index.js";
import {
  Clock,
  CommandStore,
  ExecutionRepository,
  ProjectionQueryPort,
  SandboxPolicyDecisionStore,
  sha256Hex,
  ToolAuthorityResolver,
  ToolInvocationStore,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
} from "../packages/ports/src/index.js";
import {
  type CurrentSchemaTestDatabaseFactory,
  createSchema42TestDatabaseFactory,
} from "./support/schema44-database.js";

const uuid = (n: number) =>
  `018f2b3c-4d5e-7abc-8def-${String(n).padStart(12, "0")}`;
const projectId = parse(ProjectId)(`prj_${uuid(1)}`);
const root = parse(WorkspaceId)(`ws_${uuid(1)}`);
const child = parse(WorkspaceId)(`ws_${uuid(2)}`);
const sibling = parse(WorkspaceId)(`ws_${uuid(3)}`);
const human = parse(Principal)("user:local");
const agent = parse(Principal)("agent:parent");
const parentExecution = parse(ExecutionId)(`exe_${uuid(1)}`);
const now = "2026-11-16T00:00:00Z";
const humanContext: CommandSubmissionContext = {
  _tag: "External",
  principal: human,
};
const parentContext: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal: agent,
  executionId: parentExecution,
  fencingGeneration: parse(LeaseGeneration)(1),
};
const payload = (workspaceId = root): AuthorizeWorkspaceSandboxPayload => ({
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

let factory: CurrentSchemaTestDatabaseFactory;
beforeAll(async () => {
  factory = await createSchema42TestDatabaseFactory({
    targetSchemaVersion: 56,
    prefix: ".workspace-authority-template-",
  });
}, 120_000);
afterAll(() => factory?.cleanup());

const seed = (filename: string) => {
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

const app = (
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

const resolveRequest = (
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
const execute = (
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
const read = (workspaceId = root, at = now) =>
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
const modify = (filename: string, sql: string) => {
  const db = new DatabaseSync(filename);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};
const withDatabase = async (use: (filename: string) => Promise<void>) => {
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

describe("Workspace sandbox authorization Gateway and SQLite", () => {
  it("routes model allocation through Gateway and replays its receipt after Child revocation/ref changes without restoring authority", async () =>
    withDatabase(async (filename) => {
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      let refAvailable = true;
      const allocate = (position: number) =>
        Effect.gen(function* () {
          const executions = yield* ExecutionRepository;
          const tx = yield* TransactionPort;
          const execution = Option.getOrThrow(
            yield* tx.transact(executions.findById(parentExecution)),
          );
          const handler = allocateWorkspaceSandboxHandler({
            gateway: yield* CommandGateway,
            commandHandlerRegistry: yield* CommandHandlerRegistry,
            commandReceipts: yield* CommandStore,
            workspaces: yield* WorkspaceRepository,
            authorizations: yield* WorkspaceSandboxAuthorizationStore,
            clock: yield* Clock,
            tx,
            placement: {
              resolveChildRef: (_parent: typeof root, ref: string) =>
                Effect.succeed(
                  refAvailable && ref === "wref_child"
                    ? Option.some({
                        _tag: "ResolvedChildPlacementRef",
                        projectId,
                        targetWorkspaceId: child,
                        targetWorkspaceRevision: 0,
                        refEncodingVersion: 1,
                      })
                    : Option.none(),
                ),
            } as never,
          });
          return yield* handler.handle({
            execution,
            context: parentContext,
            action: {
              _tag: "AllocateWorkspaceSandbox",
              targetWorkspaceRef: "wref_child",
              profile: "WorkspaceWrite",
              networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
              expiresAt: null,
            },
            invocation: {
              providerTurnId: providerTurnInferenceId(parentExecution, 0),
              outputPosition: position,
              callRef: `allocation-${position}`,
              toolName: "allocate_workspace_sandbox",
              argumentsJson: "{}",
            },
          });
        });
      await expect(
        Effect.runPromise(Effect.provide(allocate(0), app(filename))),
      ).resolves.toMatchObject({ _tag: "Observation" });
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toMatchObject({
        _tag: "Authorized",
        authorization: { origin: { kind: "Parent", parentWorkspaceId: root } },
      });
      await Effect.runPromise(
        Effect.provide(
          execute(11, { workspaceId: child, expectedAuthorizationRevision: 1 }),
          app(filename),
        ),
      );
      refAvailable = false;
      await expect(
        Effect.runPromise(Effect.provide(allocate(0), app(filename))),
      ).resolves.toMatchObject({ _tag: "Observation" });
      await expect(
        Effect.runPromise(Effect.provide(allocate(1), app(filename))),
      ).rejects.toMatchObject({ _tag: "AgentActionRejected" });
      refAvailable = true;
      await expect(
        Effect.runPromise(Effect.provide(allocate(2), app(filename))),
      ).rejects.toMatchObject({ _tag: "AgentActionRejected" });
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toMatchObject({ _tag: "Denied", reason: "Revoked" });
      await Effect.runPromise(
        Effect.provide(
          execute(12, { ...payload(child), expectedAuthorizationRevision: 2 }),
          app(filename),
        ),
      );
      await expect(
        Effect.runPromise(Effect.provide(allocate(3), app(filename))),
      ).resolves.toMatchObject({ _tag: "Observation" });
    }));

  it("retains a human Child revocation across reopening and Parent reallocation, until a human authorizes it again", async () =>
    withDatabase(async (filename) => {
      const childRequest = {
        ...payload(child),
        source: {
          kind: "Parent" as const,
          expectedParentAuthorizationRevision: 1,
        },
      };
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      await Effect.runPromise(
        Effect.provide(execute(11, childRequest, parentContext), app(filename)),
      );
      expect(
        await Effect.runPromise(
          Effect.provide(
            execute(12, {
              workspaceId: child,
              expectedAuthorizationRevision: 1,
            }),
            app(filename),
          ),
        ),
      ).toMatchObject({ resolution: { _tag: "Committed" } });
      // A current, valid Parent and a freshly resolved request with the exact
      // revoked head are insufficient. This is not merely a stale CAS denial.
      for (const command of [13, 14]) {
        expect(
          await Effect.runPromise(
            Effect.provide(
              execute(
                command,
                { ...childRequest, expectedAuthorizationRevision: 2 },
                parentContext,
              ),
              app(filename),
            ),
          ),
        ).toMatchObject({
          resolution: {
            _tag: "TerminalRejected",
            error: {
              _tag: "AuthorityDenied",
              reason:
                "Human Workspace revocation requires a new human authorization",
            },
          },
        });
        expect(
          await Effect.runPromise(Effect.provide(read(child), app(filename))),
        ).toEqual({ _tag: "Denied", reason: "Revoked" });
      }
      expect(
        await Effect.runPromise(
          Effect.provide(
            execute(15, {
              ...payload(child),
              expectedAuthorizationRevision: 2,
            }),
            app(filename),
          ),
        ),
      ).toMatchObject({
        resolution: {
          _tag: "Committed",
          result: {
            authorization: {
              authorizationRevision: 3,
              origin: { kind: "Human", principal: human },
            },
          },
        },
      });
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toMatchObject({ _tag: "Authorized" });
    }));

  it.each([
    "schema_version='unknown'",
    "fingerprint_algorithm_version=2",
    "project_id='foreign-project'",
    "resolution='TerminalRejected',terminal_error_json='{}',result_json=NULL",
    "result_json=json_set(result_json,'$.extra',1)",
  ])(
    "reports a corrupt exact receipt rather than falling back: %s",
    async (patch) =>
      withDatabase(async (filename) => {
        await Effect.runPromise(
          Effect.provide(execute(10, payload()), app(filename)),
        );
        modify(
          filename,
          `UPDATE commands SET ${patch} WHERE command_id='cmd_${uuid(10)}'`,
        );
        await expect(
          Effect.runPromise(Effect.provide(read(), app(filename))),
        ).rejects.toMatchObject({ _tag: "PersistenceCorruption" });
      }),
  );

  it("returns a typed append conflict without replacing a current head", async () =>
    withDatabase(async (filename) => {
      const result = await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      if (result.resolution._tag !== "Committed")
        throw new Error("test grant denied");
      const record = {
        ...result.resolution.result.authorization,
        commandId: parse(CommandId)(`cmd_${uuid(11)}`),
      };
      const staleAppend = Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* WorkspaceSandboxAuthorizationStore;
        return yield* tx.transact(store.appendCommitted(record));
      });
      await expect(
        Effect.runPromise(Effect.provide(staleAppend, app(filename))),
      ).rejects.toMatchObject({
        _tag: "WorkspaceSandboxAuthorizationStoreRevisionConflict",
      });
      expect(
        await Effect.runPromise(Effect.provide(read(), app(filename))),
      ).toMatchObject({ authorization: { authorizationRevision: 1 } });
    }));

  it("commits exact receipt/event/fact, replays without a new revision, reopens and remains valid across tasks", async () =>
    withDatabase(async (filename) => {
      const first = await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      expect(first.resolution._tag).toBe("Committed");
      const replay = await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      expect(replay).toEqual(first);
      modify(filename, "UPDATE workspaces SET revision = revision + 9");
      expect(
        await Effect.runPromise(
          Effect.provide(read(root, "2036-11-16T00:00:00Z"), app(filename)),
        ),
      ).toMatchObject({
        _tag: "Authorized",
        authorization: {
          authorizationRevision: 1,
          actorPrincipal: human,
          recordedAt: now,
          expiresAt: null,
        },
      });
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT count(*) AS n FROM workspace_sandbox_authorizations",
            )
            .get(),
        ).toMatchObject({ n: 1 });
        expect(
          db
            .prepare(
              "SELECT count(*) AS n FROM domain_events WHERE event_type='WorkspaceSandboxAuthorizationChanged'",
            )
            .get(),
        ).toMatchObject({ n: 1 });
      } finally {
        db.close();
      }
    }));

  it("accepts the exact CreateProject v2 receipt that initialized the Workspace authorization", async () =>
    withDatabase(async (filename) => {
      const first = await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      if (first.resolution._tag !== "Committed")
        throw new Error("setup authorization denied");
      const db = new DatabaseSync(filename);
      try {
        db.prepare(
          "UPDATE commands SET schema_version = '2', result_json = ? WHERE command_id = ?",
        ).run(
          JSON.stringify({
            projectId,
            rootWorkspaceId: root,
            primarySessionId: parse(SessionId)(`ses_${uuid(1)}`),
            workspaceAuthorization: first.resolution.result.authorization,
          }),
          first.commandId,
        );
      } finally {
        db.close();
      }
      expect(
        await Effect.runPromise(Effect.provide(read(), app(filename))),
      ).toMatchObject({
        _tag: "Authorized",
        authorization: {
          commandId: first.commandId,
          origin: { kind: "Human" },
        },
      });
    }));

  it("allocates only explicitly to the direct Child, survives Parent execution settlement, and stops after Parent revocation", async () =>
    withDatabase(async (filename) => {
      const childPayload = {
        ...payload(child),
        source: {
          kind: "Parent" as const,
          expectedParentAuthorizationRevision: 1,
        },
      };
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      expect(
        await Effect.runPromise(
          Effect.provide(
            execute(11, childPayload, parentContext),
            app(filename),
          ),
        ),
      ).toMatchObject({ resolution: { _tag: "Committed" } });
      expect(
        await Effect.runPromise(Effect.provide(read(sibling), app(filename))),
      ).toMatchObject({ _tag: "Denied" });
      modify(
        filename,
        `UPDATE executions SET settled_at='${now}',settlement_kind='Completed',settlement_json='{}'`,
      );
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toMatchObject({ _tag: "Authorized" });
      expect(
        await Effect.runPromise(
          Effect.provide(
            execute(12, {
              workspaceId: root,
              expectedAuthorizationRevision: 1,
            }),
            app(filename),
          ),
        ),
      ).toMatchObject({ resolution: { _tag: "Committed" } });
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toMatchObject({ _tag: "Denied" });
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT count(*) AS n FROM workspace_sandbox_authorizations",
            )
            .get(),
        ).toMatchObject({ n: 3 });
      } finally {
        db.close();
      }
    }));

  it("rejects anonymous human authority and current-Workspace allocation pretending to be direct Parent", async () =>
    withDatabase(async (filename) => {
      await expect(
        Effect.runPromise(
          Effect.provide(
            resolveRequest(10, payload(), humanContext, false),
            app(filename),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "NoApplicableGrant" });
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      await expect(
        Effect.runPromise(
          Effect.provide(
            execute(
              11,
              {
                ...payload(root),
                source: {
                  kind: "Parent",
                  expectedParentAuthorizationRevision: 1,
                },
              },
              parentContext,
            ),
            app(filename),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "NoApplicableGrant" });
    }));

  it("rereads Parent source and target resource revisions inside the Gateway transaction", async () =>
    withDatabase(async (filename) => {
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      const request = await Effect.runPromise(
        Effect.provide(
          resolveRequest(
            11,
            {
              ...payload(child),
              source: {
                kind: "Parent",
                expectedParentAuthorizationRevision: 1,
              },
            },
            parentContext,
          ),
          app(filename),
        ),
      );
      await Effect.runPromise(
        Effect.provide(
          execute(12, { ...payload(), expectedAuthorizationRevision: 1 }),
          app(filename),
        ),
      );
      const denied = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(CommandGateway, (gateway) =>
            gateway.execute(
              request.envelope,
              request.context,
              request.authority,
            ),
          ),
          app(filename),
        ),
      );
      expect(denied).toMatchObject({
        resolution: {
          _tag: "TerminalRejected",
          error: { _tag: "AuthorityDenied" },
        },
      });
      const other = await Effect.runPromise(
        Effect.provide(resolveRequest(13, payload(sibling)), app(filename)),
      );
      modify(
        filename,
        `UPDATE workspaces SET resource_boundary_revision=1 WHERE workspace_id='${sibling}'`,
      );
      expect(
        await Effect.runPromise(
          Effect.provide(
            Effect.flatMap(CommandGateway, (gateway) =>
              gateway.execute(other.envelope, other.context, other.authority),
            ),
            app(filename),
          ),
        ),
      ).toMatchObject({
        resolution: {
          _tag: "TerminalRejected",
          error: { _tag: "AuthorityDenied" },
        },
      });
    }));

  it("rejects wider Child capability and fenced Parent writes", async () =>
    withDatabase(async (filename) => {
      await Effect.runPromise(
        Effect.provide(
          execute(10, {
            ...payload(),
            profile: "ReadOnly",
            networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
          }),
          app(filename),
        ),
      );
      const request = {
        ...payload(child),
        source: {
          kind: "Parent" as const,
          expectedParentAuthorizationRevision: 1,
        },
      };
      expect(
        await Effect.runPromise(
          Effect.provide(execute(11, request, parentContext), app(filename)),
        ),
      ).toMatchObject({
        resolution: {
          _tag: "TerminalRejected",
          error: { _tag: "AuthorityDenied" },
        },
      });
      expect(
        await Effect.runPromise(
          Effect.provide(
            execute(
              12,
              {
                ...request,
                profile: "ReadOnly",
                networkPolicy: {
                  version: 1,
                  mode: "Disabled",
                  destinations: [],
                },
              },
              parentContext,
            ),
            app(filename, { fenceRejected: true }),
          ),
        ),
      ).toMatchObject({
        resolution: {
          _tag: "TerminalRejected",
          error: { _tag: "FencingRejected" },
        },
      });
      expect(
        await Effect.runPromise(Effect.provide(read(child), app(filename))),
      ).toMatchObject({ _tag: "Denied" });
    }));

  it("serializes competing current-head replacements across independent SQLite connections", async () =>
    withDatabase(async (filename) => {
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      const outcomes = await Promise.all(
        [11, 12].map((id) =>
          Effect.runPromise(
            Effect.provide(
              execute(id, { ...payload(), expectedAuthorizationRevision: 1 }),
              app(filename),
            ),
          ),
        ),
      );
      expect(outcomes.map((outcome) => outcome.resolution._tag).sort()).toEqual(
        ["Committed", "TerminalRejected"],
      );
      expect(
        await Effect.runPromise(Effect.provide(read(), app(filename))),
      ).toMatchObject({
        _tag: "Authorized",
        authorization: { authorizationRevision: 2 },
      });
    }));

  it("refuses mutation and deletion of retained facts and rejects corruption of the exact receipt", async () =>
    withDatabase(async (filename) => {
      await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      expect(() =>
        modify(
          filename,
          "UPDATE workspace_sandbox_authorizations SET state='Revoked'",
        ),
      ).toThrow();
      expect(() =>
        modify(filename, "DELETE FROM workspace_sandbox_authorizations"),
      ).toThrow();
      // A matching Workspace/revision alone cannot prove the full selected scope.
      modify(
        filename,
        `UPDATE commands SET result_json=json_set(result_json,'$.authorization.profile','ReadOnly') WHERE command_id='cmd_${uuid(10)}'`,
      );
      await expect(
        Effect.runPromise(Effect.provide(read(), app(filename))),
      ).rejects.toMatchObject({ _tag: "PersistenceCorruption" });
    }));

  it("rolls back the fact when its deferred receipt is absent", async () =>
    withDatabase(async (filename) => {
      const valid = await Effect.runPromise(
        Effect.provide(execute(10, payload()), app(filename)),
      );
      if (valid.resolution._tag !== "Committed")
        throw new Error("setup authorization denied");
      const record: WorkspaceSandboxAuthorization = {
        ...valid.resolution.result.authorization,
        authorizationRevision: 2,
        commandId: parse(CommandId)(`cmd_${uuid(11)}`),
      };
      const append = Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* WorkspaceSandboxAuthorizationStore;
        return yield* tx.transact(store.appendCommitted(record));
      });
      await expect(
        Effect.runPromise(Effect.provide(append, app(filename))),
      ).rejects.toMatchObject({ _tag: "TransactionOperationalFailure" });
      expect(
        await Effect.runPromise(Effect.provide(read(), app(filename))),
      ).toMatchObject({ authorization: { authorizationRevision: 1 } });
    }));
});

/** Qualification-only legacy seed: real schema56 FK relationships and a fully
 * decodable V1 receipt, including an inbound provider-unavailable fact. */
const seedLegacySandboxDecision = (filename: string) => {
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

describe("staged schema57 provenance migration", () => {
  const migrate = (filename: string) =>
    Effect.runPromise(
      Effect.provide(
        runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename }),
      ),
    );
  it("preserves populated legacy decisions, exact receipt bytes and inbound fact foreign keys", async () => {
    const fixture = factory.create();
    try {
      seed(fixture.databaseFilename);
      const legacy = seedLegacySandboxDecision(fixture.databaseFilename);
      const before = new DatabaseSync(fixture.databaseFilename);
      const originalRow = before
        .prepare("SELECT * FROM sandbox_policy_decisions")
        .get();
      const originalFact = before
        .prepare("SELECT * FROM sandbox_provider_unavailable_facts")
        .get();
      before.close();
      await migrate(fixture.databaseFilename);
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        expect(
          db.prepare("SELECT * FROM sandbox_policy_decisions").get(),
        ).toEqual({
          ...originalRow,
          authority_kind: "LegacyHumanGrant",
          workspace_authorization_revision: null,
        });
        expect(
          db.prepare("SELECT * FROM sandbox_provider_unavailable_facts").get(),
        ).toEqual(originalFact);
        expect(
          db
            .prepare("SELECT result_json FROM commands WHERE command_id = ?")
            .get(legacy.decisionCommand),
        ).toEqual({ result_json: legacy.bytes });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(() =>
          db.exec(
            "UPDATE sandbox_policy_decisions SET actor_principal = 'user:other'",
          ),
        ).toThrow(/immutable/);
        expect(() => db.exec("DELETE FROM sandbox_policy_decisions")).toThrow(
          /retained/,
        );
      } finally {
        db.close();
      }
      const base = layer({ filename: fixture.databaseFilename });
      const services = Layer.mergeAll(
        base,
        Layer.provide(TransactionPortLive, base),
        Layer.provide(SandboxPolicyDecisionStoreLive, base),
      );
      const read = () =>
        Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const tx = yield* TransactionPort;
              const store = yield* SandboxPolicyDecisionStore;
              return yield* tx.transact(
                store.findCurrentForExecution(projectId, root, parentExecution),
              );
            }),
            services,
          ),
        );
      expect(Option.getOrThrow(await read()).result).toEqual(legacy.result);
      // Reopening the adapter still reads the same exact committed bytes.
      expect(
        Option.getOrThrow(await read()).decision.authorityKind,
      ).toBeUndefined();
      await Effect.runPromise(
        Effect.provide(execute(906, payload()), app(fixture.databaseFilename)),
      );
      const constraints = new DatabaseSync(fixture.databaseFilename);
      try {
        constraints.exec("PRAGMA foreign_keys = ON");
        const insert =
          constraints.prepare(`INSERT INTO sandbox_policy_decisions (
          project_id,workspace_id,execution_id,episode_binding_json,policy_revision,expected_execution_revision,expected_policy_revision,
          profile_id,provider_id,network_policy_json,policy_digest,permission_grant_id,grant_permission_command_id,grant_issuer_principal,
          operator_config_revision,operator_config_digest,actor_principal,decision_command_id,issued_at,expires_at,
          authority_kind,workspace_authorization_revision)
          SELECT project_id,workspace_id,execution_id,episode_binding_json,2,expected_execution_revision,1,
            ?,provider_id,network_policy_json,policy_digest,?,NULL,NULL,
            operator_config_revision,operator_config_digest,'system:workspace-policy',?,issued_at,expires_at,?,?
          FROM sandbox_policy_decisions WHERE policy_revision = 1`);
        for (const values of [
          ["ReadOnly", null, legacy.grantCommand, "WorkspaceAuthorization", 99],
          [
            "FullAccess",
            null,
            legacy.grantCommand,
            "WorkspaceAuthorization",
            1,
          ],
          [
            "ReadOnly",
            legacy.grantId,
            legacy.grantCommand,
            "WorkspaceAuthorization",
            1,
          ],
          ["ReadOnly", null, legacy.grantCommand, "LegacyHumanGrant", 1],
          ["ReadOnly", null, legacy.grantCommand, "Unknown", 1],
        ] as const)
          expect(() => insert.run(...values)).toThrow();
        // A real same-Workspace revision succeeds; rollback keeps this a
        // constraint qualification rather than manufacturing a usable receipt.
        constraints.exec("BEGIN");
        insert.run(
          "ReadOnly",
          null,
          legacy.grantCommand,
          "WorkspaceAuthorization",
          1,
        );
        expect(constraints.prepare("PRAGMA foreign_key_check").all()).toEqual(
          [],
        );
        constraints.exec("ROLLBACK");
      } finally {
        constraints.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("rolls back the entire rebuild and schema version when existing foreign keys are broken", async () => {
    const fixture = factory.create();
    try {
      seed(fixture.databaseFilename);
      seedLegacySandboxDecision(fixture.databaseFilename);
      const corrupt = new DatabaseSync(fixture.databaseFilename);
      corrupt.exec("PRAGMA foreign_keys = OFF; DELETE FROM commands");
      corrupt.close();
      await expect(migrate(fixture.databaseFilename)).rejects.toBeDefined();
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        expect(db.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 56,
        });
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name IN ('workspace_sandbox_authorizations', 'sandbox_policy_decisions_0057')",
            )
            .all(),
        ).toEqual([]);
        expect(
          (
            db.prepare("PRAGMA table_info(sandbox_policy_decisions)").all() as {
              name: string;
            }[]
          ).some((c) => c.name === "authority_kind"),
        ).toBe(false);
        expect(
          db
            .prepare("SELECT COUNT(*) AS n FROM sandbox_policy_decisions")
            .get(),
        ).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("staged Workspace policy Gateway integration", () => {
  it("atomically commits and replays a V3 policy, and denies an already-resolved request after human revocation", async () => {
    const fixture = factory.create();
    try {
      seed(fixture.databaseFilename);
      const legacy = seedLegacySandboxDecision(fixture.databaseFilename);
      await Effect.runPromise(
        Effect.provide(
          runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
            allowOfflineOnly: true,
          }),
          layer({ filename: fixture.databaseFilename }),
        ),
      );
      const execution = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const repo = yield* ExecutionRepository;
            return Option.getOrThrow(
              yield* tx.transact(repo.findById(parentExecution)),
            );
          }),
          app(fixture.databaseFilename),
        ),
      );
      const episodeBinding = executionEpisode(execution);
      if (episodeBinding === undefined)
        throw new Error("seeded execution must have an exact episode");
      const host = {
        authorityBundleRevision: 1,
        authorityBundleDigest: "a".repeat(64),
        operatorConfigRevision: 1,
        operatorConfigDigest: "b".repeat(64),
        providerRegistryRevision: 1,
        providerRegistryDigest: "c".repeat(64),
      };
      const request: BindWorkspaceSandboxPolicyPayload = {
        projectId,
        workspaceId: root,
        executionId: parentExecution,
        episodeBinding,
        expectedEpisodeRevision: 0,
        expectedPolicyRevision: 1,
        expectedAuthorizationRevision: 1,
        expectedWorkspaceRevision: 0,
        expectedResourceBoundaryRevision: 0,
        expectedSandboxHandleBindingDigest: "d".repeat(64),
        expectedAuthorityBundleRevision: host.authorityBundleRevision,
        expectedAuthorityBundleDigest: host.authorityBundleDigest,
        expectedOperatorConfigRevision: host.operatorConfigRevision,
        expectedOperatorConfigDigest: host.operatorConfigDigest,
        expectedProviderRegistryRevision: host.providerRegistryRevision,
        expectedProviderRegistryDigest: host.providerRegistryDigest,
        profile: "ReadOnly",
        providerId: "linux-bwrap",
        providerVersion: "0.8",
        capabilityRevision: 1,
        networkPolicy: {
          kind: "OsEnforced",
          policy: legacy.snapshot.networkPolicy,
        },
        decisionExpiresAt: legacy.snapshot.expiresAt,
      };
      // Synthetic host preparation is intentional at this layer: this proves
      // Gateway/SQLite integrity, not an installed native sandbox journey.
      const summary = JSON.parse(
        encodeEffectivePolicySummaryV2({
          ...legacy.snapshot,
          version: 2,
          providerId: "linux-bwrap",
          episodeBinding,
          policyRevision: 2,
          networkBrokerControls: networkBrokerControlsV2ForMode("Disabled"),
        }),
      );
      const preparation: DecideSandboxPolicyPreparation = {
        prepare: () => Effect.succeed(summary),
        preIntentSourceStaleField: () => Effect.succeed(undefined),
        currentPreconditions: () =>
          Effect.succeed({
            kind: "OsEnforced",
            expectedEpisodeRevision: 0,
            latestCommittedPolicyRevision: 1,
            episodeBinding,
            workspaceRevision: 0,
            resourceBoundaryRevision: 0,
            sandboxHandleBindingDigest: "d".repeat(64),
            ...host,
          }),
      };
      const services = app(fixture.databaseFilename, {
        bindingPreparation: preparation,
      });
      await Effect.runPromise(
        Effect.provide(
          execute(902, {
            ...payload(),
            profile: "ReadOnly",
            networkPolicy: legacy.snapshot.networkPolicy,
          }),
          services,
        ),
      );
      const system = parse(Principal)("system:workspace-policy");
      const context = {
        _tag: "System" as const,
        principal: system,
        causationRef: `workspace-policy:${parentExecution}`,
      };
      const resolve = (n: number, payload: BindWorkspaceSandboxPolicyPayload) =>
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const workspaces = yield* WorkspaceRepository;
          const authorizations = yield* WorkspaceSandboxAuthorizationStore;
          const resolver = yield* AuthorityResolverPort;
          const envelope = {
            commandType: "BindWorkspaceSandboxPolicy",
            commandId: parse(CommandId)(`cmd_${uuid(n)}`),
            projectId,
            actor: parse(Actor)(system),
            issuedAt: now,
            causationRef: context.causationRef,
            payload,
          };
          const authority = yield* tx.transact(
            Effect.gen(function* () {
              const snapshot = yield* loadWorkspaceSandboxAuthorizationSnapshot(
                { workspaces, authorizations },
                projectId,
                root,
              );
              return yield* resolver.resolve({
                principal: system,
                submissionContext: context,
                envelope,
                semanticRequestFingerprint: semanticRequestFingerprint({
                  ...envelope,
                  schemaVersion: "1",
                }),
                canonicalFacts: {
                  projectId,
                  workspace: Option.getOrThrow(
                    Option.fromUndefinedOr(snapshot.workspaces[0]),
                  ),
                  execution: {
                    executionId: parentExecution,
                    projectId,
                    workspaceId: root,
                    status: "Active",
                    episodeRevision: 0,
                    episodeBinding,
                  },
                },
                grants: [],
                governance: {
                  authenticatedHumans: [human],
                  directParentOf: [],
                },
                policy: makeProjectPolicy(),
                workspaceSandboxAuthorizationSnapshot: snapshot,
                workspaceSandboxAuthorizationNow: now,
                workspaceSandboxPolicyHostSnapshot: host,
              });
            }),
          );
          return { envelope, authority };
        });
      const resolved = await Effect.runPromise(
        Effect.provide(resolve(903, request), services),
      );
      const submit = () =>
        Effect.runPromise(
          Effect.provide(
            Effect.flatMap(CommandGateway, (gateway) =>
              gateway.execute(resolved.envelope, context, resolved.authority),
            ),
            services,
          ),
        );
      const receipt = await submit();
      expect(receipt.resolution).toMatchObject({ _tag: "Committed" });
      expect(await submit()).toEqual(receipt);
      const waiting = await Effect.runPromise(
        Effect.provide(
          resolve(905, { ...request, expectedPolicyRevision: 2 }),
          services,
        ),
      );
      await Effect.runPromise(
        Effect.provide(
          execute(904, { workspaceId: root, expectedAuthorizationRevision: 1 }),
          services,
        ),
      );
      const denied = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(CommandGateway, (gateway) =>
            gateway.execute(waiting.envelope, context, waiting.authority),
          ),
          services,
        ),
      );
      expect(denied.resolution).toMatchObject({
        _tag: "TerminalRejected",
        error: { _tag: "AuthorityDenied" },
      });
      // Open a fresh connection/adapter and validate the retained joined receipt.
      const joined = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const store = yield* SandboxPolicyDecisionStore;
            return Option.getOrThrow(
              yield* tx.transact(
                store.findCurrentForExecution(projectId, root, parentExecution),
              ),
            );
          }),
          app(fixture.databaseFilename),
        ),
      );
      expect(joined.result).toMatchObject({
        version: 3,
        workspaceAuthorizationRevision: 1,
        policyRevision: 2,
      });
      expect(joined.decision).toMatchObject({
        authorityKind: "WorkspaceAuthorization",
        actorPrincipal: system,
      });
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          db
            .prepare("SELECT COUNT(*) AS n FROM sandbox_policy_decisions")
            .get(),
        ).toEqual({ n: 2 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded' AND event_version = 2",
            )
            .get(),
        ).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("ordinary Workspace authorization submission", () => {
  it("uses one real local human and retains authorization/revocation across production Layer reopenings", async () => {
    const fixture = factory.create();
    try {
      seed(fixture.databaseFilename);
      await Effect.runPromise(
        Effect.provide(
          runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
            allowOfflineOnly: true,
          }),
          layer({ filename: fixture.databaseFilename }),
        ),
      );
      const open = () =>
        buildSingleWorkspaceLayer({
          databaseFile: fixture.databaseFilename,
          governance: { authenticatedHumans: [human], directParentOf: [] },
        });
      const send = (
        n: number,
        commandType:
          | "AuthorizeWorkspaceSandbox"
          | "RevokeWorkspaceSandboxAuthorization",
        commandPayload: unknown,
      ) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const submission = yield* makeExternalSubmissionFromServices({
                  authenticatedHumans: [human],
                  directParentOf: [],
                });
                return yield* submission.submit(human, humanContext, {
                  commandType,
                  commandId: `cmd_${uuid(n)}`,
                  projectId,
                  actor: human,
                  issuedAt: now,
                  payload: commandPayload,
                });
              }),
              open(),
            ),
          ),
        );
      expect(
        await send(950, "AuthorizeWorkspaceSandbox", payload()),
      ).toMatchObject({
        ok: true,
        body: {
          resolution: "Committed",
          result: {
            authorization: {
              authorizationRevision: 1,
              state: "Granted",
              origin: { kind: "Human", principal: human },
            },
          },
        },
      });
      const read = () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const queries = yield* ProjectionQueryPort;
                return yield* queries.query("workspace-detail", {
                  workspaceId: root,
                });
              }),
              open(),
            ),
          ),
        );
      expect(await read()).toMatchObject({
        value: {
          workspaceSandboxAuthorization: {
            expectedAuthorizationRevision: 1,
            current: { state: "Granted", expiresAt: null },
          },
        },
      });
      expect(
        await send(951, "RevokeWorkspaceSandboxAuthorization", {
          workspaceId: root,
          expectedAuthorizationRevision: 1,
        }),
      ).toMatchObject({
        ok: true,
        body: {
          resolution: "Committed",
          result: {
            authorization: { authorizationRevision: 2, state: "Revoked" },
          },
        },
      });
      expect(await read()).toMatchObject({
        value: {
          workspaceSandboxAuthorization: {
            expectedAuthorizationRevision: 2,
            current: { state: "Revoked" },
          },
        },
      });
      expect(
        await send(952, "AuthorizeWorkspaceSandbox", {
          ...payload(),
          expectedAuthorizationRevision: 2,
        }),
      ).toMatchObject({
        ok: true,
        body: {
          resolution: "Committed",
          result: {
            authorization: { authorizationRevision: 3, state: "Granted" },
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});

describe("Workspace authorization at tool effect admission", () => {
  const resolveTool = (
    workspaceId: typeof root,
    name: "write" | "shell" | "read",
    principal: typeof human | typeof agent = human,
  ) =>
    Effect.gen(function* () {
      const resolver = yield* ToolAuthorityResolver;
      return yield* resolver.resolve({
        intent: {
          invocationId: parse(ToolInvocationId)(`tin_${uuid(980)}`),
          callRef: "call:workspace-ceiling",
          toolName: name,
          toolVersion: "1",
          argumentsJson: "{}",
          approvalId: null,
        },
        definition: {
          name,
          version: "1",
          hash: "h",
          description: name,
          inputSchemaJson: "{}",
          resultSchemaJson: "{}",
          source: "Builtin",
          capabilityMetadata: [
            name === "write"
              ? "fs:write"
              : name === "shell"
                ? "shell:exec"
                : "fs:read",
          ],
          sideEffectSemantics: name === "read" ? "ReadOnly" : "NonIdempotent",
        },
        context: {
          projectId,
          workspaceId,
          executionId: parentExecution,
          sessionId: parse(SessionId)(`ses_${uuid(1)}`),
          authenticatedPrincipal: principal,
          actor: parse(Actor)(principal),
          executionFence: {
            executionId: parentExecution,
            workerId: "worker:admission",
            workerIncarnationId: "incarnation:admission",
            fencingGeneration: parse(LeaseGeneration)(1),
          },
          controlBasisDigest: "b".repeat(64),
          requestedAt: now,
        },
        regions: [],
        now,
      });
    });
  it("uses the current Workspace baseline as agent fs:write and shell:exec authority", async () =>
    withDatabase(async (filename) => {
      const services = app(filename);
      const run = <A, E>(
        effect: Effect.Effect<A, E, Layer.Success<typeof services>>,
      ) => Effect.runPromise(Effect.provide(effect, services));
      await run(execute(969, payload()));
      expect(
        (await run(resolveTool(root, "write", agent))).allowedCapabilities,
      ).toEqual(["fs:write"]);
      expect(
        (await run(resolveTool(root, "shell", agent))).allowedCapabilities,
      ).toEqual(["shell:exec"]);
    }));

  it("keeps reads available but blocks writes after ReadOnly or user revocation, including a previously resolved write", async () =>
    withDatabase(async (filename) => {
      const services = app(filename);
      const run = <A, E>(
        effect: Effect.Effect<A, E, Layer.Success<typeof services>>,
      ) => Effect.runPromise(Effect.provide(effect, services));
      await run(execute(970, payload()));
      const writable = await run(resolveTool(root, "write"));
      expect(writable.allowedCapabilities).toContain("fs:write");
      expect(writable.workspaceSandboxSources?.[0]?.authorizationRevision).toBe(
        1,
      );
      modify(
        filename,
        `INSERT INTO execution_leases (execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at)
        VALUES ('${parentExecution}','worker:admission','incarnation:admission',1,'2999-01-01T00:00:00.000Z','${now}')`,
      );
      const invocationId = parse(ToolInvocationId)(`tin_${uuid(980)}`);
      const fence = {
        executionId: parentExecution,
        workerId: "worker:admission",
        workerIncarnationId: "incarnation:admission",
        fencingGeneration: parse(LeaseGeneration)(1),
      };
      await run(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          yield* tx.transact(
            store.recordIntent(
              {
                invocationId,
                executionId: parentExecution,
                workspaceId: root,
                toolName: "write",
                toolVersion: "1",
                sideEffectSemantics: "NonIdempotent",
                argumentsJson: "{}",
                resolvedRegions: [],
                approvalId: null,
                intentAt: now,
              },
              fence,
              now,
            ),
          );
        }),
      );
      await run(
        execute(971, { workspaceId: root, expectedAuthorizationRevision: 1 }),
      );
      expect(
        await run(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const store = yield* ToolInvocationStore;
            return yield* tx.transact(
              store.admitEffect(invocationId, writable, now, fence),
            );
          }),
        ),
      ).toMatchObject({
        _tag: "Denied",
        reasonCode: "InvocationAuthorityDenied",
      });
      expect(
        await run(Effect.result(resolveTool(root, "write"))),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ToolAuthorityDenied" },
      });
      expect(
        (await run(resolveTool(root, "read"))).allowedCapabilities,
      ).toEqual(["fs:read"]);
      await run(
        execute(972, {
          ...payload(),
          expectedAuthorizationRevision: 2,
          profile: "ReadOnly",
        }),
      );
      expect(
        await run(Effect.result(resolveTool(root, "write"))),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ToolAuthorityDenied" },
      });
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT effect_admission_state FROM tool_invocations WHERE invocation_id=?",
            )
            .get(invocationId),
        ).toEqual({ effect_admission_state: "NotAdmitted" });
      } finally {
        db.close();
      }
    }));

  it("rejects stale shell authority after an intervening network restriction and denies a Child after Parent revocation", async () =>
    withDatabase(async (filename) => {
      const services = app(filename);
      const run = <A, E>(
        effect: Effect.Effect<A, E, Layer.Success<typeof services>>,
      ) => Effect.runPromise(Effect.provide(effect, services));
      await run(execute(973, payload()));
      await run(
        execute(
          974,
          {
            ...payload(child),
            source: { kind: "Parent", expectedParentAuthorizationRevision: 1 },
          },
          parentContext,
        ),
      );
      const shellAuthority = await run(resolveTool(root, "shell"));
      expect(
        (await run(resolveTool(child, "shell"))).workspaceSandboxSources,
      ).toHaveLength(2);
      modify(
        filename,
        `INSERT INTO execution_leases (execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at)
        VALUES ('${parentExecution}','worker:admission','incarnation:admission',1,'2999-01-01T00:00:00.000Z','${now}')`,
      );
      const invocationId = parse(ToolInvocationId)(`tin_${uuid(981)}`);
      const fence = {
        executionId: parentExecution,
        workerId: "worker:admission",
        workerIncarnationId: "incarnation:admission",
        fencingGeneration: parse(LeaseGeneration)(1),
      };
      await run(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          yield* tx.transact(
            store.recordIntent(
              {
                invocationId,
                executionId: parentExecution,
                workspaceId: root,
                toolName: "shell",
                toolVersion: "1",
                sideEffectSemantics: "NonIdempotent",
                argumentsJson: "{}",
                resolvedRegions: [],
                approvalId: null,
                intentAt: now,
              },
              fence,
              now,
            ),
          );
        }),
      );
      await run(
        execute(975, {
          ...payload(),
          expectedAuthorizationRevision: 1,
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
        }),
      );
      expect(
        await run(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const store = yield* ToolInvocationStore;
            return yield* tx.transact(
              store.admitEffect(
                invocationId,
                { ...shellAuthority, toolName: "shell" },
                now,
                fence,
              ),
            );
          }),
        ),
      ).toMatchObject({
        _tag: "Denied",
        reasonCode: "InvocationAuthorityDenied",
      });
      expect(
        await run(Effect.result(resolveTool(child, "shell"))),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ToolAuthorityDenied" },
      });
      await run(
        execute(976, { workspaceId: root, expectedAuthorizationRevision: 2 }),
      );
      expect(
        await run(Effect.result(resolveTool(child, "write"))),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ToolAuthorityDenied" },
      });
    }));
});
