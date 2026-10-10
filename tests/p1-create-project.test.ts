import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P1_MIGRATIONS,
  P35_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkspaceResourceActivationStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CreateProjectPayload,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  P1CommandHandlerRegistryLive,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  ProjectResourceProfilePort,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
} from "../packages/ports/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const payloadWith = (): CreateProjectPayload => ({
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
    resourceSelection: { _tag: "ConversationOnly" },
    agentBinding: responsibilityBound(workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const envelope = (
  payload: CreateProjectPayload,
): GatewayEnvelope<CreateProjectPayload> => ({
  commandType: "CreateProject",
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const authority = (
  payload: CreateProjectPayload,
): VerifiedCommandAuthority => ({
  _tag: "CreateProjectAuthority",
  principal,
  commandId,
  semanticRequestFingerprint: semanticRequestFingerprint({
    commandType: "CreateProject",
    projectId,
    actor,
    schemaVersion: "2",
    payload,
  }),
  projectId,
});

const profilePort = Layer.succeed(ProjectResourceProfilePort, {
  list: () => Effect.succeed([]),
  resolve: () =>
    Effect.succeed(
      Option.some({
        resourceProfileRef: "test-profile",
        version: "v1",
        displayName: "test",
        available: true as const,
        canonicalAddress: { _tag: "FileTree" as const, path: "C:\\test" },
      }),
    ),
});

const rollbackAfterFirstBody = (): Layer.Layer<
  TransactionPort,
  never,
  SqlClient
> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = (statement: string) =>
        sql.unsafe(statement).pipe(
          Effect.mapError(
            (cause): TransactionOperationalFailure => ({
              _tag: "TransactionOperationalFailure",
              cause,
            }),
          ),
        );
      let rejectFirstSuccessfulBody = true;
      const transact: TransactionPortService["transact"] = (body) =>
        Effect.gen(function* () {
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (Exit.isFailure(exit)) {
            yield* run("ROLLBACK");
            return yield* Effect.failCause(exit.cause);
          }
          if (rejectFirstSuccessfulBody) {
            rejectFirstSuccessfulBody = false;
            yield* run("ROLLBACK");
            return yield* Effect.fail<TransactionOperationalFailure>({
              _tag: "TransactionOperationalFailure",
              cause: "injected pre-commit rollback",
            });
          }
          yield* run("COMMIT");
          return exit.value;
        });
      return TransactionPort.of({ transact });
    }),
  );

const makeApp = (
  transaction?: Layer.Layer<TransactionPort, never, SqlClient>,
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const transactionLayer =
    transaction === undefined
      ? Layer.provide(TransactionPortLive, infra)
      : Layer.provide(transaction, infra);
  const deps = Layer.mergeAll(
    transactionLayer,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
    profilePort,
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

const run = <A>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> => Effect.runPromise(Effect.provide(program, app));

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

describe("P1-010 CreateProject", () => {
  it("creates Project + Root Workspace + Session atomically and emits ordered events", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const gw = yield* CommandGateway;
      const payload = payloadWith();
      const receipt = yield* gw.execute(
        envelope(payload),
        { _tag: "External", principal },
        authority(payload),
      );
      const sql = yield* SqlClient;
      const events = yield* sql.unsafe<{
        event_type: string;
        sequence: number;
      }>("SELECT event_type, sequence FROM domain_events ORDER BY sequence");
      const projects = yield* countRows("projects");
      const workspaces = yield* countRows("workspaces");
      const sessions = yield* countRows("sessions");
      return { receipt, events, projects, workspaces, sessions };
    });
    const { receipt, events, projects, workspaces, sessions } = await run(
      program,
      app,
    );
    expect(receipt.resolution._tag).toBe("Committed");
    if (receipt.resolution._tag === "Committed") {
      expect(receipt.resolution.result).toEqual({
        projectId,
        rootWorkspaceId: workspaceId,
        primarySessionId: sessionId,
      });
    }
    expect(events.map((event) => event.event_type)).toEqual([
      "ProjectCreated",
      "WorkspaceCreated",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(projects).toBe(1);
    expect(workspaces).toBe(1);
    expect(sessions).toBe(1);
  });

  it("replays the existing receipt for the same logical request", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const gw = yield* CommandGateway;
      const payload = payloadWith();
      const first = yield* gw.execute(
        envelope(payload),
        { _tag: "External", principal },
        authority(payload),
      );
      const replay = yield* gw.execute(
        envelope(payload),
        { _tag: "External", principal },
        authority(payload),
      );
      return { first, replay, projects: yield* countRows("projects") };
    });
    const { first, replay, projects } = await run(program, app);
    expect(first.resolution._tag).toBe("Committed");
    expect(replay.resolution._tag).toBe("Committed");
    expect(projects).toBe(1);
  });

  it("rolls back Project, Workspace, Session, receipt, events, and Pending intent together", async () => {
    const app = makeApp(rollbackAfterFirstBody());
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      const gw = yield* CommandGateway;
      const payload: CreateProjectPayload = {
        ...payloadWith(),
        rootWorkspace: {
          ...payloadWith().rootWorkspace,
          resourceSelection: {
            _tag: "Profile",
            resourceProfileRef: "test-profile",
            version: "v1",
          },
        },
      };
      const failed = yield* gw
        .execute(
          envelope(payload),
          { _tag: "External", principal },
          authority(payload),
        )
        .pipe(Effect.flip);
      const projects = yield* countRows("projects");
      const workspaces = yield* countRows("workspaces");
      const sessions = yield* countRows("sessions");
      const receipts = yield* countRows("commands");
      const events = yield* countRows("domain_events");
      const intents = yield* countRows("workspace_resource_activation_intents");
      return {
        failed,
        projects,
        workspaces,
        sessions,
        receipts,
        events,
        intents,
      };
    });
    const result = await run(program, app);
    expect(result.failed).toMatchObject({
      _tag: "TransactionOperationalFailure",
    });
    expect(result).toMatchObject({
      projects: 0,
      workspaces: 0,
      sessions: 0,
      receipts: 0,
      events: 0,
      intents: 0,
    });
  });
});
