import {
  Actor,
  CommandId,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import {
  Clock,
  CommandStore,
  DomainEventJournal,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P1_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const base = layer({ filename: ":memory:" });
const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
const app = Layer.mergeAll(
  infra,
  Layer.provide(TransactionPortLive, infra),
  Layer.provide(CommandStoreLive, infra),
  Layer.provide(DomainEventJournalLive, infra),
);

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const fingerprint = parse(SemanticRequestFingerprint)("fp");
const actor = parse(Actor)("user:test");

const program = Effect.gen(function* () {
  yield* runMigrations(P1_MIGRATIONS);
  const tx = yield* TransactionPort;
  const store = yield* CommandStore;
  const journal = yield* DomainEventJournal;
  return yield* tx.transact(
    Effect.gen(function* () {
      yield* store.insertCommitted(
        commandId,
        projectId,
        fingerprint,
        "1",
        1,
        JSON.stringify({ ok: true }),
      );
      const receipt = yield* store.findResolution(commandId);
      yield* store.recordResolvingAttempt(commandId, "Committed", "t0", "t1");
      yield* store.recordRetryableAttempt(commandId, "busy", "t2", "t3");

      yield* journal.append([
        {
          projectId,
          eventType: "ProjectCreated",
          eventVersion: 1,
          occurredAt: "t",
          aggregateRef: projectId,
          actor,
          payload: { a: 1 },
        },
        {
          projectId,
          eventType: "WorkspaceCreated",
          eventVersion: 1,
          occurredAt: "t",
          aggregateRef: projectId,
          actor,
          payload: { b: 2 },
        },
      ]);
      const last = yield* journal.lastSequence(projectId);
      const events = yield* journal.readAfter(projectId, 0, 10);
      return {
        receipt,
        last,
        sequences: events.map((event) => event.sequence),
        types: events.map((event) => event.eventType),
      };
    }),
  );
});

describe("command store & domain event journal", () => {
  it("persists command resolution, attempts, and sequenced events", async () => {
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Option.isSome(result.receipt)).toBe(true);
    if (Option.isSome(result.receipt)) {
      expect(result.receipt.value.resolution._tag).toBe("Committed");
      expect(result.receipt.value.semanticRequestFingerprint).toBe("fp");
    }
    expect(result.last).toBe(2);
    expect(result.sequences).toEqual([1, 2]);
    expect(result.types).toEqual(["ProjectCreated", "WorkspaceCreated"]);
  });
});
