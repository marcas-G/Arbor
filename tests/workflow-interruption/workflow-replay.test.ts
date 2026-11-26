import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { satisfactionCommandId } from "../../packages/application/src/commands/satisfy-dependency.js";
import {
  completionConsumerLoop,
  dependencyCoordinatorLoop,
  pollOnce,
  verificationConsumerLoop,
} from "../../packages/application/src/consumer-loop.js";
import { CommandGateway } from "../../packages/application/src/index.js";
import { verificationSpawnIds } from "../../packages/application/src/verification-consumer.js";
import {
  ensureVerifierSpawned,
  verifierAdmitCommandId,
} from "../../packages/application/src/verifier-spawn.js";
import {
  type Principal,
  startVerification,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  ExecutionRepository,
  TransactionPort,
  VerificationRepository,
} from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";
import {
  makeP9ConsumerApp,
  runP9Consumer,
} from "../support/consumer-app-support.js";
import { labeled } from "../support/harness-api.js";
import {
  ACC,
  ASSIGN_CMD_P,
  countEvents,
  countRows,
  DEL_W1,
  DEP_W1,
  journalEvent,
  loopStores,
  MISSION,
  makeCompletionDeps,
  makeCoordinatorDeps,
  makeVerificationDeps,
  offsetOf,
  preconsume,
  REV,
  seedDependencyAndDeliverable,
  seedProjectAndWork,
  transientOnceGateway,
  VER,
  WORK_1,
  WORK_P,
  WREV,
} from "./support.js";

describe("-workflow-interruption (WF1–WF3 / DF1–DF2 / D5)", () => {
  it("WF1 [crash-injected]: coordinator consumption interrupted before the SatisfyDependency commit — redelivery converges to the identical canonical state", async () => {
    expect(
      labeled("WF1-coordinator-interruption", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const producer = yield* p7SeedWork(WORK_P, ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        yield* seedDependencyAndDeliverable;
        const head = yield* preconsume("wf1");
        yield* journalEvent("DeliverableProduced", {
          deliverableId: DEL_W1,
          sourceWorkId: WORK_P,
          sourceWorkRevision: 0,
          kind: "report",
          artifactRoles: ["summary"],
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "SatisfyDependency");
        const failure = yield* pollOnce("wf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps((_base) => interrupted.gateway),
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        // Nothing durable from the interruption: no command, no
        // satisfaction, offset stays.
        const satisfyCommandId = satisfactionCommandId(DEL_W1, DEP_W1, REV(0));
        expect(
          yield* countRows("commands", "command_id = ?", [satisfyCommandId]),
        ).toBe(0);
        expect(yield* countEvents("DependencySatisfied")).toBe(0);
        expect(yield* offsetOf("wf1")).toBe(head);
        // Redelivery (next dispatcher round) converges.
        const result = yield* pollOnce("wf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps(),
          ),
        });
        expect(result.records).toContain("SatisfyDependency");
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(
          yield* countRows(
            "dependencies",
            "dependency_id = ? AND state = 'Satisfied' AND satisfied_by_deliverable_id IS NOT NULL",
            [DEP_W1],
          ),
        ).toBe(1);
        expect(yield* offsetOf("wf1")).toBe(head + 1);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("WF2 [crash-injected]: verifier spawn window closure — replay emits the needSpawn hint, re-spawn uses the same caller-preallocated id, AdmitExecution idempotent, no committed-without-Verifier state", async () => {
    expect(
      labeled("WF2-verifier-spawn-window", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const claimRef = "claim-wf2";
        const head = yield* preconsume("wf2");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-000000000002",
          workId: WORK_1,
          workRevision: 0,
          claimRef,
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const deps = yield* makeVerificationDeps(gateway);
        const first = yield* pollOnce("wf2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(first.records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_1, 0, claimRef);
        // Crash window fixture: the StartVerification commit landed, the
        // spawn/backfill did not (un-backfilled Open row, no execution).
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE verifications SET verification_execution_ids = '[]' WHERE verification_id = ?",
          [ids.verificationId],
        );
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(0);
        // Replay: redelivery yields the needSpawn hint (no new
        // verification, no journal burn).
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
          [head, "wf2"],
        );
        const replay = yield* pollOnce("wf2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(replay.records).toEqual([
          `needSpawn:${ids.verificationId}:${ids.verifierExecutionId}`,
        ]);
        expect(yield* countRows("verifications")).toBe(1);
        // Apply the hint with the SAME caller-preallocated id.
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        const executions = yield* ExecutionRepository;
        const clock = yield* Clock;
        const stored = yield* tx.transact(
          verifications.findById(ids.verificationId),
        );
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isNone(stored)) {
          return;
        }
        const verification = stored.value;
        const spawnDeps = {
          gateway,
          verifications,
          executions,
          tx,
          clock,
          principal: p7TestPrincipal as Principal,
        };
        const args = {
          verification,
          projectId: p7Project,
          ownerWorkspaceId: p7RootWorkspace,
          verifierExecutionId: ids.verifierExecutionId,
          missionDigest: "wf2",
        };
        const spawned = yield* ensureVerifierSpawned(args, spawnDeps);
        expect(spawned._tag).toBe("Spawned");
        expect(spawned._tag === "Spawned" ? spawned.admitted : false).toBe(
          true,
        );
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(1);
        // Idempotent re-entry: Noop, no duplicate execution, backfill
        // present — no permanent committed-without-Verifier state.
        const again = yield* ensureVerifierSpawned(args, spawnDeps);
        expect(again._tag).toBe("Noop");
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(1);
        expect(
          yield* countRows("commands", "command_id = ?", [
            verifierAdmitCommandId(ids.verificationId, ids.verifierExecutionId),
          ]),
        ).toBe(1);
        const backfilled = yield* tx.transact(
          verifications.findById(ids.verificationId),
        );
        expect(
          Option.isSome(backfilled)
            ? backfilled.value.verificationExecutionIds
            : [],
        ).toEqual([ids.verifierExecutionId]);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("WF3a [crash-injected]: consumer A interrupted before the StartVerification commit — replay converges, exactly one Verification", async () => {
    expect(labeled("WF3-consumer-a", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const head = yield* preconsume("wf3a");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-00000000000a",
          workId: WORK_1,
          workRevision: 0,
          claimRef: "claim-wf3a",
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "StartVerification");
        const deps = yield* makeVerificationDeps(interrupted.gateway);
        const failure = yield* pollOnce("wf3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, deps),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        expect(yield* countRows("verifications")).toBe(0);
        expect(yield* countEvents("VerificationStarted")).toBe(0);
        expect(yield* offsetOf("wf3a")).toBe(head);
        // Replay converges: exactly one verification, one event.
        const clean = yield* makeVerificationDeps(gateway);
        const result = yield* pollOnce("wf3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, clean),
        });
        expect(result.records).toEqual(["StartVerification"]);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countEvents("VerificationStarted")).toBe(1);
        expect(yield* offsetOf("wf3a")).toBe(head + 1);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("WF3b [crash-injected]: consumer B interrupted before the CompleteWork commit — replay converges, exactly one Completion", async () => {
    expect(labeled("WF3-consumer-b", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        const sql = yield* SqlClient;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER(31),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              missionSnapshot: MISSION,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* tx.transact(
          verifications.concludeIfOpen(
            VER(31),
            "Pass",
            "summary:test",
            undefined,
          ),
        );
        yield* sql.unsafe(
          "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,'t')",
          [ACC(31), p7Project, WORK_1, 0, VER(31), p7TestActor],
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
          [WORK_1, p7RootWorkspace],
        );
        const head = yield* preconsume("wf3b");
        yield* journalEvent("WorkOutcomeAccepted", {
          acceptanceId: ACC(31),
          workId: WORK_1,
          targetWorkRevision: 0,
          verificationId: VER(31),
          actor: p7TestActor,
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "CompleteWork");
        const deps = yield* Effect.gen(function* () {
          const base = yield* makeCompletionDeps();
          return { ...base, gateway: interrupted.gateway };
        });
        const failure = yield* pollOnce("wf3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(p7Project, p7TestPrincipal, deps),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Open'", [
            WORK_1,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* offsetOf("wf3b")).toBe(head);
        // Replay converges: exactly one CompleteWork.
        const clean = yield* makeCompletionDeps();
        const result = yield* pollOnce("wf3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(p7Project, p7TestPrincipal, clean),
        });
        expect(result.records).toEqual(["CompleteWork"]);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Completed'", [
            WORK_1,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(1);
        expect(
          yield* countRows(
            "workspaces",
            "workspace_id = ? AND current_work_id IS NULL",
            [p7RootWorkspace],
          ),
        ).toBe(1);
      }),
      makeP9ConsumerApp(),
    );
  });
});
