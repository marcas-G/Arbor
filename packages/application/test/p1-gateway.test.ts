import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  type DomainError,
  type DomainResult,
  ExecutionId,
  err,
  LeaseGeneration,
  ok,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  VerificationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  CommandStore,
  type CommandStoreService,
  DomainEventJournal,
  type DomainEventJournalService,
  IdGenerator,
  type PendingDomainEvent,
  type StoredCommandResolution,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { describe, expect } from "vitest";
import {
  type CommandAuthorityRule,
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistryLive,
  FenceStopCheck,
  FenceStopCheckInertLive,
  type FenceStopOutcome,
  FINGERPRINT_ALGORITHM_VERSION,
  type GatewayEnvelope,
  projectAdmissionOf,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../src/index.js";

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const _otherCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");
const createProjectResult = {
  projectId,
  rootWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789ac",
  primarySessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789ad",
};
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
const systemContext: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "test",
};
/** Valid typed-internal payload: passes the input contract unchanged. */
const humanMessagePayload = {
  messageId: "msg_018f1f62-7b3c-7abc-8def-0123456789ab",
  targetWorkspaceId: "ws_018f1f62-7b3c-7abc-8def-0123456789ab",
  bodyRef: "body-ref",
};

const envelope = (
  payload: unknown,
  commandType = "CreateProject",
): GatewayEnvelope<unknown> => ({
  commandType,
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const schemaVersionFor = (commandType: string): string =>
  commandType === "CreateProject" ? "2" : "1";

const fpFor = (payload: unknown, commandType = "CreateProject") =>
  semanticRequestFingerprint({
    commandType,
    projectId,
    actor,
    schemaVersion: schemaVersionFor(commandType),
    payload,
  });

type CreateProjectAuthority = Extract<
  VerifiedCommandAuthority,
  { _tag: "CreateProjectAuthority" }
>;

const authorityFor = (
  payload: unknown,
  overrides: Partial<CreateProjectAuthority> = {},
  commandType = "CreateProject",
): VerifiedCommandAuthority => {
  const record = payload as Record<string, unknown>;
  if (commandType === "SubmitHumanMessage") {
    return {
      _tag: "SubmitHumanMessageAuthority",
      principal,
      commandId,
      semanticRequestFingerprint: fpFor(payload, commandType),
      projectId,
      targetWorkspaceId: parse(WorkspaceId)(record.targetWorkspaceId as string),
      messageId: record.messageId as never,
    };
  }
  return {
    _tag: "CreateProjectAuthority",
    principal,
    commandId,
    semanticRequestFingerprint: fpFor(payload, commandType),
    projectId,
    ...overrides,
  };
};

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
) => {
  const state = {
    rows: new Map<string, StoredCommandResolution>(),
    attempts: [] as Array<{ commandId: string; outcome: string }>,
    appended: [] as PendingDomainEvent[],
    order: [] as string[],
  };
  const row = (
    resolution: "Committed" | "TerminalRejected",
    [
      id,
      project,
      fingerprint,
      schemaVersion,
      algorithmVersion,
      json,
    ]: Parameters<CommandStoreService["insertCommitted"]>,
  ): StoredCommandResolution => ({
    commandId: id,
    projectId: project,
    semanticRequestFingerprint: fingerprint,
    schemaVersion,
    fingerprintAlgorithmVersion: algorithmVersion,
    resolution,
    resultJson: resolution === "Committed" ? json : null,
    terminalErrorJson: resolution === "Committed" ? null : json,
    createdAt: "t",
    settledAt: "t",
  });
  const store: CommandStoreService = {
    findResolution: (id) =>
      Effect.sync(() => {
        const stored = state.rows.get(id);
        return stored === undefined ? Option.none() : Option.some(stored);
      }),
    insertCommitted: (...args) =>
      Effect.sync(() => {
        state.order.push("receipt");
        state.rows.set(args[0], row("Committed", args));
      }),
    insertTerminalRejected: (...args) =>
      Effect.sync(() => {
        state.rows.set(args[0], row("TerminalRejected", args));
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
        state.order.push("event");
        state.appended.push(...drafts);
      }),
    appendReturningIds: () => Effect.succeed([]),
    readAfter: () => Effect.succeed([]),
    readAfterRaw: () => Effect.succeed([]),
    decodeRaw: () =>
      Effect.succeed({ _tag: "Poison", reason: "MalformedEnvelope" }),
    lastSequence: () => Effect.succeed(0),
  };
  let clockTick = 0;
  let idTick = 0;
  const deps = Layer.mergeAll(
    transaction,
    Layer.succeed(CommandStore, store),
    Layer.succeed(DomainEventJournal, journal),
    Layer.succeed(Clock, {
      now: () => Effect.sync(() => `t${clockTick++}`),
    }),
    Layer.succeed(IdGenerator, {
      generate: <T>(_kind: string) => Effect.sync(() => `evt_${idTick++}` as T),
    }),
    CommandHandlerRegistryLive(handlers),
    fence,
  );
  return {
    state,
    app: Layer.mergeAll(
      deps,
      Layer.provide(CommandGatewayLive, deps),
    ) as Layer.Layer<CommandGateway>,
  };
};

type HandlerOutcome = DomainResult<{
  result: unknown;
  events: ReadonlyArray<PendingDomainEvent>;
}>;

const handler = (
  behaviour: (payload: unknown) => HandlerOutcome,
  onExecute?: () => void,
  authority?: CommandAuthorityRule<unknown>,
  commandType = "CreateProject",
): CommandHandler<unknown, unknown> => ({
  commandType,
  schemaVersion: schemaVersionFor(commandType),
  authority: authority ?? {
    tag:
      commandType === "SubmitHumanMessage"
        ? "SubmitHumanMessageAuthority"
        : "CreateProjectAuthority",
    targetMatches: () => true,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (env) =>
    Effect.sync(() => {
      onExecute?.();
      return behaviour(env.payload);
    }).pipe(
      Effect.map((outcome) =>
        !outcome.ok || commandType !== "CreateProject"
          ? outcome
          : ok({ ...outcome.value, result: createProjectResult }),
      ),
    ),
});

const fenceLive = (outcome: FenceStopOutcome): Layer.Layer<FenceStopCheck> =>
  Layer.succeed(FenceStopCheck, { check: () => Effect.succeed(outcome) });

const gatewayExecute = (
  payload: unknown,
  app: Layer.Layer<CommandGateway>,
  context: CommandSubmissionContext = externalContext,
  authority: VerifiedCommandAuthority = authorityFor(payload),
  commandType = "CreateProject",
) =>
  Effect.provide(
    Effect.gen(function* () {
      const gateway = yield* CommandGateway;
      return yield* gateway.execute(
        envelope(payload, commandType),
        context,
        authority,
      );
    }),
    app,
  );

const outcomeOf = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  Effect.match(effect, {
    onFailure: (error) => ({ _tag: "Failure" as const, error }),
    onSuccess: (receipt) => ({ _tag: "Receipt" as const, receipt }),
  });

const expectTerminal = (
  receipt: { resolution: { _tag: string; error?: { _tag: string } } },
  errorTag: string,
): void => {
  expect(receipt.resolution._tag).toBe("TerminalRejected");
  if (receipt.resolution._tag === "TerminalRejected") {
    expect(receipt.resolution.error?._tag).toBe(errorTag);
  }
};

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
  it.effect(
    "rejects malformed internal payloads before any Gateway effect",
    () =>
      Effect.gen(function* () {
        let transactionCalls = 0;
        let handlerCalls = 0;
        const countingTransaction = Layer.succeed(TransactionPort, {
          transact: (body) => {
            transactionCalls += 1;
            return Effect.provideService(body, TransactionScope, {
              session: { id: "tx" },
            });
          },
        });
        const { app, state } = buildApp(
          [
            handler(
              () => ok({ result: { ok: true }, events: [] }),
              () => handlerCalls++,
              undefined,
              "SubmitHumanMessage",
            ),
          ],
          FenceStopCheckInertLive,
          countingTransaction,
        );
        const rejected = yield* outcomeOf(
          gatewayExecute(
            { ...humanMessagePayload, messageId: undefined },
            app,
            systemContext,
            authorityFor(humanMessagePayload, {}, "SubmitHumanMessage"),
            "SubmitHumanMessage",
          ),
        );
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(rejected.error).toMatchObject({
            _tag: "InternalCommandContractDefect",
            commandType: "SubmitHumanMessage",
            issues: [{ path: ["messageId"], rule: "type" }],
          });
        }
        expect(transactionCalls).toBe(0);
        expect(handlerCalls).toBe(0);
        expect(state.rows.size).toBe(0);
        expect(state.attempts).toEqual([]);
        expect(state.appended).toEqual([]);
      }),
  );

  it.effect(
    "prepares only after an advisory miss, replays without recapturing inputs, and rechecks the receipt after a transient preparation failure",
    () =>
      Effect.gen(function* () {
        let prepareCalls = 0;
        let executeCalls = 0;
        const { app, state } = buildApp([
          {
            ...handler(
              () => ok({ result: createProjectResult, events: [] }),
              () => {
                executeCalls += 1;
              },
            ),
            prepare: () =>
              Effect.sync(() => {
                prepareCalls += 1;
                return { prepared: true };
              }),
          },
        ]);
        const first = yield* gatewayExecute({ identity: "same" }, app);
        const replay = yield* gatewayExecute({ identity: "same" }, app);
        expect(first.resolution._tag).toBe("Committed");
        expect(replay.resolution).toEqual(first.resolution);
        expect(prepareCalls).toBe(1);
        expect(executeCalls).toBe(1);
        expect(state.rows.get(commandId)?.resolution).toBe("Committed");

        const failing = buildApp([
          {
            ...handler(() => ok({ result: createProjectResult, events: [] })),
            prepare: () =>
              Effect.fail({
                _tag: "TransactionOperationalFailure",
                cause: "fixture preparation unavailable",
              }),
          },
        ]);
        const result = yield* outcomeOf(
          gatewayExecute({ identity: "unprepared" }, failing.app),
        );
        expect(result._tag).toBe("Failure");
        expect(failing.state.rows.has(commandId)).toBe(false);
        expect(failing.state.appended).toHaveLength(0);
      }),
  );

  it.effect(
    "inserts the GrantPermission receipt before its events in the same transaction",
    () =>
      Effect.gen(function* () {
        const permissionGrantId = parse(PermissionGrantId)(
          "pgr_018f2b3c-4d5e-7abc-8def-0123456789ab",
        );
        const payload = { permissionGrantId };
        const { app, state } = buildApp([
          handler(
            () =>
              ok({
                result: { permissionGrantId },
                events: [
                  {
                    projectId,
                    eventType: "SandboxPolicyGrantIssued",
                    eventVersion: 1,
                    occurredAt: "t",
                    aggregateRef: permissionGrantId,
                    actor,
                    payload: {},
                  },
                ],
              }),
            undefined,
            {
              tag: "GrantPermissionAuthority",
              targetMatches: (authority, commandPayload) =>
                authority._tag === "GrantPermissionAuthority" &&
                authority.permissionGrantId ===
                  (commandPayload as typeof payload).permissionGrantId,
            },
            "GrantPermission",
          ),
        ]);
        const receipt = yield* gatewayExecute(
          payload,
          app,
          externalContext,
          {
            _tag: "GrantPermissionAuthority",
            principal,
            commandId,
            projectId,
            semanticRequestFingerprint: fpFor(payload, "GrantPermission"),
            permissionGrantId,
          },
          "GrantPermission",
        );
        expect(receipt.resolution._tag).toBe("Committed");
        expect(state.order).toEqual(["receipt", "event"]);
      }),
  );

  it.effect(
    "decodes a prior ConcludeVerification v1 receipt and validates it before replay",
    () =>
      Effect.gen(function* () {
        let replayChecks = 0;
        const payload = { v: 1 };
        const replayHandler: CommandHandler<unknown, unknown> = {
          commandType: "ConcludeVerification",
          schemaVersion: "2",
          priorReceiptSchemaVersions: ["1"],
          authority: {
            tag: "VerifierExecutionAuthority",
            targetMatches: () => true,
          },
          stopAdmission: { _tag: "Unclassified" },
          validateReceiptReplay: () =>
            Effect.sync(() => {
              replayChecks += 1;
            }),
          // A stored receipt must replay; reaching the handler dies the test.
          execute: () =>
            Effect.die(new Error("stored receipt should avoid execution")),
        };
        const { app, state } = buildApp([replayHandler]);
        // The stored row was written under schema 1, so its fingerprint uses
        // the same tuple the gateway recomputes for prior-version replay.
        state.rows.set(commandId, {
          commandId,
          projectId,
          semanticRequestFingerprint: fpFor(payload, "ConcludeVerification"),
          schemaVersion: "1",
          fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
          resolution: "Committed",
          resultJson: JSON.stringify({
            verificationId: parse(VerificationId)(
              "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
            ),
            state: "Concluded",
            verdict: "Pass",
            summaryRef: "blob:summary",
            wakeSignals: [],
            channel1Release: {
              workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789ab",
              targetWorkRevision: 0,
            },
          }),
          terminalErrorJson: null,
          createdAt: "t",
          settledAt: "t",
        });
        const receipt = yield* gatewayExecute(
          payload,
          app,
          externalContext,
          {} as never,
          "ConcludeVerification",
        );
        expect(receipt.schemaVersion).toBe("1");
        expect(receipt.resolution._tag).toBe("Committed");
        expect(replayChecks).toBe(1);
      }),
  );

  it.effect(
    "compares the stored tuple before interpreting raw result JSON, and fails corrupt receipts closed",
    () =>
      Effect.gen(function* () {
        let executions = 0;
        const storedRow = (resultJson: string): StoredCommandResolution => ({
          commandId,
          projectId,
          semanticRequestFingerprint: fpFor({ x: 1 }),
          schemaVersion: "2",
          fingerprintAlgorithmVersion: 1,
          resolution: "Committed",
          resultJson,
          terminalErrorJson: null,
          createdAt: "t0",
          settledAt: "t1",
        });
        const runCase = (resultJson: string, submitPayload: unknown) =>
          Effect.gen(function* () {
            const { app, state } = buildApp([
              handler(() => {
                executions += 1;
                return ok({ result: createProjectResult, events: [] });
              }),
            ]);
            state.rows.set(commandId, storedRow(resultJson));
            return {
              ...(yield* outcomeOf(gatewayExecute(submitPayload, app))),
              state,
            };
          });
        const expectQuiet = (
          result: { state: ReturnType<typeof buildApp>["state"] },
          resolved: { resolution: { _tag: string; error?: { _tag: string } } },
        ) => {
          expect(result.state.attempts).toEqual([]);
          expect(result.state.appended).toEqual([]);
          expect(executions).toBe(0);
          expect(resolved.resolution._tag).toBeDefined();
        };

        const sentinel = "RAW-RECEIPT-MUST-NOT-BE-INTERPRETED";
        const conflict = yield* runCase(`{"sentinel":"${sentinel}`, { x: 2 });
        expect(conflict._tag).toBe("Receipt");
        if (conflict._tag === "Receipt") {
          expectTerminal(conflict.receipt, "IdempotencyConflict");
        }
        expect(JSON.stringify(conflict)).not.toContain(sentinel);
        expect(conflict.state.rows.get(commandId)?.resultJson).toContain(
          sentinel,
        );
        if (conflict._tag === "Receipt")
          expectQuiet(conflict, conflict.receipt);

        const corrupt = yield* runCase(
          JSON.stringify({ unexpected: "private-sentinel" }),
          { x: 1 },
        );
        expect(corrupt._tag).toBe("Failure");
        if (corrupt._tag === "Failure") {
          expect(corrupt.error).toMatchObject({
            _tag: "PersistenceCorruption",
            repository: "CommandStore",
            operation: "decodeReceipt",
            reason:
              "stored command receipt does not match its registered schema",
          });
          expect(JSON.stringify(corrupt.error)).not.toContain(
            "private-sentinel",
          );
        }
        if (corrupt._tag === "Failure") {
          expectQuiet(corrupt, {
            resolution: { _tag: "Failure" },
          });
        } else {
          expectQuiet(corrupt, { resolution: { _tag: "Receipt" } });
        }
      }),
  );

  it.effect(
    "persists terminal rejections from handler denials and fence stops without events",
    () =>
      Effect.gen(function* () {
        const denied = buildApp([
          handler(() =>
            err({
              _tag: "AuthorityDenied",
              reason: "no authority",
            } as DomainError),
          ),
        ]);
        const receipt = yield* gatewayExecute({ x: 1 }, denied.app);
        expectTerminal(receipt, "AuthorityDenied");
        expect(denied.state.appended).toHaveLength(0);
        expect(denied.state.attempts).toEqual([
          { commandId, outcome: "TerminalRejected" },
        ]);

        const payload = { ...humanMessagePayload };
        for (const outcome of [
          "FencingRejected",
          "ExecutionStopping",
        ] as const) {
          const { app, state } = buildApp(
            [
              handler(
                () => ok({ result: { ok: true }, events: [] }),
                undefined,
                undefined,
                "SubmitHumanMessage",
              ),
            ],
            fenceLive(outcome),
          );
          const fenced = yield* gatewayExecute(
            payload,
            app,
            executionContext,
            authorityFor(payload, {}, "SubmitHumanMessage"),
            "SubmitHumanMessage",
          );
          expectTerminal(fenced, outcome);
          expect(state.appended).toHaveLength(0);
        }
      }),
  );

  it.effect(
    "propagates typed operational failures without a receipt, preserving the original when tracing fails",
    () =>
      Effect.gen(function* () {
        // Phase 1: the attempt trace itself fails; the original failure wins.
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
        const traced = buildApp(
          [handler(() => ok({ result: createProjectResult, events: [] }))],
          FenceStopCheckInertLive,
          unavailable,
        );
        const failure = yield* Effect.flip(
          gatewayExecute({ x: 1 }, traced.app),
        );
        expect(failure).toEqual({
          _tag: "TransactionOperationalFailure",
          cause: "database unavailable",
        });
        expect(traced.state.rows.size).toBe(0);
        expect(traced.state.attempts).toEqual([]);

        // Phase 2: a normalized handler repository failure stays typed and
        // records its retryable attempt.
        const repositoryFailure = {
          _tag: "PersistenceUnavailable" as const,
          repository: "DependencyRepository" as const,
          operation: "test",
          retryDisposition: "retryable" as const,
          sourceTag: "InjectedFailure",
          cause: "database unavailable",
        };
        const propagated = buildApp([
          {
            commandType: "CreateProject",
            schemaVersion: "2",
            authority: {
              tag: "CreateProjectAuthority",
              targetMatches: () => true,
            },
            stopAdmission: { _tag: "Unclassified" },
            execute: () => Effect.fail(repositoryFailure),
          },
        ]);
        const handlerFailure = yield* Effect.flip(
          gatewayExecute({ x: 1 }, propagated.app),
        );
        expect(handlerFailure).toEqual(repositoryFailure);
        expect(propagated.state.rows.size).toBe(0);
        expect(propagated.state.attempts).toEqual([
          {
            commandId,
            outcome:
              "Retryable:PersistenceUnavailable:DependencyRepository:InjectedFailure",
          },
        ]);
      }),
  );

  it("defaults new commands to OpenRequired and allows convergence controls", () => {
    expect(projectAdmissionOf("FutureCommand")).toBe("OpenRequired");
    expect(projectAdmissionOf("CreateProject")).toBe("Bootstrap");
    expect(projectAdmissionOf("StopExecution")).toBe("ClosedAllowed");
    expect(projectAdmissionOf("SettleExecution")).toBe("ClosedAllowed");
    expect(projectAdmissionOf("RevokePermission")).toBe("ClosedAllowed");
  });

  it.effect(
    "replays an existing committed receipt even when authority is now absent",
    () =>
      Effect.gen(function* () {
        let executions = 0;
        const { app } = buildApp([
          handler(
            () => ok({ result: createProjectResult, events: [] }),
            () => {
              executions += 1;
            },
          ),
        ]);
        const first = yield* gatewayExecute({ x: 1 }, app);
        const replay = yield* gatewayExecute(
          { x: 1 },
          app,
          externalContext,
          authorityFor(
            { x: 1 },
            { principal: parse(Principal)("user:revoked") },
          ),
        );
        expect(first.resolution._tag).toBe("Committed");
        expect(replay.resolution._tag).toBe("Committed");
        expect(executions).toBe(1);
      }),
  );
});
