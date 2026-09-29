import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  IdGeneratorLive,
  P15_MIGRATIONS,
  ProviderTurnStoreLive,
  runMigrations,
  layer as sqliteLayer,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { providerFakeAdapter } from "../../adapters/provider-fake/src/index.js";
import { providerOpenaiAdapter } from "../../adapters/provider-openai/src/index.js";
import type {
  AdapterDeploymentBinding,
  ProtocolAdapter,
} from "../../packages/ports/dist/provider-extension.js";
import type { ProviderFailure } from "../../packages/ports/src/errors.js";
import type {
  CanonicalProviderEvent,
  PortableModelRequest,
  ProviderExecutionContext,
  ProviderPortEvent,
} from "../../packages/ports/src/provider.js";
import {
  ProviderPort,
  ProviderRuntime,
} from "../../packages/ports/src/provider.js";
import { ProviderRuntimeLive } from "../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../packages/testkit/src/index.js";

/**
 * P16 `02` E3 — Provider Conformance Suite (A1..A10).
 *
 * Written against the frozen `ProtocolAdapter` contract, never against a
 * concrete family. A family registers as a compatible provider by passing
 * this suite via injected transport doubles — this IS the mechanical
 * definition of "compatible" (INV-P16-5 / qualification Q1).
 */

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const makeRequest = (): PortableModelRequest => ({
  modelRef: "model-conformance",
  instructions: [{ slotId: "sys", authorityRole: "System", text: "sys" }],
  messages: [{ role: "user", text: "conformance" }],
  toolDefinitions: [],
  outputContractRef: "completion-claim-v1",
  budget: { maxOutputTokens: 64 },
  cacheHints: [],
});

const makeContext = (
  overrides: Partial<ProviderExecutionContext> = {},
): ProviderExecutionContext => ({
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789c0" as never,
  attemptNo: 0,
  cancellationSignal: new AbortController().signal,
  connectTimeoutMs: 2_000,
  firstEventTimeoutMs: 2_000,
  streamIdleTimeoutMs: 2_000,
  turnDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
  maxAttempts: 3,
  ...overrides,
});

const collectWith = (
  adapter: ProtocolAdapter,
  binding: AdapterDeploymentBinding,
  context: ProviderExecutionContext,
): Effect.Effect<ReadonlyArray<ProviderPortEvent>, ProviderFailure, never> =>
  Effect.gen(function* () {
    const service = yield* ProviderPort;
    return yield* Stream.runCollect(
      service.runTurn({ request: makeRequest(), context }),
    );
  }).pipe(
    Effect.provide(adapter.layerFor(binding)),
  ) as unknown as Effect.Effect<
    ReadonlyArray<ProviderPortEvent>,
    ProviderFailure,
    never
  >;

const collect = async (
  adapter: ProtocolAdapter,
  binding: AdapterDeploymentBinding,
  context: ProviderExecutionContext = makeContext(),
): Promise<ProviderPortEvent[]> => [
  ...(await Effect.runPromise(collectWith(adapter, binding, context))),
];

const collectFailure = async (
  adapter: ProtocolAdapter,
  binding: AdapterDeploymentBinding,
  context: ProviderExecutionContext = makeContext(),
): Promise<ProviderFailure> =>
  Effect.runPromise(Effect.flip(collectWith(adapter, binding, context)));

const canonicalOf = (events: ReadonlyArray<ProviderPortEvent>) =>
  events
    .filter(
      (event): event is Extract<ProviderPortEvent, { _tag: "Canonical" }> =>
        event._tag === "Canonical",
    )
    .map((event) => event.event);

const textOf = (events: ReadonlyArray<CanonicalProviderEvent>) =>
  events
    .filter(
      (
        event,
      ): event is Extract<CanonicalProviderEvent, { _tag: "TextDelta" }> =>
        event._tag === "TextDelta",
    )
    .map((event) => event.text)
    .join("");

// SSE transport double for openai-chat-completions-sse -----------------------

const sse = (payloads: ReadonlyArray<string>): string =>
  payloads.map((payload) => `data: ${payload}\n\n`).join("") +
  "data: [DONE]\n\n";

const jsonChunks = (deltas: ReadonlyArray<string>): ReadonlyArray<string> =>
  deltas.map((delta) =>
    JSON.stringify({ choices: [{ delta: { content: delta } }] }),
  );

type FetchDouble = (
  url: unknown,
  request: { readonly signal?: unknown },
) => Promise<unknown>;

const fetchOf = (
  body: string,
  init: { status?: number; chunkSize?: number; hang?: boolean } = {},
): FetchDouble => {
  const status = init.status ?? 200;
  const chunkSize = init.chunkSize ?? Number.POSITIVE_INFINITY;
  return (_url, request) =>
    new Promise((resolve, reject) => {
      const signal = request.signal as
        | {
            addEventListener: (type: string, fn: () => void) => void;
            readonly aborted: boolean;
          }
        | undefined;
      const onAbort = () => reject(new TypeError("fetch aborted"));
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      if (init.hang === true) {
        return;
      }
      if (status >= 400) {
        resolve({
          ok: false,
          status,
          json: () => Promise.resolve({ error: { message: "err" } }),
        });
        return;
      }
      const bytes = new TextEncoder().encode(body);
      const parts: Uint8Array[] = [];
      for (let index = 0; index < bytes.length; index += chunkSize) {
        parts.push(bytes.slice(index, index + chunkSize));
      }
      resolve({
        ok: true,
        status,
        body: {
          getReader: () => {
            let position = 0;
            return {
              read: () =>
                new Promise((res) => {
                  setTimeout(() => {
                    if (position >= parts.length) {
                      res({ done: true, value: undefined });
                      return;
                    }
                    res({ done: false, value: parts[position] });
                    position += 1;
                  }, 0);
                }),
              releaseLock: () => {},
            };
          },
        },
      });
    });
};

const openaiBinding = (fetch: FetchDouble): AdapterDeploymentBinding => ({
  endpoint: "http://conformance.test/v1",
  wireModelName: "conformance-model",
  // Conformance transport is a local double — the explicit unauthenticated
  // exemption (P16 `01` §3). A7 exercises the fail-closed path separately.
  transportOverride: { fetch, allowUnauthenticated: true },
});

const openaiAuthBinding = (fetch: FetchDouble): AdapterDeploymentBinding => ({
  endpoint: "http://conformance.test/v1",
  wireModelName: "conformance-model",
  transportOverride: { fetch },
});

const fakeBinding = (
  events: ReadonlyArray<CanonicalProviderEvent>,
): AdapterDeploymentBinding => ({
  transportOverride: { turns: [events] },
});

// ---------------------------------------------------------------------------
// conformance targets (register a new family by adding a target here)
// ---------------------------------------------------------------------------

interface ConformanceTarget {
  readonly name: string;
  readonly adapter: ProtocolAdapter;
}

const TARGETS: ReadonlyArray<ConformanceTarget> = [
  { name: "provider-openai", adapter: providerOpenaiAdapter },
  { name: "provider-fake", adapter: providerFakeAdapter },
];

/** P16 E4a: a compatible provider under an existing protocol family reuses
 * the unchanged adapter; only profile/deployment/qualification data was
 * added. This target IS the mechanical evidence that the same adapter
 * serves the new deployment. */
const COMPAT_ECHO_TARGET: ConformanceTarget = {
  name: "provider-openai@dep-openai-compat-echo",
  adapter: providerOpenaiAdapter,
};

const isNetwork = (adapter: ProtocolAdapter): boolean =>
  adapter.profile.protocolFamily !== "in-process-deterministic";

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe.each([...TARGETS, COMPAT_ECHO_TARGET])("P16 E3 conformance — $name", ({ adapter }) => {
  it("A1 text-delta-order: deltas arrive in order and aggregate exactly", async () => {
    const expected = "Arbor conformance delta stream.";
    const events = isNetwork(adapter)
      ? canonicalOf(
          await collect(
            adapter,
            openaiBinding(fetchOf(sse(jsonChunks([expected])))),
          ),
        )
      : canonicalOf(
          await collect(
            adapter,
            fakeBinding([
              ...expected.split("").map<CanonicalProviderEvent>((char) => ({
                _tag: "TextDelta",
                text: char,
              })),
              { _tag: "TurnCompleted", finishReason: "Stop" },
            ]),
          ),
        );
    expect(textOf(events)).toBe(expected);
  });

  it("A2 tool-call-reassembly: sharded/parallel tool calls reassemble with isolated argument streams", async () => {
    const events = isNetwork(adapter)
      ? canonicalOf(
          await collect(
            adapter,
            openaiBinding(
              fetchOf(
                sse([
                  JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-a",
                              function: { name: "read", arguments: '{"path":' },
                            },
                          ],
                        },
                      },
                    ],
                  }),
                  JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 1,
                              id: "call-b",
                              function: { name: "list", arguments: '{"q":"' },
                            },
                          ],
                        },
                      },
                    ],
                  }),
                  JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            { index: 0, function: { arguments: '"x"}' } },
                          ],
                        },
                      },
                    ],
                  }),
                  JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            { index: 1, function: { arguments: 'z"}' } },
                          ],
                        },
                      },
                    ],
                  }),
                  JSON.stringify({
                    choices: [{ finish_reason: "tool_calls" }],
                  }),
                  JSON.stringify({
                    usage: { prompt_tokens: 5, completion_tokens: 7 },
                  }),
                ]),
              ),
            ),
          ),
        )
      : canonicalOf(
          await collect(
            adapter,
            fakeBinding([
              {
                _tag: "ToolCallProposed",
                callRef: "call-a",
                toolName: "read",
                argumentsJson: '{"path":"x"}',
              },
              {
                _tag: "ToolCallProposed",
                callRef: "call-b",
                toolName: "list",
                argumentsJson: '{"q":"z"}',
              },
              { _tag: "TurnCompleted", finishReason: "ToolCall" },
            ]),
          ),
        );
    const calls = events.filter(
      (
        event,
      ): event is Extract<
        CanonicalProviderEvent,
        { _tag: "ToolCallProposed" }
      > => event._tag === "ToolCallProposed",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.callRef).toBe("call-a");
    expect(calls[0]?.argumentsJson).toBe('{"path":"x"}');
    expect(calls[1]?.callRef).toBe("call-b");
    expect(calls[1]?.argumentsJson).toBe('{"q":"z"}');
  });

  it("A3 sse-arbitrary-chunking: byte-level chunking is lossless", async () => {
    if (!isNetwork(adapter)) {
      return;
    }
    const body = sse(
      jsonChunks(["chunked stream must survive arbitrary splits"]),
    );
    const whole = textOf(
      canonicalOf(await collect(adapter, openaiBinding(fetchOf(body)))),
    );
    const split = textOf(
      canonicalOf(
        await collect(adapter, openaiBinding(fetchOf(body, { chunkSize: 7 }))),
      ),
    );
    expect(split).toBe(whole);
    expect(whole).toContain("arbitrary splits");
  });

  it("A4 usage-extraction: prompt/completion tokens surface as UsageReported", async () => {
    const events = isNetwork(adapter)
      ? canonicalOf(
          await collect(
            adapter,
            openaiBinding(
              fetchOf(
                sse([
                  JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
                  JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
                  JSON.stringify({
                    usage: { prompt_tokens: 11, completion_tokens: 13 },
                  }),
                ]),
              ),
            ),
          ),
        )
      : canonicalOf(
          await collect(
            adapter,
            fakeBinding([
              { _tag: "UsageReported", inputTokens: 11, outputTokens: 13 },
              { _tag: "TurnCompleted", finishReason: "Stop" },
            ]),
          ),
        );
    const usage = events.find(
      (
        event,
      ): event is Extract<CanonicalProviderEvent, { _tag: "UsageReported" }> =>
        event._tag === "UsageReported",
    );
    expect(usage?.inputTokens).toBe(11);
    expect(usage?.outputTokens).toBe(13);
  });

  it("A5 error-taxonomy-table: failures classify into the closed union; no SDK type leaks", async () => {
    if (!isNetwork(adapter)) {
      // In-process family: failures pass through as the injected kinds.
      for (const kind of ["RateLimited", "ProviderUnavailable"] as const) {
        const failure = await collectFailure(
          adapter,
          fakeBinding([{ _tag: "TextDelta", text: "x" }]).transportOverride ===
            undefined
            ? fakeBinding([])
            : {
                ...fakeBinding([{ _tag: "TextDelta", text: "x" }]),
                transportOverride: {
                  turns: [{ _tag: "TextDelta", text: "x" }],
                  failures: [kind],
                },
              },
        );
        expect(failure.kind).toBe(kind);
      }
      return;
    }
    const table: ReadonlyArray<[number, string]> = [
      [401, "AuthenticationFailed"],
      [403, "AuthorizationFailed"],
      [429, "RateLimited"],
      [400, "RequestRejected"],
      [500, "ProviderUnavailable"],
    ];
    for (const [status, expectedKind] of table) {
      const failure = await collectFailure(
        adapter,
        openaiBinding(fetchOf("", { status })),
      );
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: expectedKind,
      });
      for (const key of Object.keys(failure)) {
        expect(
          ["_tag", "kind", "safeDiagnostic", "taxonomyVersion"].includes(key),
          `unexpected failure field "${key}"`,
        ).toBe(true);
      }
      expect(JSON.stringify(failure)).not.toContain("OpenAISdkError");
    }
    const transportFailure = await collectFailure(
      adapter,
      openaiBinding((_url, request) => {
        void request;
        return Promise.reject(new TypeError("fetch reset"));
      }),
    );
    expect(transportFailure.kind).toBe("TransportFailed");
  });

  it("A6 cancellation-propagation: an aborted signal stops production before completion", async () => {
    if (!isNetwork(adapter)) {
      expect(adapter.profile.protocolFamily).toBe("in-process-deterministic");
      return;
    }
    const controller = new AbortController();
    controller.abort();
    let completed = false;
    const outcome = await Effect.runPromiseExit(
      collectWith(
        adapter,
        openaiBinding(fetchOf(sse(jsonChunks(["x"])))),
        makeContext({ cancellationSignal: controller.signal }),
      ),
    );
    if (outcome._tag === "Success") {
      completed = outcome.value.some(
        (event) =>
          event._tag === "Canonical" && event.event._tag === "TurnCompleted",
      );
    }
    expect(completed).toBe(false);
  });

  it("A7 auth-fail-closed: BearerSecret without a credential refuses; explicit None is the only exemption", async () => {
    if (adapter.profile.authMode._tag !== "BearerSecret") {
      expect(adapter.profile.authMode._tag).toBe("None");
      return;
    }
    const failure = await collectFailure(
      adapter,
      openaiAuthBinding(fetchOf("")),
    );
    expect(failure).toMatchObject({
      _tag: "ProviderFailure",
      kind: "AuthenticationFailed",
    });
  });

  it("A8 deadline: an expired turnDeadlineAt fails fast instead of streaming", async () => {
    if (!isNetwork(adapter)) {
      return;
    }
    const failure = await collectFailure(
      adapter,
      openaiBinding(fetchOf(sse(jsonChunks(["x"])), { hang: true })),
      makeContext({ turnDeadlineAt: new Date(Date.now() - 1).toISOString() }),
    );
    expect(failure.kind).toBeDefined();
    expect(failure.kind).not.toBe("RequestRejected");
  });

  it("A10 contract-noise-drop: only frozen event tags and observation keys cross the port", async () => {
    const events = isNetwork(adapter)
      ? await collect(
          adapter,
          openaiBinding(
            fetchOf(
              sse([
                JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
                JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
              ]),
            ),
          ),
        )
      : await collect(
          adapter,
          fakeBinding([
            { _tag: "TextDelta", text: "ok" },
            { _tag: "TurnCompleted", finishReason: "Stop" },
          ]),
        );
    const canonicalTags = new Set([
      "TurnStarted",
      "TextDelta",
      "ReasoningDelta",
      "ToolCallProposed",
      "UsageReported",
      "ContinuationState",
      "TurnCompleted",
      "TurnFailed",
    ]);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event._tag === "Canonical" || event._tag === "Observation").toBe(
        true,
      );
      if (event._tag === "Canonical") {
        expect(canonicalTags.has(event.event._tag)).toBe(true);
      } else {
        expect(
          Object.keys(event.delta).every((key) =>
            [
              "responseStarted",
              "externalEffectPossible",
              "firstDataEventSeen",
              "consumerVisibleOutput",
              "canonicalEventEmitted",
              "toolCallProposed",
              "continuationAvailable",
            ].includes(key),
          ),
        ).toBe(true);
      }
    }
  });
});

const SEED_IDS = {
  projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789c2",
  workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789c2",
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
  executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
};

const seedForeignKeys = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          SEED_IDS.projectId,
          "p16",
          SEED_IDS.workspaceId,
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
        [SEED_IDS.sessionId, "WorkspacePrimary", SEED_IDS.workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          SEED_IDS.workspaceId,
          SEED_IDS.projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          SEED_IDS.sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          SEED_IDS.executionId,
          SEED_IDS.projectId,
          "workspace",
          SEED_IDS.workspaceId,
          "coordination",
          SEED_IDS.sessionId,
          "t",
        ],
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// A9 observation-persistence (ProviderRuntime fixture, every target)
// ---------------------------------------------------------------------------

describe("P16 E3 conformance — A9 observation-persistence", () => {
  it.each(TARGETS)(
    "A9 $name: a completed turn persists provider_turns and provider_attempts rows",
    { timeout: 20_000 },
    async ({ adapter }) => {
      const binding =
        adapter.adapterId === "provider-openai"
          ? openaiBinding(
              fetchOf(
                sse([
                  JSON.stringify({
                    choices: [{ delta: { content: "persisted" } }],
                  }),
                  JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
                  JSON.stringify({
                    usage: { prompt_tokens: 3, completion_tokens: 4 },
                  }),
                ]),
              ),
            )
          : fakeBinding([
              {
                _tag: "TurnStarted",
                providerTurnId:
                  "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
                attemptNo: 0,
                modelRef: "model-conformance",
              },
              { _tag: "TextDelta", text: "persisted" },
              { _tag: "TurnCompleted", finishReason: "Stop" },
            ]);
      const base = sqliteLayer({ filename: ":memory:" });
      const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
      const providerLayer = adapter.layerFor(binding);
      const runtimeDeps = Layer.mergeAll(
        providerLayer,
        Layer.provide(ProviderTurnStoreLive, infra),
        Layer.provide(TransactionPortLive, infra),
        FixedSecretStoreLive(),
        infra,
      );
      const app = Layer.mergeAll(
        infra,
        Layer.provide(ProviderRuntimeLive(), runtimeDeps),
        Layer.provide(ProviderTurnStoreLive, infra),
      );
      const program = Effect.gen(function* () {
        yield* runMigrations(P15_MIGRATIONS);
        yield* seedForeignKeys;
        const runtimeService = yield* ProviderRuntime;
        const result = yield* runtimeService.runTurn({
          providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
          executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
          sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
          contextEpoch: 0 as never,
          modelRef: "model-conformance",
          outputContractRef: "completion-claim-v1",
          manifestJson: JSON.stringify({
            providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1",
            executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
            sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
            contextEpoch: 0,
            modelRef: "model-conformance",
            outputContractRef: "completion-claim-v1",
            compiledRequestHash: "p16-conformance",
            providerRef: adapter.adapterId,
          }),
          request: makeRequest(),
        });
        const sql = yield* SqlClient;
        const turns = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM provider_turns WHERE settled_at IS NOT NULL",
        );
        const attempts = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM provider_attempts",
        );
        return {
          events: result.events.length,
          turns: Number(turns[0]?.count ?? 0),
          attempts: Number(attempts[0]?.count ?? 0),
        };
      });
      const outcome = (await Effect.runPromise(
        Effect.provide(program as never, app as never) as never,
      )) as { turns: number; attempts: number; events: number };
      expect(outcome.turns).toBe(1);
      expect(outcome.attempts).toBeGreaterThanOrEqual(1);
      expect(outcome.events).toBeGreaterThan(0);
    },
  );
});


// ---------------------------------------------------------------------------
// P16 E4a + E5 — compatible-provider deployment qualification (offline proof)
// ---------------------------------------------------------------------------

const qualificationModule = await import("../../packages/ports/dist/provider-extension.js");

describe("P16 E4a/E5 — dep-openai-compat-echo qualification", () => {
  it("resolves through the unchanged registry/catalog and binds the exact fingerprint", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolveModelBinding, resolvedModelBindingFingerprint } = qualificationModule;
    const deployment = JSON.parse(
      readFileSync(
        new URL("../../planning/testing/provider-qualification/dep-openai-compat-echo/deployment.json", import.meta.url),
        "utf8",
      ),
    ) as import("../../packages/ports/dist/provider-extension.js").ModelDeployment;
    const registry = makeRegistryForQualification();
    const catalog = await catalogForQualification();
    const resolved = resolveModelBinding(registry, catalog, deployment);
    if ("_tag" in resolved) {
      throw new Error(`resolution failed: ${JSON.stringify(resolved)}`);
    }
    expect(resolved.adapter.adapterId).toBe("provider-openai");
    expect(resolved.capability.contextWindow).toBe(64000);
    expect(resolved.executionPolicy.connectTimeoutMs).toBe(10_000);
    const fingerprint = resolvedModelBindingFingerprint(resolved);
    const qualification = JSON.parse(
      readFileSync(
        new URL("../../planning/testing/provider-qualification/dep-openai-compat-echo/qualification.json", import.meta.url),
        "utf8",
      ),
    ) as { bindingFingerprint: string; identity: Record<string, string> };
    expect(qualification.bindingFingerprint).toBe(fingerprint);
    expect(qualification.identity.providerSite).toBe(deployment.endpoint);
    expect(qualification.identity.wireModelName).toBe(deployment.wireModelName);
  });
});

async function catalogForQualification() {
  const module = await import("../../packages/model-context/src/model-catalog.data.js");
  return module.DEFAULT_MODEL_CATALOG;
}

function makeRegistryForQualification() {
  // Registry assembly mirrors the Composition-Root table (declaration-only);
  // the adapter values are unchanged production exports. makeProviderRegistry
  // arrives via the already-imported module namespace below.
  const { makeProviderRegistry } = qualificationModule;
  return makeProviderRegistry([providerOpenaiAdapter, providerFakeAdapter]);
}
