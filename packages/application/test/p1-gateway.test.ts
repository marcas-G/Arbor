import {
  Actor,
  CommandId,
  type CommandReceipt,
  type CommandSubmissionContext,
  type DomainError,
  type DomainResult,
  ExecutionId,
  err,
  LeaseGeneration,
  ok,
  Principal,
  ProjectId,
  parse,
} from "@arbor/domain";
import {
  Clock,
  type ClockService,
  CommandStore,
  type CommandStoreService,
  DomainEventJournal,
  type DomainEventJournalService,
  IdGenerator,
  type IdGeneratorService,
  type PendingDomainEvent,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistryLive,
  FenceStopCheck,
  FenceStopCheckInertLive,
  type FenceStopOutcome,
  type GatewayEnvelope,
  semanticRequestFingerprint,
} from "../src/index.js";

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:test");
const externalContext: CommandSubmissionContext = {
  _tag: "External",
  principal: parse(Principal)("user:test"),
};
const executionContext: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal: parse(Principal)("user:test"),
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789ab"),
  fencingGeneration: parse(LeaseGeneration)(1),
};

const envelope = (payload: unknown): GatewayEnvelope<unknown> => ({
  commandType: "TestCommand",
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

interface FakeState {
  readonly rows: Map<string, CommandReceipt<unknown, unknown>>;
  readonly attempts: Array<{
    readonly commandId: string;
    readonly outcome: string;
  }>;
  readonly appended: PendingDomainEvent[];
}

const TransactionPortLive: Layer.Layer<TransactionPort> = Layer.succeed(
  TransactionPort,
  {
    transact: (body) =>
      Effect.provideService(body, TransactionScope, { session: { id: "tx" } }),
  },
);

const buildApp = (
  handlers: ReadonlyArray<CommandHandler<unknown, unknown>>,
  fence: Layer.Layer<FenceStopCheck> = FenceStopCheckInertLive,
  transaction: Layer.Layer<TransactionPort> = TransactionPortLive,
): { readonly app: Layer.Layer<CommandGateway>; readonly state: FakeState } => {
  const state: FakeState = {
    rows: new Map(),
    attempts: [],
    appended: [],
  };
  const store: CommandStoreService = {
    findResolution: (id) =>
      Effect.sync(() =>
        state.rows.has(id)
          ? Option.some(state.rows.get(id) as CommandReceipt<unknown, unknown>)
          : Option.none(),
      ),
    insertCommitted: (
      id,
      project,
      fingerprint,
      schemaVersion,
      algorithmVersion,
      resultJson,
    ) =>
      Effect.sync(() => {
        state.rows.set(id, {
          commandId: id,
          projectId: project,
          semanticRequestFingerprint: fingerprint,
          schemaVersion,
          fingerprintAlgorithmVersion: algorithmVersion,
          resolution: { _tag: "Committed", result: JSON.parse(resultJson) },
          createdAt: "t",
          settledAt: "t",
        });
      }),
    insertTerminalRejected: (
      id,
      project,
      fingerprint,
      schemaVersion,
      algorithmVersion,
      terminalJson,
    ) =>
      Effect.sync(() => {
        state.rows.set(id, {
          commandId: id,
          projectId: project,
          semanticRequestFingerprint: fingerprint,
          schemaVersion,
          fingerprintAlgorithmVersion: algorithmVersion,
          resolution: {
            _tag: "TerminalRejected",
            error: JSON.parse(terminalJson),
          },
          createdAt: "t",
          settledAt: "t",
        });
      }),
    recordResolvingAttempt: (id, outcome) =>
      Effect.sync(() => {
        state.attempts.push({ commandId: id, outcome });
      }),
    recordRetryableAttempt: (id, failureKind) =>
      Effect.sync(() => {
        state.attempts.push({
          commandId: id,
          outcome: `Retryable:${failureKind}`,
        });
      }),
  };
  const journal: DomainEventJournalService = {
    append: (drafts) =>
      Effect.sync(() => {
        state.appended.push(...drafts);
      }),
    readAfter: () => Effect.succeed([]),
    lastSequence: () => Effect.succeed(0),
  };
  let clockTick = 0;
  const clock: ClockService = {
    now: () => Effect.sync(() => `t${clockTick++}`),
  };
  let idTick = 0;
  const ids: IdGeneratorService = {
    generate: <T>(_kind: string) => Effect.sync(() => `evt_${idTick++}` as T),
  };
  const deps = Layer.mergeAll(
    transaction,
    Layer.succeed(CommandStore, store),
    Layer.succeed(DomainEventJournal, journal),
    Layer.succeed(Clock, clock),
    Layer.succeed(IdGenerator, ids),
    CommandHandlerRegistryLive(handlers),
    fence,
  );
  const app = Layer.mergeAll(
    deps,
    Layer.provide(CommandGatewayLive, deps),
  ) as Layer.Layer<CommandGateway>;
  return { app, state };
};

const handler = (
  behaviour: (payload: unknown) => DomainResult<{
    result: { readonly ok: boolean };
    events: ReadonlyArray<PendingDomainEvent>;
  }>,
  onExecute?: () => void,
): CommandHandler<unknown, { readonly ok: boolean }> => ({
  commandType: "TestCommand",
  schemaVersion: "1",
  execute: (env) =>
    Effect.sync(() => {
      onExecute?.();
      return behaviour(env.payload);
    }),
});

const fenceLive = (outcome: FenceStopOutcome): Layer.Layer<FenceStopCheck> =>
  Layer.succeed(FenceStopCheck, { check: () => Effect.succeed(outcome) });

const run = <A>(
  program: Effect.Effect<A, unknown, CommandGateway>,
  app: Layer.Layer<CommandGateway>,
): Promise<A> => Effect.runPromise(Effect.provide(program, app));

describe("semantic request fingerprint", () => {
  it("is stable under key reorder and changes on semantic change", () => {
    const base = {
      commandType: "TestCommand",
      projectId: projectId as string,
      actor: actor as string,
      schemaVersion: "1",
      payload: { a: 1, b: { c: 2, d: [3, 4] } },
    };
    expect(semanticRequestFingerprint(base)).toBe(
      semanticRequestFingerprint({
        ...base,
        payload: { b: { d: [3, 4], c: 2 }, a: 1 },
      }),
    );
    expect(semanticRequestFingerprint(base)).not.toBe(
      semanticRequestFingerprint({
        ...base,
        payload: { a: 1, b: { c: 2, d: [3, 5] } },
      }),
    );
    expect(semanticRequestFingerprint(base)).not.toBe(
      semanticRequestFingerprint({ ...base, actor: "user:other" }),
    );
  });
});

describe("command gateway", () => {
  it("commits, appends events, and records a resolving attempt", async () => {
    const events: PendingDomainEvent[] = [
      {
        projectId,
        eventType: "ProjectCreated",
        eventVersion: 1,
        occurredAt: "t",
        aggregateRef: projectId,
        actor,
        payload: {},
      },
    ];
    const { app, state } = buildApp([
      handler(() => ok({ result: { ok: true }, events })),
    ]);
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      return yield* gw.execute(envelope({ x: 1 }), externalContext);
    });
    const receipt = await run(program, app);
    expect(receipt.resolution._tag).toBe("Committed");
    expect(state.appended).toHaveLength(1);
    expect(state.attempts).toEqual([{ commandId, outcome: "Committed" }]);
  });

  it("returns the existing receipt for the same fingerprint without re-executing", async () => {
    let executions = 0;
    const { app } = buildApp([
      handler(
        () => ok({ result: { ok: true }, events: [] }),
        () => {
          executions += 1;
        },
      ),
    ]);
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      const first = yield* gw.execute(envelope({ x: 1 }), externalContext);
      const second = yield* gw.execute(envelope({ x: 1 }), externalContext);
      return { first, second };
    });
    const { first, second } = await run(program, app);
    expect(first.resolution._tag).toBe("Committed");
    expect(second.resolution._tag).toBe("Committed");
    expect(executions).toBe(1);
  });

  it("rejects an idempotency conflict without overwriting the row", async () => {
    const { app, state } = buildApp([
      handler(() => ok({ result: { ok: true }, events: [] })),
    ]);
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      yield* gw.execute(envelope({ x: 1 }), externalContext);
      return yield* gw.execute(envelope({ x: 2 }), externalContext);
    });
    const receipt = await run(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("IdempotencyConflict");
    }
    expect(state.rows.get(commandId)?.resolution._tag).toBe("Committed");
  });

  it("persists a terminal rejection with no event", async () => {
    const { app, state } = buildApp([
      handler(() =>
        err({
          _tag: "AuthorityDenied",
          reason: "no authority",
        } as DomainError),
      ),
    ]);
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      return yield* gw.execute(envelope({ x: 1 }), externalContext);
    });
    const receipt = await run(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    expect(state.appended).toHaveLength(0);
    expect(state.attempts).toEqual([
      { commandId, outcome: "TerminalRejected" },
    ]);
  });

  it("distinguishes FencingRejected from ExecutionStopping via the hook", async () => {
    for (const outcome of ["FencingRejected", "ExecutionStopping"] as const) {
      const { app, state } = buildApp(
        [handler(() => ok({ result: { ok: true }, events: [] }))],
        fenceLive(outcome),
      );
      const program = Effect.gen(function* () {
        const gw = yield* CommandGateway;
        return yield* gw.execute(envelope({ x: 1 }), executionContext);
      });
      const receipt = await run(program, app);
      expect(receipt.resolution._tag).toBe("TerminalRejected");
      if (receipt.resolution._tag === "TerminalRejected") {
        expect(receipt.resolution.error._tag).toBe(outcome);
      }
      expect(state.appended).toHaveLength(0);
    }
  });

  it("produces no receipt on a transaction operational failure", async () => {
    let calls = 0;
    const flaky: Layer.Layer<TransactionPort> = Layer.succeed(TransactionPort, {
      transact: (body) => {
        calls += 1;
        if (calls === 1) {
          return Effect.fail({
            _tag: "TransactionOperationalFailure",
            cause: "busy",
          });
        }
        return Effect.provideService(body, TransactionScope, {
          session: { id: "tx" },
        });
      },
    });
    const { app, state } = buildApp(
      [handler(() => ok({ result: { ok: true }, events: [] }))],
      FenceStopCheckInertLive,
      flaky,
    );
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      return yield* gw
        .execute(envelope({ x: 1 }), externalContext)
        .pipe(Effect.flip);
    });
    const failure = await run(program, app);
    expect((failure as { _tag: string })._tag).toBe(
      "TransactionOperationalFailure",
    );
    expect(state.rows.size).toBe(0);
    expect(state.attempts).toEqual([
      { commandId, outcome: "Retryable:TransactionOperationalFailure" },
    ]);
  });
});
