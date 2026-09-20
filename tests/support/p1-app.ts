import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  ProjectRepositoryLive,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CreateProjectPayload,
  FenceStopCheckInertLive,
  P1CommandHandlerRegistryLive,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import {
  Actor,
  type CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  type ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  type SessionId,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";

export const testActor = parse(Actor)("user:test");
export const testPrincipal = parse(Principal)("user:test");

export const makeP1App = (
  filename = ":memory:",
): Layer.Layer<CommandGateway | SqlClient> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
  );
  const all = Layer.mergeAll(
    infra,
    deps,
    FenceStopCheckInertLive,
    Layer.provide(P1CommandHandlerRegistryLive, deps),
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<CommandGateway | SqlClient>;
};

export const runP1 = <A>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> => Effect.runPromise(Effect.provide(program, app));

export const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

export const eventTypes = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ event_type: string }>(
    "SELECT event_type FROM domain_events ORDER BY sequence",
  );
  return rows.map((row) => row.event_type);
});

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

export const seedProject = (args: {
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
}) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const payload: CreateProjectPayload = {
      name: "Arbor",
      revision: parse(Revision)(0),
      projectPolicy: makeProjectPolicy(),
      projectPolicyRevision: parse(Revision)(0),
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: args.rootWorkspaceId,
      primarySession: {
        sessionId: args.sessionId,
        contextEpoch: parse(ContextEpochNumber)(0),
      },
      rootWorkspace: {
        name: "root",
        responsibilityDefinition: definition,
        responsibilityRevision: parse(ResponsibilityRevision)(0),
        resourceBoundary: {
          basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
          addresses: [],
        },
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
        agentBinding: responsibilityBound(args.rootWorkspaceId),
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
      },
    };
    const authority: VerifiedCommandAuthority = {
      _tag: "CreateProjectAuthority",
      principal: testPrincipal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "CreateProject",
        projectId: args.projectId,
        actor: testActor,
        schemaVersion: "1",
        payload,
      }),
      projectId: args.projectId,
    };
    return yield* gateway.execute(
      {
        commandType: "CreateProject",
        commandId: args.commandId,
        projectId: args.projectId,
        actor: testActor,
        issuedAt: "t",
        payload,
      },
      { _tag: "External", principal: testPrincipal },
      authority,
    );
  });
