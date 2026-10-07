import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentExecutionStateStoreLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P32_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  RuntimeClockLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  type OpenAICompatibleFetch,
  OpenAICompatibleFetchClient,
  OpenAIProviderLive,
} from "../../../adapters/provider-openai/src/index.js";
import { WorkerDispatchPortLive } from "../../../adapters/worker-local/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../../../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  ExecutionId,
  type ExecutionSettlement,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  type AdmitExecutionPayload,
  FenceStopCheckLive,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  P2CommandHandlerRegistryLive,
  RuntimeSafetyGateLive,
  runExecution,
} from "../../../packages/execution-runtime/src/index.js";
import type {
  ProviderRunResult,
  ProviderRuntimeExecutionPolicy,
} from "../../../packages/ports/src/index.js";
import {
  type ExecutionDriverError,
  ExecutionDriverPort,
  ExecutionRepository,
  ProviderRuntime,
  TransactionPort,
} from "../../../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../../packages/testkit/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789c1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const principal = parse(Principal)("runtime:p9-dense-sse");
const actor = parse(Actor)("runtime:p9-dense-sse");
const modelRef = "p9-dense-sse-local";
const outputContractRef = "plain-text-v1";
const maxDenseFrames = 24_000;
const denseBatchSize = 16;
const denseBatchDelayMs = 60;
const renewalWaitLimitMs = 35_000;

const COMPLETED: ExecutionSettlement = {
  _tag: "Completed",
  result: {
    _tag: "InboxInputHandled",
    entryKey: "p9-dense-sse-lease-renewal",
  },
};

interface DenseState {
  requestCount: number;
  activeResponses: number;
  framesWritten: number;
  framesConsumed: number;
  finishStream: boolean;
  frameCapReached: boolean;
  initialLease:
    | { readonly generation: number; readonly expiresAt: string }
    | undefined;
  providerResult: ProviderRunResult | undefined;
  driverError: unknown;
}

const denseState: DenseState = {
  requestCount: 0,
  activeResponses: 0,
  framesWritten: 0,
  framesConsumed: 0,
  finishStream: false,
  frameCapReached: false,
  initialLease: undefined,
  providerResult: undefined,
  driverError: undefined,
};

const databaseDirectory = mkdtempSync(join(tmpdir(), "p9-dense-sse-"));
const databaseFile = join(databaseDirectory, "lease-renewal.db");
let providerServer: Server | undefined;
let running:
  | Promise<
      | ExecutionSettlement
      | {
          readonly _tag: "ApprovalRequired";
          readonly approvalId: string;
          readonly revision: number;
        }
    >
  | undefined;

afterEach(async () => {
  denseState.finishStream = true;
  if (running !== undefined) {
    await running.catch(() => undefined);
    running = undefined;
  }
  if (providerServer !== undefined) {
    await new Promise<void>((resolveClose) =>
      providerServer?.close(() => resolveClose()),
    );
    providerServer = undefined;
  }
  const resolvedDirectory = resolve(databaseDirectory);
  if (
    dirname(resolvedDirectory) !== resolve(tmpdir()) ||
    !basename(resolvedDirectory).startsWith("p9-dense-sse-")
  ) {
    throw new Error(`unexpected P9 test directory: ${resolvedDirectory}`);
  }
  rmSync(resolvedDirectory, { recursive: true, force: true, maxRetries: 3 });
  denseState.requestCount = 0;
  denseState.activeResponses = 0;
  denseState.framesWritten = 0;
  denseState.framesConsumed = 0;
  denseState.frameCapReached = false;
  denseState.initialLease = undefined;
  denseState.providerResult = undefined;
  denseState.driverError = undefined;
});

const sseData = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

const chatChunk = (
  delta: Record<string, unknown>,
  finishReason: string | null,
) => ({
  id: "chatcmpl-p9-dense-sse",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  usage: null,
});

const startDenseProvider = async (): Promise<string> =>
  new Promise((resolveStart, rejectStart) => {
    providerServer = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      denseState.requestCount += 1;
      denseState.activeResponses += 1;
      response.on("close", () => {
        denseState.activeResponses = Math.max(
          0,
          denseState.activeResponses - 1,
        );
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const write = async (value: string) => {
        if (response.destroyed) return;
        if (!response.write(value)) await once(response, "drain");
      };

      void (async () => {
        await write(sseData(chatChunk({ role: "assistant" }, null)));
        let localFrames = 0;
        while (!denseState.finishStream && localFrames < maxDenseFrames) {
          for (
            let index = 0;
            index < denseBatchSize &&
            localFrames < maxDenseFrames &&
            !denseState.finishStream;
            index += 1
          ) {
            await write(sseData(chatChunk({ content: "." }, null)));
            localFrames += 1;
            denseState.framesWritten += 1;
          }
          if (!denseState.finishStream) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, denseBatchDelayMs),
            );
          }
        }
        if (!denseState.finishStream) denseState.frameCapReached = true;
        await write(
          sseData(chatChunk({ content: " p9-renewal-result-retained" }, null)),
        );
        await write(
          sseData({
            id: "chatcmpl-p9-dense-sse-final",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 8,
              completion_tokens: localFrames + 3,
              total_tokens: localFrames + 11,
            },
          }),
        );
        await write("data: [DONE]\n\n");
        response.end();
      })().catch((error: unknown) => {
        denseState.driverError = error;
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    providerServer.once("error", rejectStart);
    providerServer.listen(0, "127.0.0.1", () => {
      const address = providerServer?.address();
      const port =
        typeof address === "object" && address !== null ? address.port : -1;
      if (port < 0) {
        rejectStart(new Error("P9 provider server did not acquire a port"));
        return;
      }
      resolveStart(`http://127.0.0.1:${port}/v1`);
    });
  });

const DEFAULT_POLICY: ProviderRuntimeExecutionPolicy = {
  connectTimeoutMs: 2_000,
  firstEventTimeoutMs: 5_000,
  // ProviderRuntime measures the streaming budget from the first data event;
  // the test must keep a valid turn open across the production 10s renewal.
  streamIdleTimeoutMs: 40_000,
  turnTimeoutMs: 45_000,
  maxAttempts: 1,
  retryBackoffMs: 0,
};

const manifestJson = JSON.stringify({
  providerTurnId,
  executionId,
  sessionId,
  contextEpoch: 0,
  modelRef,
  instructionFragments: [],
  contextRefs: [],
  skillRefs: [],
  toolRefs: [],
  toolRoutes: [],
  outputContractRef,
  budgetDecision: { maxOutputTokens: maxDenseFrames + 2_000 },
  compiledRequestHash: "p9-dense-sse-lease-renewal",
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "p9-dense-sse-lease-renewal",
    environmentRevision: "0",
  },
});

const providerRequest = {
  modelRef,
  instructions: [],
  messages: [{ role: "user" as const, text: "P9 dense SSE lease renewal" }],
  toolDefinitions: [],
  outputContractRef,
  budget: { maxOutputTokens: maxDenseFrames + 2_000 },
  cacheHints: [],
};

const makeApp = (providerBaseUrl: string, fetcher: OpenAICompatibleFetch) => {
  const base = layer({ filename: databaseFile });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const transaction = Layer.provide(TransactionPortLive, infra);
  const repository = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(
    FenceStopCheckLive,
    Layer.merge(infra, repository),
  );
  const repos = Layer.mergeAll(
    transaction,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    repository,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repository)),
  );
  const providerTurnStore = Layer.provide(ProviderTurnStoreLive, infra);
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive({ systemDefault: DEFAULT_POLICY }),
    Layer.mergeAll(
      OpenAIProviderLive(
        OpenAICompatibleFetchClient({
          baseUrl: providerBaseUrl,
          model: modelRef,
          allowUnauthenticated: true,
          fetch: fetcher,
        }),
      ),
      providerTurnStore,
      transaction,
      FixedSecretStoreLive(),
      infra,
    ),
  );
  const driver = Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const runtime = yield* ProviderRuntime;
      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      return ExecutionDriverPort.of({
        drive: ({ execution }) =>
          Effect.gen(function* () {
            const lease = yield* tx.transact(
              executions.currentLease(execution.executionId),
            );
            if (Option.isNone(lease)) {
              return yield* Effect.die(
                new Error("P9 driver has no live lease"),
              );
            }
            denseState.initialLease = {
              generation: lease.value.generation,
              expiresAt: lease.value.expiresAt,
            };
            const result = yield* runtime.runTurn({
              providerTurnId,
              executionId: execution.executionId,
              sessionId: execution.sessionId,
              contextEpoch: parse(ContextEpochNumber)(0),
              modelRef,
              outputContractRef,
              manifestJson,
              request: providerRequest,
            });
            denseState.providerResult = result;
            return COMPLETED;
          }).pipe(
            Effect.mapError(
              (cause): ExecutionDriverError => ({
                _tag: "ExecutionDriverOperationalFailure",
                stage: "DriverDependency",
                sourceTag: "p9-dense-sse-provider",
                cause,
              }),
            ),
          ),
      });
    }),
  );
  const driverLayer = Layer.provide(
    driver,
    Layer.mergeAll(infra, repos, providerRuntime),
  );
  const core = Layer.mergeAll(
    infra,
    repos,
    fence,
    WorkerDispatchPortLive,
    driverLayer,
    RuntimeSafetyGateLive(),
    Layer.provide(P2CommandHandlerRegistryLive, repos),
  );
  return Layer.mergeAll(core, Layer.provide(CommandGatewayLive, core));
};

const run = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases Effect requirements
  effect: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases layer requirements
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: provide erases test layer requirements
    Effect.provide(effect, app) as Effect.Effect<A, any, never>,
  );

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p9-dense-sse",
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "p9-dense-sse",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
    }),
  );
});

const admit = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const payload: AdmitExecutionPayload = {
    _tag: "WorkspaceMain",
    executionId,
    workspaceId,
    episode: {
      _tag: "InboxEpisode",
      entryKey: "p9-dense-sse-lease-renewal",
      inputKind: "Qualification",
    },
  };
  const commandId = parse(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
  );
  const authority: VerifiedRuntimeCommandAuthority = {
    _tag: "AdmitExecutionAuthority",
    submissionOrigin: "System",
    principal,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "AdmitExecution",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId,
    commandKind: "AdmitExecution",
    workspaceId,
    bindingKind: "WorkspaceMain",
  };
  const envelope: GatewayEnvelope<AdmitExecutionPayload> = {
    commandType: "AdmitExecution",
    commandId,
    projectId,
    actor,
    issuedAt: new Date().toISOString(),
    payload,
  };
  yield* gateway.execute(
    envelope,
    { _tag: "System", principal, causationRef: "p9-dense-sse" },
    authority,
  );
});

const readLease = () => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT generation, expires_at FROM execution_leases WHERE execution_id = ?",
      )
      .get(executionId) as
      | { readonly generation: number; readonly expires_at: string }
      | undefined;
  } finally {
    db.close();
  }
};

const readProviderState = () => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      attempt: db
        .prepare(
          "SELECT outcome, settled_at, canonical_event_prefix_json FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
        )
        .get(providerTurnId) as
        | {
            readonly outcome: string;
            readonly settled_at: string | null;
            readonly canonical_event_prefix_json: string;
          }
        | undefined,
      turn: db
        .prepare(
          "SELECT settled_at, finish_reason FROM provider_turns WHERE provider_turn_id = ?",
        )
        .get(providerTurnId) as
        | {
            readonly settled_at: string | null;
            readonly finish_reason: string | null;
          }
        | undefined,
    };
  } finally {
    db.close();
  }
};

const waitFor = async <A>(
  read: () => A,
  accept: (value: A) => boolean,
  timeoutMs: number,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (accept(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return read();
};

describe("P9 dense SSE lease renewal qualification", () => {
  it("commits TTL/3 renewal while an active SSE stream is consumed and preserves its result", async () => {
    expect(LEASE_RENEW_INTERVAL_MS).toBe(LEASE_TTL_MS / 3);
    const providerBaseUrl = await startDenseProvider();
    const fetcher: OpenAICompatibleFetch = async (url, init) => {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal as AbortSignal,
      });
      if (response.body === null) {
        return { ok: response.ok, status: response.status, body: null };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          const result = await reader.read();
          if (result.done) {
            const complete = partial + decoder.decode();
            denseState.framesConsumed += complete
              .split("\n\n")
              .filter((frame) => frame.startsWith("data:")).length;
            controller.close();
            return;
          }
          const frames = (
            partial + decoder.decode(result.value, { stream: true })
          ).split("\n\n");
          partial = frames.pop() ?? "";
          denseState.framesConsumed += frames.filter((frame) =>
            frame.startsWith("data:"),
          ).length;
          controller.enqueue(result.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { ok: response.ok, status: response.status, body };
    };
    const app = makeApp(providerBaseUrl, fetcher);
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P32_MIGRATIONS);
        yield* seed;
        yield* admit;
      }),
      app,
    );

    const runningExecution = run(
      runExecution(executionId, { _tag: "Recovery" }, principal),
      app,
    );
    running = runningExecution;
    void runningExecution.catch((error: unknown) => {
      denseState.driverError = error;
    });
    try {
      const leaseAtProviderStart = await waitFor(
        () => denseState.initialLease,
        (lease) => lease !== undefined,
        5_000,
      );
      const initialLease = leaseAtProviderStart;
      if (initialLease === undefined) {
        throw new Error("P9 driver did not observe its acquired lease");
      }
      const deadline = Date.now() + renewalWaitLimitMs;
      let renewed: ReturnType<typeof readLease>;
      let activityAtRenewal:
        | {
            readonly activeResponses: number;
            readonly framesConsumed: number;
            readonly framesWritten: number;
            readonly previousExpiresAt: string;
            readonly renewedExpiresAt: string;
          }
        | undefined;
      let lastObservedExpiresAt = initialLease.expiresAt;
      do {
        if (denseState.driverError !== undefined) {
          throw new Error(
            `ProviderRuntime failed before lease renewal: ${JSON.stringify(denseState.driverError)}; lease=${JSON.stringify({ initial: initialLease, current: readLease(), now: new Date().toISOString() })}; activity=${JSON.stringify({ activeResponses: denseState.activeResponses, requestCount: denseState.requestCount, framesWritten: denseState.framesWritten, framesConsumed: denseState.framesConsumed, frameCapReached: denseState.frameCapReached })}`,
          );
        }
        const current = readLease();
        if (
          current !== undefined &&
          Number(current.generation) === initialLease.generation &&
          Date.parse(current.expires_at) > Date.parse(lastObservedExpiresAt)
        ) {
          const sampledActivity = {
            activeResponses: denseState.activeResponses,
            framesConsumed: denseState.framesConsumed,
            framesWritten: denseState.framesWritten,
            previousExpiresAt: lastObservedExpiresAt,
            renewedExpiresAt: current.expires_at,
          };
          lastObservedExpiresAt = current.expires_at;
          if (
            sampledActivity.activeResponses === 1 &&
            sampledActivity.framesConsumed > 512 &&
            sampledActivity.framesWritten > 512
          ) {
            renewed = current;
            activityAtRenewal = sampledActivity;
            break;
          }
        }
        if (denseState.frameCapReached) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      } while (Date.now() < deadline);

      expect(
        renewed,
        `no committed lease renewal observed; activity=${JSON.stringify({
          driverError: denseState.driverError,
          activeResponses: denseState.activeResponses,
          requestCount: denseState.requestCount,
          framesWritten: denseState.framesWritten,
          framesConsumed: denseState.framesConsumed,
          frameCapReached: denseState.frameCapReached,
        })}`,
      ).toBeDefined();
      expect(renewed?.generation).toBe(initialLease.generation);
      expect(
        Date.parse(renewed?.expires_at ?? "1970-01-01T00:00:00.000Z"),
      ).toBeGreaterThan(Date.parse(initialLease.expiresAt));
      expect(activityAtRenewal).toMatchObject({ activeResponses: 1 });
      expect(activityAtRenewal?.framesConsumed).toBeGreaterThan(512);
      expect(activityAtRenewal?.framesWritten).toBeGreaterThan(512);
      expect(
        Date.parse(activityAtRenewal?.renewedExpiresAt ?? "1970-01-01"),
      ).toBeGreaterThan(
        Date.parse(activityAtRenewal?.previousExpiresAt ?? "9999-12-31"),
      );
      expect(denseState.requestCount).toBe(1);
      expect(denseState.frameCapReached).toBe(false);

      denseState.finishStream = true;
      const settlement = await runningExecution;
      if (settlement._tag !== "Completed") {
        throw new Error(`execution was not completed: ${settlement._tag}`);
      }
      expect(denseState.requestCount).toBe(1);
      expect(denseState.providerResult?.events).toContainEqual(
        expect.objectContaining({
          _tag: "TextDelta",
          text: expect.stringContaining("p9-renewal-result-retained"),
        }),
      );
      expect(denseState.providerResult?.events).toContainEqual(
        expect.objectContaining({
          _tag: "TurnCompleted",
          finishReason: "Stop",
        }),
      );
      const persisted = readProviderState();
      expect(persisted.attempt).toMatchObject({ outcome: "Success" });
      expect(persisted.attempt?.settled_at).not.toBeNull();
      expect(persisted.attempt?.canonical_event_prefix_json).toContain(
        "p9-renewal-result-retained",
      );
      expect(persisted.turn).toMatchObject({ finish_reason: "Stop" });
      expect(persisted.turn?.settled_at).not.toBeNull();
    } finally {
      denseState.finishStream = true;
      await running?.catch(() => undefined);
      running = undefined;
    }
  }, 45_000);
});
