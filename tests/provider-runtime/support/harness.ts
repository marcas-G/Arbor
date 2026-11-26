// Shared Provider Runtime Phase 1 integration harness — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duration, Effect, Clock as EffectClock, Layer } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P16_MIGRATIONS,
  ProviderTurnStoreLive,
  RuntimeClockLive,
  runMigrations,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  OpenAIProviderLive,
  type OpenAISdkChunk,
  type OpenAISdkClient,
} from "../../../adapters/provider-openai/src/index.js";
import {
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import type { ProviderExecutionContext } from "../../../packages/ports/dist/provider.js";
import {
  type ProviderRunInput,
  ProviderRuntime,
  type ProviderRuntimeExecutionPolicy,
  RuntimeClock,
} from "../../../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../../packages/testkit/src/index.js";

export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
export const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
export const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
export const nextProviderTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789e2",
);

export const request = {
  modelRef: "controlled-provider-model",
  instructions: [],
  messages: [{ role: "user" as const, text: "probe" }],
  toolDefinitions: [],
  outputContractRef: "tool-invocation-v1",
  budget: { maxOutputTokens: 128 },
  cacheHints: [],
};

export const manifestJsonFor = (turnId: ProviderTurnId) =>
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

export const SEMANTIC_TEST_POLICY: ProviderRuntimeExecutionPolicy = {
  // These integration cases exercise cancellation, protocol/error mapping,
  // retry evidence, and persistence—not deadline thresholds. Keep their
  // watchdogs bounded, but leave enough room for a loaded multi-worker check.
  // Deadline behavior is asserted with explicit policies below.
  connectTimeoutMs: 10_000,
  firstEventTimeoutMs: 10_000,
  streamIdleTimeoutMs: 10_000,
  turnTimeoutMs: 20_000,
  maxAttempts: 2,
  retryBackoffMs: 0,
};

export interface AttemptSnapshot {
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

export interface TurnSnapshot {
  readonly manifest_id: string;
  readonly execution_policy_json: string | null;
  readonly turn_deadline_at: string | null;
  readonly settled_at: string | null;
  readonly finish_reason: string | null;
}

export const waitForSignal = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

export const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

export const withWatchdog = async <A>(
  promise: Promise<A>,
  label: string,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const seed = Effect.gen(function* () {
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

export const makeHarness = (
  client: OpenAISdkClient,
  policy: ProviderRuntimeExecutionPolicy = SEMANTIC_TEST_POLICY,
  options: {
    readonly controlledClock?: boolean;
    readonly onClockSleep?: (durationMs: number, sequence: number) => void;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "provider-runtime-phase1-"));
  const databaseFile = join(root, "provider.db");
  const base = layer({ filename: databaseFile });
  let clockSleepSequence = 0;
  const controlledClock = options.controlledClock
    ? Layer.provideMerge(
        Layer.effect(
          EffectClock.Clock,
          Effect.gen(function* () {
            const clock = yield* EffectClock.Clock;
            return {
              ...clock,
              sleep: (duration: Parameters<typeof clock.sleep>[0]) => {
                clockSleepSequence += 1;
                options.onClockSleep?.(
                  Duration.toMillis(duration),
                  clockSleepSequence,
                );
                return clock.sleep(duration);
              },
            };
          }),
        ),
        TestClock.layer({ warningDelay: "10 seconds" }),
      )
    : undefined;
  const controlledRuntimeClock =
    controlledClock === undefined
      ? undefined
      : Layer.effect(
          RuntimeClock,
          Effect.gen(function* () {
            const clock = yield* EffectClock.Clock;
            return RuntimeClock.of({
              epochMillis: () => clock.currentTimeMillisUnsafe(),
              monotonicMillis: () =>
                Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
            });
          }),
        ).pipe(Layer.provideMerge(controlledClock));
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    IdGeneratorLive,
    ...(controlledRuntimeClock === undefined
      ? [RuntimeClockLive]
      : [controlledRuntimeClock]),
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

export const initialize = async (
  harness: ReturnType<typeof makeHarness>,
): Promise<void> =>
  harness.run(
    Effect.gen(function* () {
      yield* runMigrations(P16_MIGRATIONS);
      yield* seed;
    }),
  );

export const readAttempt = (
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

export const readTurn = (databaseFile: string): TurnSnapshot | undefined => {
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

export const runtimeEffect = (
  signal?: AbortSignal,
  policyOverrides?: Partial<ProviderRuntimeExecutionPolicy>,
  turnId = providerTurnId,
  onProgress?: ProviderRunInput["onProgress"],
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
      ...(onProgress === undefined ? {} : { onProgress }),
    });
  });

export const client = (options: {
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
