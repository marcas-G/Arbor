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
import type { Principal } from "../../packages/domain/dist/index.js";
import { preDispatchCheck } from "../../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  TransactionPort,
  VerificationRepository,
} from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";
import {
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "../support/consumer-app-support.js";
import { labeled } from "../support/harness-api.js";
import { EXE_SG_DF1, G_MISSION } from "./support.js";
import {
  countEvents,
  countRows,
  dispatchRound,
  dyingDispatch,
  G_ACC,
  G_ASSIGN_CMD,
  G_ASSIGN_CMD_P,
  G_DEL,
  G_DEP,
  G_WORK,
  G_WORK_P,
  INSERT_EXECUTION_G,
  journalEvent,
  loopStores,
  makeCompletionDeps,
  makeCoordinatorDeps,
  makeVerificationDeps,
  offsetOf,
  preconsume,
  producedPayload,
  REV,
  seedDependencyAndDeliverable,
  settleCompletedG,
  transientOnceGateway,
} from "./support-fg.js";

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("p9-acceptance", () => {
  it("Story G (06 §G) [crash-injected]: P7/P8 workflow interruption replay converges (coordinator, verifier spawn window, consumers A/B) and DF dispatch failure never settles — all via deterministic id idempotency", async () => {
    expect(
      labeled("story-G-workflow-interruption-dispatch", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const seeded = yield* p7SeedWork(G_WORK, G_ASSIGN_CMD);
        expect(seeded.resolution._tag).toBe("Committed");
        const producer = yield* p7SeedWork(G_WORK_P, G_ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE works SET verification_mission = ? WHERE work_id = ?",
          [JSON.stringify(G_MISSION), G_WORK],
        );
        yield* seedDependencyAndDeliverable(G_DEP, G_DEL, G_WORK, G_WORK_P);
        // WF1: coordinator consumption interrupted before the
        // SatisfyDependency commit — redelivery converges.
        const head1 = yield* preconsume("sg1");
        yield* journalEvent(
          "DeliverableProduced",
          producedPayload(G_DEL, G_WORK_P),
        );
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "SatisfyDependency");
        const failure = yield* pollOnce("sg1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps((_base) => interrupted.gateway),
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        expect(
          yield* countRows("commands", "command_id = ?", [
            satisfactionCommandId(G_DEL, G_DEP, REV(0)),
          ]),
        ).toBe(0);
        expect(yield* countEvents("DependencySatisfied")).toBe(0);
        expect(yield* offsetOf("sg1")).toBe(head1);
        const converged = yield* pollOnce("sg1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps(),
          ),
        });
        expect(converged.records).toContain("SatisfyDependency");
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(yield* offsetOf("sg1")).toBe(head1 + 1);
        // WF2: verifier spawn window — the P8 closure holds under
        // injection: replay emits needSpawn with the same caller-
        // preallocated id; AdmitExecution idempotent; no permanent
        // committed-without-Verifier state.
        const head2 = yield* preconsume("sg2");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-0000000000b2",
          workId: G_WORK,
          workRevision: 0,
          claimRef: "claim-sg2",
        });
        const verificationDeps = yield* makeVerificationDeps(gateway);
        const firstSpawn = yield* pollOnce("sg2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            verificationDeps,
          ),
        });
        expect(firstSpawn.records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(G_WORK, 0, "claim-sg2");
        yield* sql.unsafe(
          "UPDATE verifications SET verification_execution_ids = '[]' WHERE verification_id = ?",
          [ids.verificationId],
        );
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(0);
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
          [head2, "sg2"],
        );
        const replaySpawn = yield* pollOnce("sg2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            verificationDeps,
          ),
        });
        expect(replaySpawn.records).toEqual([
          `needSpawn:${ids.verificationId}:${ids.verifierExecutionId}`,
        ]);
        expect(yield* countRows("verifications")).toBe(1);
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
        const spawnDeps = {
          gateway,
          verifications,
          executions,
          tx,
          clock,
          principal: p7TestPrincipal as Principal,
        };
        const spawnArgs = {
          verification: stored.value,
          projectId: p7Project,
          ownerWorkspaceId: p7RootWorkspace,
          verifierExecutionId: ids.verifierExecutionId,
          missionDigest: "story-g",
        };
        const spawned = yield* ensureVerifierSpawned(spawnArgs, spawnDeps);
        expect(spawned._tag).toBe("Spawned");
        expect(spawned._tag === "Spawned" ? spawned.admitted : false).toBe(
          true,
        );
        const spawnedAgain = yield* ensureVerifierSpawned(spawnArgs, spawnDeps);
        expect(spawnedAgain._tag).toBe("Noop");
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
        // Close the WF2 verification so consumer A's next replay (same
        // work revision) is not gated by VerificationAlreadyOpen.
        yield* tx.transact(
          verifications.concludeIfOpen(
            ids.verificationId,
            "Pass",
            "summary:test",
            undefined,
          ),
        );
        // Advance the Work revision: a duplicate claim on revision 0 must not
        // auto-start re-verification after conclusion; revision 1 is a new
        // producer outcome and legitimately drives Consumer A again.
        yield* sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
          G_WORK,
        ]);
        // WF3a: consumer A interrupted before the StartVerification commit
        // for the new revision — replay converges to exactly one more
        // Verification.
        const head3 = yield* preconsume("sg3a");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-0000000000g3",
          workId: G_WORK,
          workRevision: 1,
          claimRef: "claim-sg3",
        });
        const interruptedA = transientOnceGateway(gateway, "StartVerification");
        const failureA = yield* pollOnce("sg3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeVerificationDeps(interruptedA.gateway),
          ),
        }).pipe(Effect.flip);
        expect(failureA._tag).toBe("TransactionOperationalFailure");
        expect(interruptedA.fired()).toBe(true);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countEvents("VerificationStarted")).toBe(1);
        expect(yield* offsetOf("sg3a")).toBe(head3);
        const replayA = yield* pollOnce("sg3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeVerificationDeps(gateway),
          ),
        });
        expect(replayA.records).toEqual(["StartVerification"]);
        expect(yield* countRows("verifications")).toBe(2);
        expect(yield* countEvents("VerificationStarted")).toBe(2);
        expect(yield* offsetOf("sg3a")).toBe(head3 + 1);
        // WF3b: consumer B interrupted before the CompleteWork commit —
        // replay converges to exactly one Completion. The verification
        // opened by WF3a (same work + revision, partial unique index) is
        // the one concluded and accepted.
        const ids3 = verificationSpawnIds(G_WORK, 1, "claim-sg3");
        yield* tx.transact(
          verifications.concludeIfOpen(
            ids3.verificationId,
            "Pass",
            "summary:test",
            undefined,
          ),
        );
        yield* sql.unsafe(
          "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,'t')",
          [G_ACC, p7Project, G_WORK, 1, ids3.verificationId, p7TestActor],
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
          [G_WORK, p7RootWorkspace],
        );
        const head4 = yield* preconsume("sg3b");
        yield* journalEvent("WorkOutcomeAccepted", {
          acceptanceId: G_ACC,
          workId: G_WORK,
          targetWorkRevision: 1,
          verificationId: ids3.verificationId,
          actor: p7TestActor,
        });
        const interruptedB = transientOnceGateway(gateway, "CompleteWork");
        const failureB = yield* pollOnce("sg3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* Effect.gen(function* () {
              const base = yield* makeCompletionDeps();
              return { ...base, gateway: interruptedB.gateway };
            }),
          ),
        }).pipe(Effect.flip);
        expect(failureB._tag).toBe("TransactionOperationalFailure");
        expect(interruptedB.fired()).toBe(true);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Open'", [
            G_WORK,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* offsetOf("sg3b")).toBe(head4);
        const replayB = yield* pollOnce("sg3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCompletionDeps(),
          ),
        });
        expect(replayB.records).toEqual(["CompleteWork"]);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Completed'", [
            G_WORK,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(1);
        // DF1: dispatch port failure never settles; re-dispatch converges.
        yield* INSERT_EXECUTION_G(EXE_SG_DF1);
        const dispatchExit = yield* Effect.exit(
          dispatchRound(EXE_SG_DF1, dyingDispatch()),
        );
        expect(dispatchExit._tag).toBe("Failure");
        expect(
          yield* countRows(
            "executions",
            "execution_id = ? AND settled_at IS NULL",
            [EXE_SG_DF1],
          ),
        ).toBe(1);
        expect(
          yield* countRows("execution_leases", "execution_id = ?", [
            EXE_SG_DF1,
          ]),
        ).toBe(0);
        expect(yield* preDispatchCheck(EXE_SG_DF1 as never)).toBe(true);
        const receipt = yield* settleCompletedG(EXE_SG_DF1);
        expect(
          (receipt as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(
          yield* countRows(
            "executions",
            "execution_id = ? AND settlement_kind = 'Completed'",
            [EXE_SG_DF1],
          ),
        ).toBe(1);
      }),
      makeP9ConsumerApp(),
    );
  });
});
