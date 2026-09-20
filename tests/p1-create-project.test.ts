import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P1_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
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
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";

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

const payloadWith = (basisRevision: number): CreateProjectPayload => ({
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
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(basisRevision),
      addresses: [],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
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
    schemaVersion: "1",
    payload,
  }),
  projectId,
});

const makeApp = () => {
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
      const payload = payloadWith(0);
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

  it("rejects a mismatched basis responsibility revision with AuthorityDenied", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const gw = yield* CommandGateway;
      const payload = payloadWith(1);
      const receipt = yield* gw.execute(
        envelope(payload),
        { _tag: "External", principal },
        authority(payload),
      );
      return { receipt, projects: yield* countRows("projects") };
    });
    const { receipt, projects } = await run(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("AuthorityDenied");
    }
    expect(projects).toBe(0);
  });

  it("replays the existing receipt for the same logical request", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const gw = yield* CommandGateway;
      const payload = payloadWith(0);
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
});
