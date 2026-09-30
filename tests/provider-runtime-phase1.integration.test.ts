import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Fiber, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P16_MIGRATIONS,
  ProviderTurnStoreLive,
  RuntimeClockLive,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  OpenAIProviderLive,
  type OpenAISdkChunk,
  type OpenAISdkClient,
} from "../adapters/provider-openai/src/index.js";
import {
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import type { ProviderExecutionContext } from "../packages/ports/dist/provider.js";
import {
  type CanonicalProviderEvent,
  type ProviderFailure,
  ProviderRuntime,
  type ProviderRuntimeExecutionPolicy,
  ProviderTurnStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../packages/testkit/src/index.js";
import {
  type HttpProviderRuntime,
  makeHttpProviderClient,
} from "./capability/real-provider/http-sdk-client.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const nextProviderTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789e2",
);

const request = {
  modelRef: "controlled-provider-model",
  instructions: [],
  messages: [{ role: "user" as const, text: "probe" }],
  toolDefinitions: [],
  outputContractRef: "tool-invocation-v1",
  budget: { maxOutputTokens: 128 },
  cacheHints: [],
};

const manifestJsonFor = (turnId: ProviderTurnId) =>
  JSON.stringify({
    providerTurnId: turnId,
    executionId,
    sessionId,
    contextEpoch: 0,
    modelRef: request.modelRef,
    instructionFragments: [],
    contextRefs: [],
    skillRefs: [],
    toolRefs: [],
    toolRoutes: [],
    outputContractRef: request.outputContractRef,
    budgetDecision: { maxOutputTokens: 128 },
    compiledRequestHash: "compiled-request-hash-is-not-manifest-id",
    controlBasis: {
      projectPolicyRevision: 0,
      workspacePolicyRevision: 0,
      responsibilityRevision: 0,
      resourceBoundaryRevision: 0,
      authorizationDigest: "provider-phase1-test",
      environmentRevision: "0",
    },
  });

const DEFAULT_POLICY: ProviderRuntimeExecutionPolicy = {
  connectTimeoutMs: 500,
  firstEventTimeoutMs: 500,
  streamIdleTimeoutMs: 500,
  turnTimeoutMs: 2_000,
  maxAttempts: 2,
  retryBackoffMs: 0,
};

interface AttemptSnapshot {
  readonly attempt_no: number;
  readonly outcome: string;
  readonly provider_error_kind: string | null;
  readonly failure_taxonomy_version: string;
  readonly observation_json: string;
  readonly canonical_event_prefix_json: string;
  readonly delivered_position: number | null;
  readonly continuation_checkpoint_json: string | null;
  readonly retry_safety: string | null;
  readonly retry_decision: string | null;
  readonly retry_strategy: string | null;
  readonly retry_reason: string | null;
}

interface TurnSnapshot {
  readonly manifest_id: string;
  readonly execution_policy_json: string | null;
  readonly turn_deadline_at: string | null;
  readonly settled_at: string | null;
  readonly finish_reason: string | null;
}

const waitForSignal = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "provider-phase1",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [sessionId, executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'provider-phase1','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'workspace', ?, 'coordination', NULL, NULL, NULL, ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
    }),
  );
});

const makeHarness = (
  client: OpenAISdkClient,
  policy: ProviderRuntimeExecutionPolicy = DEFAULT_POLICY,
) => {
  const root = mkdtempSync(join(tmpdir(), "provider-runtime-phase1-"));
  const databaseFile = join(root, "provider.db");
  const base = layer({ filename: databaseFile });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const transaction = Layer.provide(TransactionPortLive, infra);
  const turnStore = Layer.provide(ProviderTurnStoreLive, infra);
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive({ systemDefault: policy }),
    Layer.mergeAll(
      OpenAIProviderLive(client),
      turnStore,
      transaction,
      FixedSecretStoreLive(),
      infra,
    ),
  );
  const app = Layer.mergeAll(infra, turnStore, transaction, providerRuntime);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      Effect.provide(effect, app) as Effect.Effect<A, E, never>,
    );
  return { root, databaseFile, app, run };
};

const initialize = async (
  harness: ReturnType<typeof makeHarness>,
): Promise<void> =>
  harness.run(
    Effect.gen(function* () {
      yield* runMigrations(P16_MIGRATIONS);
      yield* seed;
    }),
  );

const readAttempt = (
  databaseFile: string,
  attemptNo = 0,
): AttemptSnapshot | undefined => {
  const db = new DatabaseSync(databaseFile);
  try {
    return db
      .prepare(
        "SELECT attempt_no, outcome, provider_error_kind, failure_taxonomy_version, observation_json, canonical_event_prefix_json, delivered_position, continuation_checkpoint_json, retry_safety, retry_decision, retry_strategy, retry_reason FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = ?",
      )
      .get(providerTurnId, attemptNo) as AttemptSnapshot | undefined;
  } finally {
    db.close();
  }
};

const readTurn = (databaseFile: string): TurnSnapshot | undefined => {
  const db = new DatabaseSync(databaseFile);
  try {
    return db
      .prepare(
        "SELECT manifest_id, execution_policy_json, turn_deadline_at, settled_at, finish_reason FROM provider_turns WHERE provider_turn_id = ?",
      )
      .get(providerTurnId) as TurnSnapshot | undefined;
  } finally {
    db.close();
  }
};

const runtimeEffect = (
  signal?: AbortSignal,
  policyOverrides?: Partial<ProviderRuntimeExecutionPolicy>,
  turnId = providerTurnId,
) =>
  Effect.gen(function* () {
    const runtime = yield* ProviderRuntime;
    return yield* runtime.runTurn({
      providerTurnId: turnId,
      executionId,
      sessionId,
      contextEpoch: parse(ContextEpochNumber)(0),
      modelRef: request.modelRef,
      outputContractRef: request.outputContractRef,
      manifestJson: manifestJsonFor(turnId),
      request,
      ...(signal === undefined ? {} : { cancellationSignal: signal }),
      ...(policyOverrides === undefined
        ? {}
        : { executionPolicyOverrides: policyOverrides }),
    });
  });

const client = (options: {
  readonly externalEffectPossible?: boolean;
  readonly onCall?: (input: {
    readonly context: ProviderExecutionContext;
  }) => void;
  readonly stream: (input: {
    readonly context: ProviderExecutionContext;
  }) => AsyncIterable<OpenAISdkChunk>;
}): OpenAISdkClient => ({
  externalEffectPossible: options.externalEffectPossible ?? false,
  streamChat: (input) => {
    options.onCall?.({ context: input.context });
    return options.stream({ context: input.context });
  },
});

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it("lets a concurrent lease heartbeat run while consuming a dense provider stream", async () => {
    const controlled = client({
      stream: async function* () {
        yield { type: "response_started" };
        for (let index = 0; index < 512; index += 1) {
          yield { type: "text", text: "x" };
        }
        yield { type: "completed", finishReason: "stop" };
      },
    });
    const harness = makeHarness(controlled, {
      ...DEFAULT_POLICY,
      turnTimeoutMs: 10_000,
      firstEventTimeoutMs: 10_000,
      streamIdleTimeoutMs: 10_000,
    });
    try {
      await initialize(harness);
      const result = await harness.run(
        Effect.raceFirst(
          runtimeEffect().pipe(Effect.as("provider" as const)),
          Effect.sleep(5).pipe(Effect.as("heartbeat" as const)),
        ),
      );
      expect(result).toBe("heartbeat");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("commits full Manifest, ProviderTurn, and Attempt(InProgress) before Adapter request dispatch", async () => {
    let callEvidence:
      | {
          readonly attemptOutcome: string;
          readonly observation: Record<string, unknown>;
          readonly manifestId: string;
          readonly compiledRequestHash: string;
          readonly persistedManifest: Record<string, unknown>;
          readonly policy: ProviderRuntimeExecutionPolicy;
        }
      | undefined;
    const controlled = client({
      externalEffectPossible: true,
      onCall: ({ context }) => {
        const db = new DatabaseSync(harness.databaseFile);
        try {
          const row = db
            .prepare(
              "SELECT a.outcome, a.observation_json, t.manifest_id, t.execution_policy_json, m.compiled_request_hash, m.manifest_json FROM provider_attempts a JOIN provider_turns t ON t.provider_turn_id = a.provider_turn_id JOIN model_context_manifests m ON m.manifest_id = t.manifest_id WHERE a.provider_turn_id = ? AND a.attempt_no = ?",
            )
            .get(context.providerTurnId, context.attemptNo) as
            | {
                outcome: string;
                observation_json: string;
                manifest_id: string;
                execution_policy_json: string;
                compiled_request_hash: string;
                manifest_json: string;
              }
            | undefined;
          if (row === undefined)
            throw new Error("durable provider intent missing");
          callEvidence = {
            attemptOutcome: row.outcome,
            observation: JSON.parse(row.observation_json) as Record<
              string,
              unknown
            >,
            manifestId: row.manifest_id,
            compiledRequestHash: row.compiled_request_hash,
            persistedManifest: JSON.parse(row.manifest_json) as Record<
              string,
              unknown
            >,
            policy: JSON.parse(
              row.execution_policy_json,
            ) as ProviderRuntimeExecutionPolicy,
          };
        } finally {
          db.close();
        }
      },
      stream: async function* () {
        yield { type: "response_started" };
        yield { type: "text", text: "durable-before-call" };
        yield { type: "completed", finishReason: "stop" };
      },
    });
    const harness = makeHarness(controlled);
    try {
      await initialize(harness);
      const result = await harness.run(runtimeEffect());
      expect(result.events.some((event) => event._tag === "TextDelta")).toBe(
        true,
      );
      expect(callEvidence?.attemptOutcome).toBe("InProgress");
      expect(callEvidence?.observation.externalEffectPossible).toBe(true);
      expect(callEvidence?.manifestId).toMatch(/^mft_/u);
      expect(callEvidence?.manifestId).not.toBe(
        callEvidence?.compiledRequestHash,
      );
      expect(callEvidence?.persistedManifest).toMatchObject({
        providerTurnId,
        executionId,
        sessionId,
        compiledRequestHash: "compiled-request-hash-is-not-manifest-id",
      });
      expect(callEvidence?.policy).toEqual(DEFAULT_POLICY);
      expect(readAttempt(harness.databaseFile)?.outcome).toBe("Success");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("retries a pre-response transport failure only after SafeReplay is durably explained", async () => {
    let calls = 0;
    const harness = makeHarness(
      client({
        stream: async function* () {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("socket reset"), {
              code: "ECONNRESET",
            });
          }
          yield { type: "response_started" };
          yield { type: "text", text: "retried" };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
      { ...DEFAULT_POLICY, maxAttempts: 2, retryBackoffMs: 0 },
    );
    try {
      await initialize(harness);
      const result = await harness.run(runtimeEffect());
      expect(calls).toBe(2);
      expect(result.attemptNo).toBe(1);
      const failed = readAttempt(harness.databaseFile, 0);
      expect(failed).toMatchObject({
        outcome: "RetryableFailure",
        provider_error_kind: "TransportFailed",
        retry_safety: "SafeReplay",
        retry_decision: "Retry",
        retry_strategy: "Replay",
      });
      expect(failed?.retry_reason).toContain("TransportFailed retry");
      expect(readAttempt(harness.databaseFile, 1)?.outcome).toBe("Success");
      expect(readTurn(harness.databaseFile)?.manifest_id).toMatch(/^mft_/u);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("refuses to replay after response and semantic output without a verified continuation", async () => {
    let calls = 0;
    const harness = makeHarness(
      client({
        stream: async function* () {
          calls += 1;
          yield { type: "response_started" };
          yield { type: "text", text: "partial semantic output" };
          throw Object.assign(new Error("stream reset"), {
            code: "ECONNRESET",
          });
        },
      }),
      { ...DEFAULT_POLICY, maxAttempts: 3, retryBackoffMs: 0 },
    );
    try {
      await initialize(harness);
      const failure = await harness.run(Effect.flip(runtimeEffect()) as never);
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "StreamInterrupted",
      });
      expect(calls).toBe(1);
      const attempt = readAttempt(harness.databaseFile);
      expect(attempt).toMatchObject({
        outcome: "TerminalFailure",
        provider_error_kind: "StreamInterrupted",
        retry_safety: "UnsafeReplay",
        retry_decision: "Stop",
      });
      expect(attempt?.canonical_event_prefix_json).toContain(
        "partial semantic output",
      );
      expect(readTurn(harness.databaseFile)?.settled_at).toBeNull();
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("uses SafeResume only with a durable cursor and forwards that cursor to the next Adapter attempt", async () => {
    let calls = 0;
    let resumeCursor: string | undefined;
    const harness = makeHarness(
      client({
        stream: async function* ({ context }) {
          calls += 1;
          if (context.attemptNo === 0) {
            yield { type: "response_started" };
            yield { type: "text", text: "prefix" };
            yield {
              type: "continuation",
              stateRef: "resume-cursor-1",
              resumeGuaranteed: true,
            };
            throw Object.assign(new Error("stream interrupted"), {
              code: "ECONNRESET",
            });
          }
          resumeCursor = context.continuationCheckpoint?.cursor;
          yield { type: "response_started" };
          yield { type: "text", text: "suffix" };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
      { ...DEFAULT_POLICY, maxAttempts: 2, retryBackoffMs: 0 },
    );
    try {
      await initialize(harness);
      const result = await harness.run(runtimeEffect());
      expect(calls).toBe(2);
      expect(resumeCursor).toBe("resume-cursor-1");
      expect(
        result.events
          .filter(
            (
              event,
            ): event is Extract<
              CanonicalProviderEvent,
              { readonly _tag: "TextDelta" }
            > => event._tag === "TextDelta",
          )
          .map((event) => event.text),
      ).toEqual(["prefix", "suffix"]);
      const turnStarts = result.events.filter(
        (event) => event._tag === "TurnStarted",
      );
      expect(turnStarts).toHaveLength(1);
      expect(turnStarts[0]).toMatchObject({
        providerTurnId,
        attemptNo: 0,
      });
      const first = readAttempt(harness.databaseFile, 0);
      expect(first).toMatchObject({
        outcome: "RetryableFailure",
        provider_error_kind: "StreamInterrupted",
        retry_safety: "SafeResume",
        retry_decision: "Retry",
        retry_strategy: "Resume",
      });
      const checkpoint = JSON.parse(
        first?.continuation_checkpoint_json ?? "{}",
      ) as {
        cursor?: string;
        canonicalEventPrefixJson?: string;
        deliveredPosition?: number;
        resumeGuaranteed?: boolean;
      };
      expect(checkpoint).toMatchObject({
        cursor: "resume-cursor-1",
        deliveredPosition: 0,
        resumeGuaranteed: true,
      });
      expect(checkpoint.canonicalEventPrefixJson).toContain("prefix");
      expect(readAttempt(harness.databaseFile, 1)?.outcome).toBe("Success");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("resumes a durable dangling ProviderTurn on the re-dispatched runTurn path without a caller-supplied plan", async () => {
    const attemptsCalled: number[] = [];
    const harness = makeHarness(
      client({
        stream: async function* ({ context }) {
          attemptsCalled.push(context.attemptNo);
          yield { type: "response_started" };
          yield { type: "text", text: "suffix" };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
    );
    const manifestId = "mft_process_lost_reentry";
    const canonicalPrefix = JSON.stringify([
      {
        _tag: "TurnStarted",
        providerTurnId,
        attemptNo: 0,
        modelRef: request.modelRef,
      },
      { _tag: "TextDelta", text: "prefix" },
    ]);
    const checkpoint = {
      cursor: "process-lost-cursor",
      canonicalEventPrefixJson: canonicalPrefix,
      deliveredPosition: 0,
      resumeGuaranteed: true,
    } as const;
    try {
      await harness.run(
        Effect.gen(function* () {
          yield* runMigrations(P16_MIGRATIONS);
          yield* seed;
          const tx = yield* TransactionPort;
          const turns = yield* ProviderTurnStore;
          yield* tx.transact(
            turns.startTurnWithManifest(
              {
                providerTurnId,
                executionId,
                sessionId,
                contextEpoch: parse(ContextEpochNumber)(0),
                modelRef: request.modelRef,
                outputContractRef: request.outputContractRef,
                manifestId,
                executionPolicy: DEFAULT_POLICY,
                turnDeadlineAt: "2999-01-01T00:00:00.000Z",
              },
              manifestJsonFor(providerTurnId),
              JSON.stringify(request),
              "t0",
            ),
          );
          yield* tx.transact(
            turns.startAttempt(
              providerTurnId,
              0,
              {
                responseStarted: false,
                canonicalEventEmitted: false,
                consumerVisibleOutput: false,
                toolCallProposed: false,
                continuationAvailable: false,
                externalEffectPossible: null,
              },
              "t1",
            ),
          );
          yield* tx.transact(
            turns.updateAttemptObservation(
              providerTurnId,
              0,
              {
                responseStarted: true,
                canonicalEventEmitted: true,
                consumerVisibleOutput: false,
                toolCallProposed: false,
                continuationAvailable: true,
                externalEffectPossible: false,
              },
              canonicalPrefix,
              0,
              checkpoint,
              "t2",
            ),
          );
        }),
      );

      // The redispatched driver presents the same ProviderTurn ID and
      // Manifest/request. Runtime verifies that binding against durable state,
      // applies the shared retry policy, and uses the persisted cursor without
      // requiring an in-memory Recovery plan to survive process restart.
      const result = await harness.run(runtimeEffect());
      expect(attemptsCalled).toEqual([1]);
      expect(result.attemptNo).toBe(1);
      expect(
        result.events
          .filter(
            (
              event,
            ): event is Extract<
              CanonicalProviderEvent,
              { readonly _tag: "TextDelta" }
            > => event._tag === "TextDelta",
          )
          .map((event) => event.text),
      ).toEqual(["prefix", "suffix"]);
      expect(readTurn(harness.databaseFile)?.manifest_id).toBe(manifestId);
      expect(readAttempt(harness.databaseFile, 0)).toMatchObject({
        outcome: "RetryableFailure",
        provider_error_kind: null,
        retry_safety: "SafeResume",
        retry_decision: "Retry",
        retry_strategy: "Resume",
      });
      expect(readAttempt(harness.databaseFile, 1)?.outcome).toBe("Success");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["before connection", "before-connect"],
    ["after response start", "after-response"],
    ["after TextDelta", "after-text"],
    ["during fragmented tool-call arguments", "fragmented-tool"],
  ] as const)(
    "cancellation %s aborts transport, persists Cancelled, and suppresses late events",
    async (_label, mode) => {
      const entered = deferred();
      let lateChunkAttempted = false;
      const controller = new AbortController();
      const harness = makeHarness(
        client({
          externalEffectPossible: mode === "before-connect",
          stream: async function* ({ context }) {
            if (mode !== "before-connect") {
              yield { type: "response_started" };
            }
            if (mode === "after-text") {
              yield { type: "text", text: "visible-to-provider-runtime" };
            }
            if (mode === "fragmented-tool") {
              yield {
                type: "tool_call_delta",
                callRef: "fragment-call",
                toolName: "read",
                argumentsDelta: '{"path":',
              };
            }
            entered.resolve();
            await waitForSignal(context.cancellationSignal as AbortSignal);
            lateChunkAttempted = true;
            if (mode === "fragmented-tool") {
              yield { type: "tool_call_complete", callRef: "fragment-call" };
            } else {
              yield { type: "text", text: "late-after-cancel" };
            }
          },
        }),
      );
      try {
        await initialize(harness);
        const fiber = Effect.runFork(
          Effect.provide(
            runtimeEffect(controller.signal),
            harness.app,
          ) as never,
        );
        await entered.promise;
        controller.abort();
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit)).toBe(true);
        const attempt = readAttempt(harness.databaseFile);
        expect(attempt?.outcome).toBe("Cancelled");
        expect(readTurn(harness.databaseFile)).toMatchObject({
          finish_reason: "Cancelled",
        });
        expect(attempt?.observation_json).toContain(
          '"externalEffectPossible":',
        );
        expect(attempt?.canonical_event_prefix_json).not.toContain(
          "late-after-cancel",
        );
        expect(attempt?.canonical_event_prefix_json).not.toContain(
          "ToolCallProposed",
        );
        expect(lateChunkAttempted).toBe(true);
      } finally {
        controller.abort();
        rmSync(harness.root, { recursive: true, force: true });
      }
    },
  );

  it("a cancelled Turn's late Adapter event cannot contaminate the next ProviderTurn", async () => {
    const firstPartial = deferred();
    let calls = 0;
    let lateChunkAttempted = false;
    const clientWithLateTurn = client({
      stream: async function* ({ context }) {
        calls += 1;
        if (context.providerTurnId === providerTurnId) {
          yield { type: "response_started" };
          yield { type: "text", text: "old-turn-prefix" };
          firstPartial.resolve();
          await waitForSignal(context.cancellationSignal as AbortSignal);
          lateChunkAttempted = true;
          yield { type: "text", text: "late-old-turn-event" };
          return;
        }
        yield { type: "response_started" };
        yield { type: "text", text: "next-turn-only" };
        yield { type: "completed", finishReason: "stop" };
      },
    });
    const harness = makeHarness(clientWithLateTurn);
    const controller = new AbortController();
    try {
      await initialize(harness);
      const firstFiber = Effect.runFork(
        Effect.provide(
          runtimeEffect(controller.signal, undefined, providerTurnId),
          harness.app,
        ) as never,
      );
      await firstPartial.promise;
      controller.abort();
      const firstExit = await Effect.runPromise(Fiber.await(firstFiber));
      expect(Exit.isFailure(firstExit)).toBe(true);
      expect(lateChunkAttempted).toBe(true);

      const next = await harness.run(
        runtimeEffect(undefined, undefined, nextProviderTurnId),
      );
      expect(
        next.events
          .filter(
            (
              event,
            ): event is Extract<
              CanonicalProviderEvent,
              { readonly _tag: "TextDelta" }
            > => event._tag === "TextDelta",
          )
          .map((event) => event.text),
      ).toEqual(["next-turn-only"]);
      const db = new DatabaseSync(harness.databaseFile);
      try {
        const first = db
          .prepare(
            "SELECT outcome, canonical_event_prefix_json FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
          )
          .get(providerTurnId) as
          | { outcome: string; canonical_event_prefix_json: string }
          | undefined;
        const second = db
          .prepare(
            "SELECT outcome, canonical_event_prefix_json FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
          )
          .get(nextProviderTurnId) as
          | { outcome: string; canonical_event_prefix_json: string }
          | undefined;
        expect(first?.outcome).toBe("Cancelled");
        expect(first?.canonical_event_prefix_json).not.toContain(
          "late-old-turn-event",
        );
        expect(second?.outcome).toBe("Success");
        expect(second?.canonical_event_prefix_json).toContain("next-turn-only");
        expect(second?.canonical_event_prefix_json).not.toContain(
          "old-turn-prefix",
        );
      } finally {
        db.close();
      }
      expect(calls).toBe(2);
    } finally {
      controller.abort();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("parses arbitrary SSE byte chunking through the real Adapter and Runtime path", async () => {
    const originalFetch = globalThis.fetch;
    const sse = [
      'data: {"choices":[{"delta":{"content":"chunked hello"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"path\\":\\"."}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
      "",
      "",
    ].join("\n\n");
    const bytes = new TextEncoder().encode(sse);
    let offset = 0;
    let chunkNo = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            // Split SSE field names, UTF-8 payloads, and frame separators at
            // deliberately irregular byte offsets.
            const width = [1, 4, 2, 11, 3, 7][chunkNo % 6] ?? 5;
            controller.enqueue(bytes.slice(offset, offset + width));
            offset += width;
            chunkNo += 1;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-sse",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const sdk = makeHttpProviderClient({ runtime, captures: [] });
    const harness = makeHarness(sdk);
    try {
      await initialize(harness);
      const result = await harness.run(runtimeEffect());
      expect(result.events).toContainEqual({
        _tag: "TextDelta",
        text: "chunked hello",
      });
      expect(result.events).toContainEqual({
        _tag: "ToolCallProposed",
        callRef: "call-1",
        toolName: "read",
        argumentsJson: '{"path":"."}',
      });
      expect(result.events).toContainEqual({
        _tag: "UsageReported",
        inputTokens: 3,
        outputTokens: 2,
      });
      expect(result.events).toContainEqual({
        _tag: "TurnCompleted",
        finishReason: "ToolCall",
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("records provider response start before mapping an HTTP failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "rate_limit_exceeded" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );

    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-http-error",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
    );
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "RateLimited",
      });
      expect(
        JSON.parse(readAttempt(harness.databaseFile)?.observation_json ?? "{}"),
      ).toMatchObject({
        responseStarted: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("does not replay a remote HTTP request whose transport failed before a response", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw Object.assign(new Error("socket reset"), {
        code: "ECONNRESET",
      });
    };
    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-remote-transport-failure",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const sdk = makeHttpProviderClient({ runtime, captures: [] });
    expect(sdk.externalEffectPossible).toBe(true);
    const policy = {
      ...DEFAULT_POLICY,
      maxAttempts: 3,
      retryBackoffMs: 0,
    } satisfies ProviderRuntimeExecutionPolicy;
    const harness = makeHarness(sdk, policy);
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect(undefined, policy)) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "TransportFailed",
      });
      expect(calls).toBe(1);
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "TerminalFailure",
        provider_error_kind: "TransportFailed",
        retry_safety: "UnsafeReplay",
        retry_decision: "Stop",
      });
      expect(
        JSON.parse(readAttempt(harness.databaseFile)?.observation_json ?? "{}"),
      ).toMatchObject({
        responseStarted: false,
        externalEffectPossible: true,
      });
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects an SSE EOF without a provider finish reason instead of inventing Stop", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-truncated-sse",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
    );
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "ProtocolViolation",
      });
      const attempt = readAttempt(harness.databaseFile);
      expect(attempt?.outcome).toBe("TerminalFailure");
      expect(attempt?.provider_error_kind).toBe("ProtocolViolation");
      expect(attempt?.canonical_event_prefix_json).toContain("partial");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown provider finish reason as ProtocolViolation", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"future_reason"}]}',
          "data: [DONE]",
          "",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-unknown-finish-reason",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
    );
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "ProtocolViolation",
      });
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "TerminalFailure",
        provider_error_kind: "ProtocolViolation",
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("classifies fetch AbortError as Cancelled when the caller signal aborts", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const fetchStarted = deferred();
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      fetchStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(
            Object.assign(new Error("fetch aborted"), { name: "AbortError" }),
          );
        if (signal.aborted) {
          rejectAbort();
        } else {
          signal.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    };
    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-fetch-abort",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
    );
    try {
      await initialize(harness);
      const fiber = Effect.runFork(
        Effect.provide(runtimeEffect(controller.signal), harness.app) as never,
      );
      await fetchStarted.promise;
      controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "Cancelled",
        provider_error_kind: "Cancelled",
      });
      expect(readTurn(harness.databaseFile)?.finish_reason).toBe("Cancelled");
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("classifies fetch AbortError from the staged timeout as TimedOut, not TransportFailed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(
            Object.assign(new Error("fetch aborted"), { name: "AbortError" }),
          );
        if (signal.aborted) {
          rejectAbort();
        } else {
          signal.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    };
    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-fetch-timeout",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const policy = {
      ...DEFAULT_POLICY,
      connectTimeoutMs: 35,
      firstEventTimeoutMs: 300,
      streamIdleTimeoutMs: 300,
      turnTimeoutMs: 500,
      maxAttempts: 2,
      retryBackoffMs: 0,
    } satisfies ProviderRuntimeExecutionPolicy;
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
      policy,
    );
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect(undefined, policy)) as never,
      )) as { readonly _tag: string; readonly phase?: string };
      expect(failure).toMatchObject({
        _tag: "ProviderExecutionTimeout",
        phase: "ConnectTimeout",
      });
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "TimedOut",
        provider_error_kind: null,
      });
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("cancels an in-flight fetch reader after TextDelta and rejects late SSE data", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const textDelivered = deferred();
    let readerCancelled = false;
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(bodyController) {
            fetchSignal?.addEventListener(
              "abort",
              () =>
                bodyController.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
                  ),
                ),
              { once: true },
            );
          },
          pull(bodyController) {
            if (sent) return;
            sent = true;
            bodyController.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"first chunk"}}]}\n\n',
              ),
            );
          },
          cancel() {
            readerCancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-cancel",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
    };
    const base = makeHttpProviderClient({ runtime, captures: [] });
    const sdk: OpenAISdkClient = {
      externalEffectPossible: false,
      streamChat: async function* (input) {
        for await (const chunk of base.streamChat(input)) {
          yield chunk;
          if (chunk.type === "text") textDelivered.resolve();
        }
      },
    };
    const harness = makeHarness(sdk);
    try {
      await initialize(harness);
      const fiber = Effect.runFork(
        Effect.provide(runtimeEffect(controller.signal), harness.app) as never,
      );
      await textDelivered.promise;
      controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(fetchSignal?.aborted).toBe(true);
      expect(readerCancelled).toBe(true);
      const attempt = readAttempt(harness.databaseFile);
      expect(attempt?.outcome).toBe("Cancelled");
      expect(attempt?.canonical_event_prefix_json).toContain("first chunk");
      expect(attempt?.canonical_event_prefix_json).not.toContain("late");
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["connect", "connect", "ConnectTimeout"],
    ["first event", "first-event", "FirstEventTimeout"],
    ["stream idle", "stream-idle", "StreamIdleTimeout"],
    ["whole turn deadline", "turn-deadline", "TurnDeadline"],
  ] as const)(
    "%s timeout aborts the Adapter and has a distinct durable terminal outcome",
    async (_label, mode, phase) => {
      const connected = deferred();
      const policy: ProviderRuntimeExecutionPolicy = {
        connectTimeoutMs: mode === "connect" ? 35 : 400,
        firstEventTimeoutMs: mode === "first-event" ? 35 : 400,
        streamIdleTimeoutMs: mode === "stream-idle" ? 35 : 400,
        turnTimeoutMs: mode === "turn-deadline" ? 180 : 800,
        maxAttempts: 2,
        retryBackoffMs: 0,
      };
      const harness = makeHarness(
        client({
          stream: async function* ({ context }) {
            if (mode !== "connect") yield { type: "response_started" };
            if (mode === "stream-idle") {
              yield { type: "text", text: "first data" };
            }
            connected.resolve();
            await waitForSignal(context.cancellationSignal as AbortSignal);
          },
        }),
        policy,
      );
      try {
        await initialize(harness);
        const failure = (await harness.run(
          Effect.flip(runtimeEffect()) as never,
        )) as { readonly _tag: string; readonly phase?: string };
        expect(failure).toMatchObject({
          _tag: "ProviderExecutionTimeout",
          phase,
        });
        await connected.promise;
        const attempt = readAttempt(harness.databaseFile);
        expect(attempt?.outcome).toBe("TimedOut");
        expect(attempt?.retry_decision).toBe("Stop");
        expect(attempt?.retry_reason).toContain(`Timeout(${phase})`);
        expect(readTurn(harness.databaseFile)?.finish_reason).toBe(phase);
      } finally {
        rmSync(harness.root, { recursive: true, force: true });
      }
    },
  );

  it("cancellation during retry backoff prevents Attempt 1", async () => {
    const firstCall = deferred();
    const controller = new AbortController();
    let calls = 0;
    const harness = makeHarness(
      client({
        stream: async function* ({ context }) {
          calls += 1;
          firstCall.resolve();
          if (calls === 1) {
            throw Object.assign(new Error("connect reset"), {
              code: "ECONNRESET",
            });
          }
          yield { type: "response_started" };
          yield { type: "completed", finishReason: "stop" };
          void context;
        },
      }),
      { ...DEFAULT_POLICY, retryBackoffMs: 500 },
    );
    try {
      await initialize(harness);
      const fiber = Effect.runFork(
        Effect.provide(runtimeEffect(controller.signal), harness.app) as never,
      );
      await firstCall.promise;
      const reader = new DatabaseSync(harness.databaseFile);
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const row = reader
            .prepare(
              "SELECT outcome FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
            )
            .get(providerTurnId) as { outcome?: string } | undefined;
          if (row?.outcome === "RetryableFailure") break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        reader.close();
      }
      controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toBe(1);
      expect(readAttempt(harness.databaseFile, 0)?.outcome).toBe(
        "RetryableFailure",
      );
      expect(readTurn(harness.databaseFile)?.finish_reason).toBe("Cancelled");
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
    } finally {
      controller.abort();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("turn deadline covers retry backoff and prevents a later attempt", async () => {
    let calls = 0;
    const harness = makeHarness(
      client({
        stream: async function* () {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("pre-response reset"), {
              code: "ECONNRESET",
            });
          }
          yield { type: "response_started" };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
      {
        ...DEFAULT_POLICY,
        connectTimeoutMs: 500,
        turnTimeoutMs: 120,
        maxAttempts: 3,
        retryBackoffMs: 500,
      },
    );
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as { readonly _tag: string; readonly phase?: string };
      expect(failure).toMatchObject({
        _tag: "ProviderExecutionTimeout",
        phase: "TurnDeadline",
      });
      expect(calls).toBe(1);
      expect(readAttempt(harness.databaseFile, 0)).toMatchObject({
        outcome: "RetryableFailure",
        retry_decision: "Retry",
      });
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
      expect(readTurn(harness.databaseFile)?.finish_reason).toBe(
        "TurnDeadline",
      );
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
