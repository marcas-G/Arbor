import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  P6_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeSteerWorkHandler,
  type SteerWorkPayload,
} from "../packages/application/src/commands/steer-work.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  CommandGatewayLive,
  type CommandGatewayService,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  Principal,
  parse,
  Revision,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  InboxProjectionStore,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
} from "./support/p6-app.js";

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c1");
const unknownWorkId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ff");
const otherWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
);
const agentPrincipal = parse(Principal)("agent:bot");
const agentActor = parse(Actor)("agent:bot");
const assignCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const steerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const criticalCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b2",
);
const rejectCommandIds = [
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c2",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c3",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c4",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c5",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c6",
].map((id) => parse(CommandId)(id)) as ReadonlyArray<CommandId>;

const SteerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | InboxProjectionStore
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const inbox = yield* InboxProjectionStore;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
      makeSteerWorkHandler({ works, inbox }) as unknown as CommandHandler<
        unknown,
        unknown
      >,
    ];
    return CommandHandlerRegistry.of({
      lookup: (commandType) => {
        const handler = handlers.find(
          (candidate) => candidate.commandType === commandType,
        );
        return handler === undefined ? Option.none() : Option.some(handler);
      },
    });
  }),
);

/** Self-contained SteerWork harness (p6-app.ts assembly copied; that file is
 * frozen for this task). Fixed clock keeps replayed receipts byte-identical. */
const makeSteerApp = (
  filename = ":memory:",
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | InboxProjectionStore
  | WorkRepository
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const registry = Layer.provide(
    SteerRegistryLive,
    Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
      Layer.provide(InboxProjectionStoreLive, infra),
    ),
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<
    | CommandGateway
    | SqlClient
    | TransactionPort
    | InboxProjectionStore
    | WorkRepository
  >;
};

const runSteer = <A, R>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient | R>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, unknown, CommandGateway | SqlClient>,
        app,
      ),
    ),
  );

const assignWorkPayload: AssignWorkPayload = {
  workId,
  workspaceId: p6RootWorkspace,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship human steer",
  why: "P6-011",
  constraints: [],
  completionExpectation: "green",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

const seedWork = Effect.gen(function* () {
  yield* runMigrations(P6_MIGRATIONS);
  yield* p6SeedProject;
  const gw = yield* CommandGateway;
  const receipt = yield* gw.execute(
    {
      commandType: "AssignWork",
      commandId: assignCommandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload: assignWorkPayload,
    },
    { _tag: "External", principal: p6TestPrincipal },
    {
      _tag: "AssignWorkAuthority",
      principal: p6TestPrincipal,
      commandId: assignCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AssignWork",
        projectId: p6Project,
        actor: p6TestActor,
        schemaVersion: "1",
        payload: assignWorkPayload,
      }),
      projectId: p6Project,
      targetWorkspaceId: p6RootWorkspace,
    },
  );
  if (receipt.resolution._tag !== "Committed") {
    return yield* Effect.die(new Error("seed AssignWork did not commit"));
  }
});

const steerPayload = (
  overrides: Partial<SteerWorkPayload> = {},
): SteerWorkPayload => ({
  workId,
  workspaceId: p6RootWorkspace,
  steer: { severity: "Normal", guidance: "cnt-steer-guidance-001" },
  expectedWorkRevision: parse(WorkRevision)(0),
  provenance: { source: "HumanInput" },
  ...overrides,
});

const submitSteer = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: SteerWorkPayload;
    readonly principal?: Principal;
    readonly actor?: Actor;
    readonly authorityTargetWorkspaceId?: WorkspaceId;
  },
) => {
  const actor = args.actor ?? p6TestActor;
  const principal = args.principal ?? p6TestPrincipal;
  const envelope: GatewayEnvelope<SteerWorkPayload> = {
    commandType: "SteerWork",
    commandId: args.commandId,
    projectId: p6Project,
    actor,
    issuedAt: "t",
    payload: args.payload,
  };
  const authority: VerifiedCommandAuthority = {
    _tag: "SteerWorkAuthority",
    principal,
    commandId: args.commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "SteerWork",
      projectId: p6Project,
      actor,
      schemaVersion: "1",
      payload: args.payload,
    }),
    projectId: p6Project,
    targetWorkspaceId:
      args.authorityTargetWorkspaceId ?? args.payload.workspaceId,
    workId: args.payload.workId,
  };
  return gw.execute(envelope, { _tag: "External", principal }, authority);
};

const workRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{ lifecycle: string; revision: number }>(
    "SELECT lifecycle, revision FROM works WHERE work_id = ?",
    [workId],
  );
});

const steeredEvents = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ payload_json: string }>(
    "SELECT payload_json FROM domain_events WHERE event_type = 'WorkSteered'",
  );
  return rows.map((row) => JSON.parse(row.payload_json));
});

const inboxEntries = Effect.gen(function* () {
  const inbox = yield* InboxProjectionStore;
  const tx = yield* TransactionPort;
  return yield* tx.transact(inbox.listUnconsumed(p6RootWorkspace));
});

describe("p6-steer", () => {
  it("human Normal steer commits: revision 0→1, WorkSteered event, one HumanInput inbox entry", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const gw = yield* CommandGateway;
      const receipt = yield* submitSteer(gw, {
        commandId: steerCommandId,
        payload: steerPayload(),
      });
      return {
        receipt,
        work: yield* workRow,
        events: yield* steeredEvents,
        entries: yield* inboxEntries,
      };
    });
    const result = await runSteer(program, makeSteerApp());
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.work[0]?.lifecycle).toBe("Open");
    expect(result.work[0]?.revision).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      workId,
      fromRevision: 0,
      toRevision: 1,
      severity: "Normal",
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe("HumanInput");
    expect(result.entries[0]?.entryKey).toBe(`steer:${workId}:1`);
    expect(result.entries[0]?.summary).toContain("Normal");
  });

  it("severity=Critical commits identically (quiescence wiring is a later task)", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const gw = yield* CommandGateway;
      const receipt = yield* submitSteer(gw, {
        commandId: criticalCommandId,
        payload: steerPayload({
          steer: { severity: "Critical", guidance: "cnt-steer-guidance-002" },
        }),
      });
      return { receipt, work: yield* workRow, events: yield* steeredEvents };
    });
    const result = await runSteer(program, makeSteerApp());
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.work[0]?.revision).toBe(1);
    expect(result.events[0]?.severity).toBe("Critical");
  });

  it("rejects the frozen rejection table (04 §2)", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const gw = yield* CommandGateway;
      const notFound = yield* submitSteer(gw, {
        commandId: rejectCommandIds[0]!,
        payload: steerPayload({ workId: unknownWorkId }),
      });
      const wrongWorkspace = yield* submitSteer(gw, {
        commandId: rejectCommandIds[1]!,
        payload: steerPayload({ workspaceId: otherWorkspace }),
        authorityTargetWorkspaceId: otherWorkspace,
      });
      const staleRevision = yield* submitSteer(gw, {
        commandId: rejectCommandIds[2]!,
        payload: steerPayload({
          expectedWorkRevision: parse(WorkRevision)(5),
        }),
      });
      const agent = yield* submitSteer(gw, {
        commandId: rejectCommandIds[3]!,
        payload: steerPayload(),
        principal: agentPrincipal,
        actor: agentActor,
      });
      const nonTarget = yield* submitSteer(gw, {
        commandId: rejectCommandIds[4]!,
        payload: steerPayload(),
        authorityTargetWorkspaceId: otherWorkspace,
      });
      return { notFound, wrongWorkspace, staleRevision, agent, nonTarget };
    });
    const result = await runSteer(program, makeSteerApp());
    expect(result.notFound.resolution._tag).toBe("TerminalRejected");
    if (result.notFound.resolution._tag === "TerminalRejected") {
      expect(result.notFound.resolution.error._tag).toBe("WorkNotFound");
    }
    expect(result.wrongWorkspace.resolution._tag).toBe("TerminalRejected");
    if (result.wrongWorkspace.resolution._tag === "TerminalRejected") {
      expect(result.wrongWorkspace.resolution.error._tag).toBe("WorkNotFound");
    }
    expect(result.staleRevision.resolution._tag).toBe("TerminalRejected");
    if (result.staleRevision.resolution._tag === "TerminalRejected") {
      expect(result.staleRevision.resolution.error._tag).toBe(
        "RevisionConflict",
      );
    }
    expect(result.agent.resolution._tag).toBe("TerminalRejected");
    if (result.agent.resolution._tag === "TerminalRejected") {
      expect(result.agent.resolution.error._tag).toBe("AuthorityDenied");
    }
    expect(result.nonTarget.resolution._tag).toBe("TerminalRejected");
    if (result.nonTarget.resolution._tag === "TerminalRejected") {
      expect(result.nonTarget.resolution.error._tag).toBe("AuthorityDenied");
    }
  });

  it("replaying the same commandId returns the same Committed receipt without further mutation", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const gw = yield* CommandGateway;
      const payload = steerPayload();
      const first = yield* submitSteer(gw, {
        commandId: steerCommandId,
        payload,
      });
      const replay = yield* submitSteer(gw, {
        commandId: steerCommandId,
        payload,
      });
      return {
        first,
        replay,
        work: yield* workRow,
        events: yield* steeredEvents,
        entries: yield* inboxEntries,
      };
    });
    const result = await runSteer(program, makeSteerApp());
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.replay).toEqual(result.first);
    expect(result.work[0]?.revision).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
  });
});
