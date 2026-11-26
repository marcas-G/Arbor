// B3 capability-level tests (docs/engineering/test-effectiveness.md):
// ModelDecisionService is exercised through its Layer via the TestKit
// model-decision harness — no daemon boot, no driver assembly in the test.
// The fake provider scripts one ToolCall turn; the recording ModelContext
// double returns the prepared turn, so `decide()` walks the real
// prepare -> invoke -> decode -> accept path against the sqlite infra.
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  P16_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { WorkspaceKnowledgePortLive } from "../apps/single-workspace/src/workspace-knowledge.js";
import { WorkspacePlacementPortLive } from "../apps/single-workspace/src/workspace-placement.js";
import { ModelDecisionService } from "../packages/agent-runtime/src/index.js";
import { providerTurnInferenceId } from "../packages/domain/dist/index.js";
import {
  SessionRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { makeModelDecisionHarness } from "../packages/testkit/src/index.js";
import {
  contextOf,
  executionOf,
  seed,
  sendHandler,
  sendMessageTurn,
  sessionIds,
  stateOf,
} from "./support/model-decision-fixtures.js";

const makeHarness = () =>
  makeModelDecisionHarness({
    turns: [sendMessageTurn("capability")],
    controlHandlers: [sendHandler],
    workspaceKnowledge: WorkspaceKnowledgePortLive,
    workspacePlacement: WorkspacePlacementPortLive,
  });

const forExecutionInput = {
  execution: executionOf(0),
  agentExecutionState: stateOf(0),
  context: contextOf(0),
  admitProviderTurn: (_operationKind: string, _compiledRequestHash: string) =>
    Effect.succeed({
      activity: { _tag: "ProviderTurn", fingerprint: "capability-test" },
      decision: "Continue",
    } as const),
  completeProviderTurn: () => Effect.succeed("Continue" as const),
  now: () => Effect.succeed("t"),
} as const;

describe("ModelDecisionService capability (B3)", () => {
  it.effect(
    "decide() completes the ToolCall→Ready path with the decoded control call",
    () => {
      const { app } = makeHarness();
      return Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        yield* seed;
        const service = yield* ModelDecisionService;
        const bound = yield* service.forExecution(forExecutionInput);
        const decision = yield* bound.decide({ turn: 0, repairAttempt: 0 });
        expect(decision._tag).toBe("Ready");
        if (decision._tag !== "Ready") return;
        expect(decision.output.finishReason).toBe("ToolCall");
        expect(decision.output.toolInvocations).toHaveLength(1);
        expect(decision.output.toolInvocations[0]?.toolName).toBe(
          "send_message",
        );
        expect(decision.output.toolInvocations[0]?.argumentsJson).toContain(
          "capability",
        );
        expect(decision.turn.manifest.providerTurnId).toBe(
          providerTurnInferenceId(executionOf(0).executionId, 0),
        );
      }).pipe(Effect.provide(app));
    },
  );

  it.effect(
    "journals the accepted model output into the session timeline before any action runs",
    () => {
      const { app } = makeHarness();
      return Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        yield* seed;
        const service = yield* ModelDecisionService;
        const bound = yield* service.forExecution(forExecutionInput);
        const decision = yield* bound.decide({ turn: 0, repairAttempt: 0 });
        expect(decision._tag).toBe("Ready");
        if (decision._tag !== "Ready") return;
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const entries = yield* tx.transact(
          sessions.listRecentEntries(sessionIds[0], 10),
        );
        const accepted = entries.find(
          (entry) => entry.entryKind === "ModelOutput",
        );
        expect(accepted).toBeDefined();
        const payload = accepted?.payload as {
          readonly providerTurnId?: string;
          readonly decoderVersion?: string;
          readonly finishReason?: string;
          readonly toolInvocations?: ReadonlyArray<{
            readonly toolName: string;
            readonly argumentsJson: string;
          }>;
        };
        // The durable record binds to the same provider turn the decision
        // accepted, with the decoded control call — not a re-encoded output.
        expect(payload?.providerTurnId).toBe(
          String(decision.turn.manifest.providerTurnId),
        );
        expect(payload?.decoderVersion).toBe("decode-turn-v1");
        expect(payload?.finishReason).toBe("ToolCall");
        expect(payload?.toolInvocations?.[0]?.toolName).toBe("send_message");
      }).pipe(Effect.provide(app));
    },
  );
});
