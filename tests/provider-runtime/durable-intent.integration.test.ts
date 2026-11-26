// Provider Runtime durable intent, retry safety and resume — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  P16_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { ContextEpochNumber, parse } from "../../packages/domain/src/index.js";
import {
  type CanonicalProviderEvent,
  type ProviderRuntimeExecutionPolicy,
  ProviderTurnStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  client,
  executionId,
  initialize,
  makeHarness,
  manifestJsonFor,
  providerTurnId,
  readAttempt,
  readTurn,
  request,
  runtimeEffect,
  SEMANTIC_TEST_POLICY,
  seed,
  sessionId,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
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
      expect(callEvidence?.policy).toEqual(SEMANTIC_TEST_POLICY);
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
      { ...SEMANTIC_TEST_POLICY, maxAttempts: 2, retryBackoffMs: 0 },
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
      { ...SEMANTIC_TEST_POLICY, maxAttempts: 3, retryBackoffMs: 0 },
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
      { ...SEMANTIC_TEST_POLICY, maxAttempts: 2, retryBackoffMs: 0 },
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
                executionPolicy: SEMANTIC_TEST_POLICY,
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
});
