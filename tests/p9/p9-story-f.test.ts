import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P12_MIGRATIONS,
  rebuildProjection,
  runConsumerBatch,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  dependencyCoordinatorLoop,
  pollOnce,
} from "../../packages/application/src/consumer-loop.js";
import {
  p7Project,
  p7SeedProject,
  p7SeedWork,
  p7TestPrincipal,
} from "../support/p7-app.js";
import {
  commitGate,
  gatedTransactionPort,
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "../support/consumer-app-support.js";
import {
  collectDurabilityEvidence,
  type DurabilityEvidence,
} from "../support/p9-durability-evidence.js";
import { labeled } from "../support/p9-harness-api.js";
import { durableFile } from "./support.js";
import {
  armingGateway,
  countEvents,
  countRows,
  F_ASSIGN_CMD_C,
  F_ASSIGN_CMD_P,
  F_DEL,
  F_DEP,
  F_WORK_C,
  F_WORK_P,
  journalEvent,
  journalHead,
  loopStores,
  makeCoordinatorDeps,
  offsetOf,
  preconsume,
  producedPayload,
  seedDependencyAndDeliverable,
} from "./support-fg.js";

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("p9-acceptance", () => {
  it("Story F (06 §F) [crash-injected + durability-asserted]: consumer crash mid-batch replays idempotently, poison dead-letters, reopen evidence reconciles, rebuild floor-refuses / resets / replays idempotently; GQ2 P10 boundary negative", async () => {
    expect(
      labeled("story-F-consumer-rebuild", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const filename = durableFile("f");
    const gate = commitGate();
    const expected = await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const consumer = yield* p7SeedWork(F_WORK_C, F_ASSIGN_CMD_C);
        expect(consumer.resolution._tag).toBe("Committed");
        const producer = yield* p7SeedWork(F_WORK_P, F_ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        yield* seedDependencyAndDeliverable(F_DEP, F_DEL, F_WORK_C, F_WORK_P);
        const head = yield* preconsume("sf1");
        yield* journalEvent(
          "DeliverableProduced",
          producedPayload(F_DEL, F_WORK_P),
        );
        // CC mid-batch: apply committed, advance died at the commit
        // boundary — both roll back, redelivery re-applies idempotently.
        const stores = yield* loopStores;
        const arming = yield* makeCoordinatorDeps((base) =>
          armingGateway(base, gate),
        );
        const failure = yield* pollOnce("sf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            arming,
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(yield* offsetOf("sf1")).toBe(head);
        const clean = yield* makeCoordinatorDeps();
        const replay = yield* pollOnce("sf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            clean,
          ),
        });
        const headAfterSatisfy = yield* journalHead;
        expect(replay.applied).toBe(headAfterSatisfy - head);
        expect(yield* offsetOf("sf1")).toBe(headAfterSatisfy);
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(
          yield* countRows(
            "dependencies",
            "dependency_id = ? AND state = 'Satisfied'",
            [F_DEP],
          ),
        ).toBe(1);
        // Poison: eventVersion above the reader ceiling dead-letters in
        // the same transaction; the batch continues past it.
        yield* journalEvent(
          "DeliverableProduced",
          producedPayload(F_DEL, F_WORK_P),
        );
        yield* journalEvent("WorkspaceCreated", {}, 2);
        const poison = yield* pollOnce("sf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            clean,
          ),
        });
        expect(poison.applied).toBe(1);
        expect(poison.quarantined).toBe(1);
        expect(
          yield* countRows(
            "consumer_dead_letters",
            "consumer_id = ? AND reason LIKE '%unsupported eventVersion%'",
            ["sf1"],
          ),
        ).toBe(1);
        return {
          works: yield* countRows("works"),
          executions: yield* countRows("executions"),
          domain_events: yield* countRows("domain_events"),
          commands: yield* countRows("commands"),
          consumer_offsets: yield* countRows("consumer_offsets"),
        };
      }),
      makeP9ConsumerApp({
        filename,
        transaction: gatedTransactionPort(gate),
      }),
    );
    // Daemon exit (scope closed) → reopen with a fresh connection and
    // collect the frozen five-step durability evidence (02 §12).
    const evidence: DurabilityEvidence =
      await collectDurabilityEvidence(filename);
    expect(
      labeled("story-F-DA-evidence", "durability-asserted").guarantee,
    ).toBe("durability-asserted");
    expect(evidence.guarantee).not.toBe("crash-injected");
    expect(evidence.synchronous).toBe(2);
    expect(evidence.journalMode.toLowerCase()).toBe("wal");
    expect(evidence.integrity).toBe("ok");
    expect(evidence.version).toBe(
      P12_MIGRATIONS.reduce((max, migration) => Math.max(max, migration.id), 0),
    );
    expect(evidence.counts.works).toBe(expected.works);
    expect(evidence.counts.executions).toBe(expected.executions);
    expect(evidence.counts.domain_events).toBe(expected.domain_events);
    expect(evidence.counts.commands).toBe(expected.commands);
    expect(evidence.counts.consumer_offsets).toBe(expected.consumer_offsets);
    // Restart (fresh app on the same durable file): rebuild semantics +
    // the GQ2 P10 boundary negative assertion.
    await runP9Consumer(
      Effect.gen(function* () {
        const businessProjectionSurface =
          /InboxProjection[S]tore|Attention[P]rojection|Attention[V]iew|Waitgraph[V]iew|rebuild[I]nbox|rebuild[A]ttention|rebuild[W]aitGraph/;
        const dir = import.meta.dirname; // tests/p9 (file moved from tests/)
        const p9Suites = [
          ...readdirSync(join(dir, "..")).map(
            (name) => [join(dir, ".."), name] as const,
          ),
          ...readdirSync(dir).map((name) => [dir, name] as const),
        ].filter(
          ([, name]) => name.startsWith("p9-") && name.endsWith(".test.ts"),
        );
        expect(p9Suites.length).toBeGreaterThanOrEqual(13);
        for (const [suiteDir, name] of p9Suites) {
          expect(
            businessProjectionSurface.test(
              readFileSync(join(suiteDir, name), "utf8"),
            ),
            `${name} must not touch business-projection rebuild (P10, GQ2)`,
          ).toBe(false);
        }
        const sql = yield* SqlClient;
        // Establish the rebuild consumer position.
        const consumed = yield* runConsumerBatch("sf_rb", p7Project, 1000);
        expect(consumed.quarantined).toBeGreaterThanOrEqual(1);
        const trueOffset = yield* offsetOf("sf_rb");
        expect(trueOffset).toBe(
          Number(
            (yield* sql.unsafe<{ max: number }>(
              "SELECT MAX(sequence) AS max FROM domain_events WHERE project_id = ?",
              [p7Project],
            ))[0]?.max ?? 0,
          ),
        );
        // Floor refusal: offset regressed below the pruned floor — typed
        // refusal, no partial reset, no state destruction.
        yield* sql.unsafe(
          "DELETE FROM domain_events WHERE project_id = ? AND sequence < 3",
          [p7Project],
        );
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = 1 WHERE consumer_id = ?",
          ["sf_rb"],
        );
        const refused = yield* rebuildProjection("sf_rb", p7Project).pipe(
          Effect.flip,
        );
        expect(refused._tag).toBe("ConsumerRebuildRefused");
        expect(refused).toMatchObject({ offset: 1, floor: 3 });
        expect(yield* offsetOf("sf_rb")).toBe(1);
        // Reset + replay: restore the offset, rebuild from the floor.
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
          [trueOffset, "sf_rb"],
        );
        const retained = yield* sql.unsafe<{
          sequence: number;
          event_version: number;
        }>(
          "SELECT sequence, event_version FROM domain_events WHERE project_id = ? AND sequence >= 3 ORDER BY sequence",
          [p7Project],
        );
        const rebuilt = yield* rebuildProjection("sf_rb", p7Project);
        expect(rebuilt.floor).toBe(3);
        expect(rebuilt.replayed).toBe(retained.length);
        const projection = yield* sql.unsafe<{ sequence: number }>(
          "SELECT sequence FROM projection_state ORDER BY sequence",
        );
        expect(projection.map((row) => Number(row.sequence))).toEqual(
          retained
            .filter((row) => Number(row.event_version) === 1)
            .map((row) => Number(row.sequence)),
        );
        expect(yield* offsetOf("sf_rb")).toBe(trueOffset);
        // Replay idempotency: re-running the rebuild is a no-op delta.
        const again = yield* rebuildProjection("sf_rb", p7Project);
        expect(again).toEqual(rebuilt);
        const projectionAgain = yield* sql.unsafe<{ sequence: number }>(
          "SELECT sequence FROM projection_state ORDER BY sequence",
        );
        expect(projectionAgain).toEqual(projection);
      }),
      makeP9ConsumerApp({ filename }),
    );
  });
});
