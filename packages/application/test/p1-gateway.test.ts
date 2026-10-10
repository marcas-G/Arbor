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
  ProjectRepository,
  type ProjectRepositoryService,
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
  projectAdmissionOf,
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

const envelope = (
  payload: unknown,
  commandType = "TestCommand",
): GatewayEnvelope<unknown> => ({
  commandType,
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const fpFor = (payload: unknown, commandType = "TestCommand") =>
  semanticRequestFingerprint({
    commandType,
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
  commandType = "TestCommand",
): VerifiedCommandAuthority => ({
  _tag: "CreateProjectAuthority",
  principal,
  commandId,
  semanticRequestFingerprint: fpFor(payload, commandType),
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
  projectLifecycle: "Open" | "Closed" = "Open",
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
    appendReturningIds: () => Effect.succeed([]),
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
    Layer.succeed(ProjectRepository, {
      findById: () =>
        Effect.succeed(Option.some({ lifecycle: projectLifecycle } as never)),
    } as unknown as ProjectRepositoryService),
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
  commandType = "TestCommand",
): CommandHandler<unknown, { readonly ok: boolean }> => ({
  commandType,
  schemaVersion: "1",
  authority,
  stopAdmission: { _tag: "Unclassified" },
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

describe("typed internal command input validation", () => {
  it.each<CommandSubmissionContext>([
    { _tag: "System", principal, causationRef: "test" },
    executionContext,
    { _tag: "RecoveryController", principal, causationRef: "test" },
  ])(
    "rejects malformed internal payloads before Gateway effects (%s)",
    async (context) => {
      let transactionCalls = 0;
      let fenceCalls = 0;
      let handlerCalls = 0;
      const transaction = Layer.succeed(TransactionPort, {
        transact: (body) =>
          Effect.suspend(() => {
            transactionCalls++;
            return Effect.provideService(body, TransactionScope, {
              session: { id: "tx" },
            });
          }),
      });
      const app = buildApp(
        [
          handler(
            () => ok({ result: { ok: true }, events: [] }),
            () => handlerCalls++,
            undefined,
            "SubmitHumanMessage",
          ),
        ],
        Layer.succeed(FenceStopCheck, {
          check: () =>
            Effect.sync(() => {
              fenceCalls++;
              return "Pass";
            }),
        }),
        transaction,
      );
      const malformed = {
        messageId: undefined,
        targetWorkspaceId: "ws_018f1f62-7b3c-7abc-8def-0123456789ab",
        bodyRef: "body-ref",
      };

      const result = await run(
        Effect.match(
          Effect.gen(function* () {
            const gateway = yield* CommandGateway;
            return yield* gateway.execute(
              envelope(malformed, "SubmitHumanMessage"),
              context,
              authorityFor(malformed, {}, "SubmitHumanMessage"),
            );
          }),
          {
            onFailure: (error) => ({ _tag: "Left" as const, error }),
            onSuccess: (value) => ({ _tag: "Right" as const, value }),
          },
        ),
        app.app,
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.error).toMatchObject({
          _tag: "InternalCommandContractDefect",
          commandType: "SubmitHumanMessage",
          issues: [{ path: ["messageId"], rule: "type" }],
        });
      }
      expect(transactionCalls).toBe(0);
      expect(fenceCalls).toBe(0);
      expect(handlerCalls).toBe(0);
      expect(app.state.rows.size).toBe(0);
      expect(app.state.attempts).toEqual([]);
      expect(app.state.appended).toEqual([]);
    },
  );

  it("continues a valid typed internal payload through the Gateway", async () => {
    let handlerCalls = 0;
    const payload = {
      messageId: "msg_018f1f62-7b3c-7abc-8def-0123456789ab",
      targetWorkspaceId: "ws_018f1f62-7b3c-7abc-8def-0123456789ab",
      bodyRef: "body-ref",
    };
    const app = buildApp([
      handler(
        () => ok({ result: { ok: true }, events: [] }),
        () => handlerCalls++,
        undefined,
        "SubmitHumanMessage",
      ),
    ]);

    const result = await run(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* gateway.execute(
          envelope(payload, "SubmitHumanMessage"),
          { _tag: "System", principal, causationRef: "test" },
          authorityFor(payload, {}, "SubmitHumanMessage"),
        );
      }),
      app.app,
    );

    expect(result.resolution._tag).toBe("Committed");
    expect(handlerCalls).toBe(1);
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

  it("preserves the original transaction failure when attempt tracing also fails", async () => {
    const unavailable: Layer.Layer<TransactionPort> = Layer.succeed(
      TransactionPort,
      {
        transact: () =>
          Effect.fail({
            _tag: "TransactionOperationalFailure",
            cause: "database unavailable",
          }),
      },
    );
    const { app, state } = buildApp(
      [handler(() => ok({ result: { ok: true }, events: [] }))],
      FenceStopCheckInertLive,
      unavailable,
    );
    const failure = await run(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* gateway
          .execute(envelope({ x: 1 }), externalContext, authorityFor({ x: 1 }))
          .pipe(Effect.flip);
      }),
      app,
    );

    expect(failure).toEqual({
      _tag: "TransactionOperationalFailure",
      cause: "database unavailable",
    });
    expect(state.rows.size).toBe(0);
    expect(state.attempts).toEqual([]);
  });

  it("propagates a normalized handler repository failure as a typed failure", async () => {
    const repositoryFailure = {
      _tag: "PersistenceUnavailable" as const,
      repository: "DependencyRepository" as const,
      operation: "test",
      retryDisposition: "retryable" as const,
      sourceTag: "InjectedFailure",
      cause: "database unavailable",
    };
    const failingHandler: CommandHandler<unknown, { readonly ok: boolean }> = {
      commandType: "TestCommand",
      schemaVersion: "1",
      authority: {
        tag: "CreateProjectAuthority",
        targetMatches: () => true,
      },
      stopAdmission: { _tag: "Unclassified" },
      execute: () => Effect.fail(repositoryFailure),
    };
    const { app, state } = buildApp([failingHandler]);
    const failure = await run(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* gateway
          .execute(envelope({ x: 1 }), externalContext, authorityFor({ x: 1 }))
          .pipe(Effect.flip);
      }),
      app,
    );

    expect(failure).toEqual(repositoryFailure);
    expect(state.rows.size).toBe(0);
    expect(state.attempts).toEqual([
      {
        commandId,
        outcome:
          "Retryable:PersistenceUnavailable:DependencyRepository:InjectedFailure",
      },
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

  it("rejects an OpenRequired command before its handler on a Closed project", async () => {
    let executed = false;
    const { app } = buildApp(
      [
        handler(
          () => ok({ result: { ok: true }, events: [] }),
          () => {
            executed = true;
          },
        ),
      ],
      FenceStopCheckInertLive,
      TransactionPortLive,
      "Closed",
    );
    const receipt = await run(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* gateway.execute(
          envelope({ x: 1 }),
          externalContext,
          authorityFor({ x: 1 }),
        );
      }),
      app,
    );
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("TerminalLifecycleMutation");
    }
    expect(executed).toBe(false);
  });

  it("defaults new commands to OpenRequired and explicitly allows convergence controls", () => {
    expect(projectAdmissionOf("FutureCommand")).toBe("OpenRequired");
    expect(projectAdmissionOf("CreateProject")).toBe("Bootstrap");
    expect(projectAdmissionOf("StopExecution")).toBe("ClosedAllowed");
    expect(projectAdmissionOf("SettleExecution")).toBe("ClosedAllowed");
    expect(projectAdmissionOf("RevokePermission")).toBe("ClosedAllowed");
  });
});
