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
  type CommandAuthorityRule,
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistryLive,
  FenceStopCheck,
  FenceStopCheckInertLive,
  type FenceStopOutcome,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../src/index.js";

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const otherCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");
const externalContext: CommandSubmissionContext = {
  _tag: "External",
  principal,
};
const executionContext: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal,
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

const fpFor = (payload: unknown) =>
  semanticRequestFingerprint({
    commandType: "TestCommand",
    projectId,
    actor,
    schemaVersion: "1",
    payload,
  });

type CreateProjectAuthority = Extract<
  VerifiedCommandAuthority,
  { _tag: "CreateProjectAuthority" }
>;

const authorityFor = (
  payload: unknown,
  overrides: Partial<CreateProjectAuthority> = {},
): VerifiedCommandAuthority => ({
  _tag: "CreateProjectAuthority",
  principal,
  commandId,
  semanticRequestFingerprint: fpFor(payload),
  projectId,
  ...overrides,
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
  authority: CommandAuthorityRule<unknown> = {
    tag: "CreateProjectAuthority",
    targetMatches: () => true,
  },
): CommandHandler<unknown, { readonly ok: boolean }> => ({
  commandType: "TestCommand",
  schemaVersion: "1",
  authority,
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
      return yield* gw.execute(
        envelope({ x: 1 }),
        externalContext,
        authorityFor({ x: 1 }),
      );
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
      const first = yield* gw.execute(
        envelope({ x: 1 }),
        externalContext,
        authorityFor({ x: 1 }),
      );
      const second = yield* gw.execute(
        envelope({ x: 1 }),
        externalContext,
        authorityFor({ x: 1 }),
      );
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
      yield* gw.execute(
        envelope({ x: 1 }),
        externalContext,
        authorityFor({ x: 1 }),
      );
      return yield* gw.execute(
        envelope({ x: 2 }),
        externalContext,
        authorityFor({ x: 2 }),
      );
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
      return yield* gw.execute(
        envelope({ x: 1 }),
        externalContext,
        authorityFor({ x: 1 }),
      );
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
        return yield* gw.execute(
          envelope({ x: 1 }),
          executionContext,
          authorityFor({ x: 1 }),
        );
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
        .execute(envelope({ x: 1 }), externalContext, authorityFor({ x: 1 }))
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

describe("command authority (P1-DG-11)", () => {
  const runWithAuthority = (
    authority: VerifiedCommandAuthority,
    onExecute?: () => void,
  ) => {
    const { app, state } = buildApp([
      handler(() => ok({ result: { ok: true }, events: [] }), onExecute),
    ]);
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      return yield* gw.execute(envelope({ x: 1 }), externalContext, authority);
    });
    return { app, state, program };
  };

  it("proceeds on an exact authority match", async () => {
    let executions = 0;
    const { app, state, program } = runWithAuthority(
      authorityFor({ x: 1 }),
      () => {
        executions += 1;
      },
    );
    const receipt = await run(program, app);
    expect(receipt.resolution._tag).toBe("Committed");
    expect(executions).toBe(1);
    expect(state.rows.get(commandId)?.resolution._tag).toBe("Committed");
  });

  it("denies a wrong principal, commandId, fingerprint, or kind", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly authority: VerifiedCommandAuthority;
    }> = [
      {
        label: "principal",
        authority: authorityFor(
          { x: 1 },
          { principal: parse(Principal)("user:other") },
        ),
      },
      {
        label: "commandId",
        authority: authorityFor({ x: 1 }, { commandId: otherCommandId }),
      },
      {
        label: "fingerprint",
        authority: authorityFor(
          { x: 1 },
          {
            semanticRequestFingerprint: fpFor({ x: 999 }),
          },
        ),
      },
      {
        label: "kind",
        authority: {
          _tag: "AssignWorkAuthority",
          principal,
          commandId,
          semanticRequestFingerprint: fpFor({ x: 1 }),
          projectId,
          targetWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789ab" as never,
        },
      },
    ];
    for (const { authority } of cases) {
      const { app, state, program } = runWithAuthority(authority);
      const receipt = await run(program, app);
      expect(receipt.resolution._tag).toBe("TerminalRejected");
      if (receipt.resolution._tag === "TerminalRejected") {
        expect(receipt.resolution.error._tag).toBe("AuthorityDenied");
      }
      expect(state.appended).toHaveLength(0);
    }
  });

  it("denies a wrong governance target", async () => {
    const targetAuthority: CommandAuthorityRule<unknown> = {
      tag: "AssignWorkAuthority",
      targetMatches: (authority, payload) =>
        authority._tag === "AssignWorkAuthority" &&
        authority.targetWorkspaceId ===
          (payload as { workspaceId: string }).workspaceId,
    };
    const { app, state } = buildApp([
      handler(
        () => ok({ result: { ok: true }, events: [] }),
        undefined,
        targetAuthority,
      ),
    ]);
    const authority: VerifiedCommandAuthority = {
      _tag: "AssignWorkAuthority",
      principal,
      commandId,
      semanticRequestFingerprint: fpFor({ workspaceId: "ws_A" }),
      projectId,
      targetWorkspaceId: "ws_B" as never,
    };
    const program = Effect.gen(function* () {
      const gw = yield* CommandGateway;
      return yield* gw.execute(
        envelope({ workspaceId: "ws_A" }),
        externalContext,
        authority,
      );
    });
    const receipt = await run(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("AuthorityDenied");
    }
    expect(state.appended).toHaveLength(0);
  });

  it("replays an existing committed receipt even when authority is now absent", async () => {
    let executions = 0;
    const { app, program } = (() => {
      const built = buildApp([
        handler(
          () => ok({ result: { ok: true }, events: [] }),
          () => {
            executions += 1;
          },
        ),
      ]);
      const p = Effect.gen(function* () {
        const gw = yield* CommandGateway;
        const first = yield* gw.execute(
          envelope({ x: 1 }),
          externalContext,
          authorityFor({ x: 1 }),
        );
        const replay = yield* gw.execute(
          envelope({ x: 1 }),
          externalContext,
          authorityFor(
            { x: 1 },
            { principal: parse(Principal)("user:revoked") },
          ),
        );
        return { first, replay };
      });
      return { app: built.app, program: p };
    })();
    const { first, replay } = await run(program, app);
    expect(first.resolution._tag).toBe("Committed");
    expect(replay.resolution._tag).toBe("Committed");
    expect(executions).toBe(1);
  });
});
