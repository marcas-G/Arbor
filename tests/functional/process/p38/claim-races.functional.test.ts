import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../support/lease-qualification.js";
import type { ProductionFixture } from "../../support/production-fixture.js";
import { functionalId, waitForPublic } from "../../support/public-client.js";
import {
  commitP1BeforeExecutableApproval,
  expectP38ReceiptProjection,
  p4FenceChild,
  p38AfterEach,
  resolveApproval,
  startExecutableApproval,
  waitForResumedAction,
} from "./support.js";

afterEach(p38AfterEach);

describe("pending P38 public Executable approval qualification", () => {
  it("rolls back a same-Step P38/P4/P39 claim killed inside its transaction", async () => {
    const marker = `P38-P39-CLAIM-PRECOMMIT-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly branch?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
      readonly approvalId?: string | null;
    }> = [];
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
      firstDaemonEntry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_P39_BEGIN_GATE: "1",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "P4_FENCE_PROBE") probes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });
    await commitP1BeforeExecutableApproval(run);
    const gateDirectory = join(
      dirname(run.fixture.databaseFile),
      "p4-fence-gates",
    );
    mkdirSync(gateDirectory, { recursive: true });
    writeFileSync(
      join(gateDirectory, "p4-p39-target.json"),
      JSON.stringify({
        executionId: run.before.approval?.execution_id,
        invocationId: run.before.approval?.tool_invocation_id,
        approvalId: run.approvalId,
      }),
    );
    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
    });
    try {
      await resolveApproval(
        run.client,
        run.project.projectId,
        run.approvalId,
        run.revision,
        "Approve",
      );
      const claimAttempt = await waitForPublic(
        async () =>
          probes.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "P38P39ClaimBeforeTransaction",
          ),
        (event) => event !== undefined,
        60_000,
      );
      if (claimAttempt === undefined) {
        throw new Error("P38/P39 claim attempt probe was absent");
      }
      expect(claimAttempt.executionId).toBe(run.before.approval?.execution_id);
      expect(claimAttempt.invocationId).toBe(
        run.before.approval?.tool_invocation_id,
      );
      await waitForPublic(
        async () =>
          probes.find(
            (event) =>
              event.role === "old" && event.boundary === "P38P39BeforeBegin",
          ),
        (event) => event !== undefined,
        60_000,
      );

      const owner = run.fixture.daemonProcessSnapshot();
      const targetExecutionId = run.before.approval?.execution_id;
      if (
        owner === null ||
        owner.pid === undefined ||
        targetExecutionId === undefined
      ) {
        throw new Error("old P38 claim owner PID was absent");
      }
      const leaseDb = new DatabaseSync(run.fixture.databaseFile, {
        readOnly: true,
      });
      let lease:
        | {
            readonly worker_id: string;
            readonly worker_incarnation_id: string;
            readonly generation: number;
            readonly expires_at: string;
          }
        | undefined;
      try {
        lease = leaseDb
          .prepare(
            `SELECT worker_id, worker_incarnation_id, generation, expires_at
               FROM execution_leases WHERE execution_id = ?`,
          )
          .get(targetExecutionId) as typeof lease;
      } finally {
        leaseDb.close();
      }
      if (lease === undefined) {
        throw new Error("same-Step old owner lease was absent before kill");
      }

      await run.fixture.crash();
      expect(run.fixture.daemonProcessSnapshot()?.alive).toBe(false);
      await peer.crash();
      const rolledBack = run.snapshot();
      expect(rolledBack.approval).toMatchObject({
        state: "Approved",
        consumed_by: null,
      });
      expect(rolledBack.action?.state).toBe("Pending");
      expect(rolledBack.invocation).toBeUndefined();
      expect(rolledBack.recoveryBinding).toBeUndefined();
      expect(rolledBack.attempt0).toBeUndefined();
      expect(rolledBack.effectCount).toBe(0);

      const expired = await expireExecutionLeaseAfterOwnerExitForQualification({
        databaseFile: run.fixture.databaseFile,
        executionId: targetExecutionId,
        expected: {
          generation: lease.generation,
          expiresAt: lease.expires_at,
          workerId: lease.worker_id,
          workerIncarnationId: lease.worker_incarnation_id,
        },
        daemon: {
          crash: run.fixture.crash,
          snapshot: run.fixture.daemonProcessSnapshot,
        },
        ownerEvidence: {
          executionId: targetExecutionId,
          processId: owner.pid,
          workerId: lease.worker_id,
          workerIncarnationId: lease.worker_incarnation_id,
          generation: lease.generation,
          provenance: "DurableGenerationWithStableIncarnation",
        },
      });
      expect(expired.before.generation).toBe(lease.generation);
      expect(expired.after.generation).toBe(lease.generation);
      expect(Date.parse(expired.after.expires_at)).toBeLessThan(Date.now());

      const recoveryPeer = await run.fixture.startAdditionalDaemon({
        entry: p4FenceChild,
        daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
      });
      writeFileSync(join(gateDirectory, "new-p39-begin.release"), "release");
      try {
        const recovered = await waitForResumedAction(run.snapshot, "Consumed");
        expect(recovered.approval).toMatchObject({
          state: "Consumed",
          revision: run.revision + 2,
          consumed_by: run.before.approval?.tool_invocation_id,
          execution_id: run.before.approval?.execution_id,
          logical_step_no: run.before.approval?.logical_step_no,
          logical_action_id: run.before.approval?.logical_action_id,
          tool_invocation_id: run.before.approval?.tool_invocation_id,
        });
        expect(recovered.step?.provider_turn_id).toBe(
          run.before.step?.provider_turn_id,
        );
        expect(recovered.action?.state).toBe("Applied");
        expect(recovered.invocation).toMatchObject({
          invocation_id: run.before.approval?.tool_invocation_id,
          approval_id: run.approvalId,
          settlement_kind: "Success",
        });
        expect(recovered.effectCount).toBe(1);
        expect(recovered.matchingInvocationCount).toBe(1);
        expect(recovered.executionApprovalCount).toBe(1);
        expect(recovered.recoveryBinding?.recovery_binding_state).toBe("Bound");
        expectP38ReceiptProjection(recovered, run, {
          admissionState: "MayHaveStarted",
          admissionSource: "P39Admission",
        });
        expect(recovered.attempt0).toMatchObject({
          attempt_no: 0,
          admission_state: "MayHaveStarted",
          admission_source: "P39Admission",
          admission_time_precision: "TransactionTimestamp",
          binding_sha256: recovered.recoveryBinding?.recovery_binding_sha256,
        });
        expect(run.fixture.daemonErrors).toEqual([]);
        expect(peer.daemonErrors).toEqual([]);
        expect(recoveryPeer.daemonErrors).toEqual([]);
      } finally {
        await recoveryPeer.crash();
      }
    } finally {
      await peer.crash();
    }
  });

  it("overlaps same-Step P38/P4/P39 claim attempts from two daemons without duplicate claim facts", async () => {
    const marker = `P38-CLAIM-OVERLAP-${crypto.randomUUID().slice(0, 8)}`;
    const ownerProbes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
      readonly approvalId?: string | null;
    }> = [];
    const contenderProbes: Array<Record<string, unknown>> = [];
    const summarizeStages = (probes: ReadonlyArray<Record<string, unknown>>) =>
      probes
        .filter(
          (event) =>
            String(event.boundary).startsWith("P38P39") ||
            event.boundary === "P4P39ClaimBeforeCommit" ||
            event.boundary === "AH7AfterToolIntentCommit" ||
            event.boundary === "AH10LeaseAcquisitionRejected" ||
            event.boundary === "AH10PreDispatchSkippedLiveLease",
        )
        .map((event) => ({
          role: event.role,
          boundary: event.boundary,
          executionId: event.executionId,
          invocationId: event.invocationId,
          approvalId: event.approvalId,
          source: event.source,
        }));
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
      firstDaemonEntry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolIntentCommit",
        ARBOR_P4_P39_BEGIN_GATE: "1",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof ownerProbes)[number];
          if (event.tag === "P4_FENCE_PROBE") ownerProbes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });
    await commitP1BeforeExecutableApproval(run);
    const targetExecutionId = run.before.approval?.execution_id;
    if (targetExecutionId === undefined) {
      throw new Error("P38 overlap execution id was absent");
    }
    const gateDirectory = join(
      dirname(run.fixture.databaseFile),
      "p4-fence-gates",
    );
    mkdirSync(gateDirectory, { recursive: true });
    writeFileSync(
      join(gateDirectory, "p4-p39-target.json"),
      JSON.stringify({
        executionId: targetExecutionId,
        invocationId: run.before.approval?.tool_invocation_id,
        approvalId: run.approvalId,
      }),
    );

    // Let the existing owner claim the P1-prepared approval and pause before
    // BEGIN. The explicit contender below challenges that same live lease
    // while no SQLite write lock is held.
    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );

    let contender:
      | Awaited<ReturnType<ProductionFixture["startAdditionalDaemon"]>>
      | undefined;
    try {
      const ownerClaim = await waitForPublic(
        async () =>
          ownerProbes.find(
            (event) =>
              event.boundary === "P38P39ClaimBeforeTransaction" &&
              event.executionId === targetExecutionId &&
              event.invocationId === run.before.approval?.tool_invocation_id &&
              event.approvalId === run.approvalId,
          ),
        (event) => event !== undefined,
        25_000,
      ).catch((error: unknown) => {
        throw new Error(
          `${String(error)}; ownerStages=${JSON.stringify(summarizeStages(ownerProbes))}; contenderStages=${JSON.stringify(summarizeStages(contenderProbes))}; ownerErrors=${JSON.stringify(run.fixture.daemonErrors)}; contenderErrors=${JSON.stringify(contender?.daemonErrors ?? [])}; snapshot=${JSON.stringify(run.snapshot())}`,
          { cause: error },
        );
      });
      expect(ownerClaim).toBeTruthy();
      const ownerBeforeBegin = await waitForPublic(
        async () =>
          ownerProbes.find(
            (event) =>
              event.boundary === "P38P39BeforeBegin" && event.role === "old",
          ),
        (event) => event !== undefined,
        25_000,
      );
      expect(ownerBeforeBegin).toBeTruthy();

      // The first daemon now owns the live Execution lease and is held at the
      // exact P39 claim boundary. Start the contender only after that point,
      // then challenge the same Execution with a separate runExecution call.
      contender = await run.fixture.startAdditionalDaemon({
        entry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_FENCE_EXPLICIT_EXECUTION_ID: targetExecutionId,
          ARBOR_P4_P39_BEGIN_GATE: "1",
          ARBOR_WORKSPACE_ID: functionalId("ws"),
        },
        onStdout: (line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.tag === "P4_FENCE_PROBE") contenderProbes.push(event);
          } catch {
            // Ordinary daemon output is diagnostic data, not a probe.
          }
        },
      });

      writeFileSync(
        join(gateDirectory, "new-explicit-runExecution.release"),
        "release",
      );
      let contenderLeaseLoss: Record<string, unknown> | undefined;
      try {
        contenderLeaseLoss = await waitForPublic(
          async () =>
            contenderProbes.find(
              (event) =>
                event.boundary === "AH10LeaseAcquisitionRejected" &&
                event.executionId === targetExecutionId &&
                event.source === "test-runExecution",
            ),
          (event) => event !== undefined,
          25_000,
        );
      } catch (error) {
        throw new Error(
          `${String(error)}; ownerStages=${JSON.stringify(summarizeStages(ownerProbes))}; contenderStages=${JSON.stringify(summarizeStages(contenderProbes))}; ownerErrors=${JSON.stringify(run.fixture.daemonErrors)}; contenderErrors=${JSON.stringify(contender?.daemonErrors ?? [])}`,
        );
      }
      expect(contenderLeaseLoss).toMatchObject({
        executionId: targetExecutionId,
        source: "test-runExecution",
      });
      expect(
        contenderProbes.some(
          (event) =>
            event.boundary === "P38P39ClaimBeforeTransaction" &&
            event.executionId === targetExecutionId,
        ),
      ).toBe(false);
      expect(
        contenderProbes.some(
          (event) =>
            event.boundary === "P38P39BeforeBegin" &&
            event.executionId === targetExecutionId,
        ),
      ).toBe(false);

      writeFileSync(join(gateDirectory, "old-p39-begin.release"), "release");
      const ownerClaimCommitted = await waitForPublic(
        async () =>
          ownerProbes.find(
            (event) =>
              event.boundary === "P4P39ClaimBeforeCommit" &&
              event.executionId === targetExecutionId &&
              event.invocationId === run.before.approval?.tool_invocation_id,
          ),
        (event) => event !== undefined,
        25_000,
      );
      expect(ownerClaimCommitted).toBeTruthy();

      let ownerAfterCommit: (typeof ownerProbes)[number] | undefined;
      try {
        ownerAfterCommit = await waitForPublic(
          async () =>
            ownerProbes.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH7AfterToolIntentCommit" &&
                event.executionId === targetExecutionId,
            ),
          (event) => event !== undefined,
          60_000,
        );
      } catch (error) {
        throw new Error(
          `${String(error)}; ownerProbes=${JSON.stringify(ownerProbes)}; contenderProbes=${JSON.stringify(contenderProbes)}; ownerErrors=${JSON.stringify(run.fixture.daemonErrors)}; contenderErrors=${JSON.stringify(contender.daemonErrors)}; snapshot=${JSON.stringify(run.snapshot())}`,
        );
      }
      if (ownerAfterCommit === undefined) {
        throw new Error("old owner did not pause after claim commit");
      }

      const claimed = run.snapshot();
      expect(claimed.approval).toMatchObject({
        state: "Consumed",
        revision: run.revision + 2,
        consumed_by: run.before.approval?.tool_invocation_id,
      });
      expect(claimed.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        effect_admission_state: "NotAdmitted",
        settlement_kind: null,
      });
      expect(claimed.matchingInvocationCount).toBe(1);
      expect(claimed.executionApprovalCount).toBe(1);
      expect(claimed.effectCount).toBe(0);
      expectP38ReceiptProjection(claimed, run);
      expect(claimed.attempt0).toMatchObject({
        attempt_no: 0,
        admission_state: "NotAdmitted",
        admission_source: "P39Claim",
        binding_sha256: claimed.recoveryBinding?.recovery_binding_sha256,
      });
      expect(
        contenderProbes.some(
          (event) =>
            event.boundary === "P4P39ClaimBeforeCommit" &&
            event.executionId === targetExecutionId,
        ),
      ).toBe(false);

      writeFileSync(
        join(gateDirectory, "old-tool-admission.release"),
        "release",
      );
      const ownerAfterEffect = await waitForPublic(
        async () =>
          ownerProbes.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH7AfterToolEffectBeforeSettlement" &&
              event.executionId === targetExecutionId,
          ),
        (event) => event !== undefined,
        60_000,
      );
      expect(ownerAfterEffect?.invocationId).toBe(
        run.before.approval?.tool_invocation_id,
      );
      writeFileSync(
        join(gateDirectory, "old-tool-effect.release"),
        "release effect settlement",
      );
      const completed = await waitForResumedAction(run.snapshot, "Consumed");
      expect(completed.approval).toEqual(claimed.approval);
      expect(completed.recoveryBinding).toEqual(claimed.recoveryBinding);
      expect(completed.attempt0).toMatchObject({
        attempt_no: 0,
        admission_state: "MayHaveStarted",
        admission_source: "P39Admission",
        admission_time_precision: "TransactionTimestamp",
        binding_sha256: completed.recoveryBinding?.recovery_binding_sha256,
      });
      expect(completed.action?.state).toBe("Applied");
      expect(completed.effectCount).toBe(1);
      expect(completed.matchingInvocationCount).toBe(1);
      expect(completed.executionApprovalCount).toBe(1);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(contender?.daemonErrors).toEqual([]);
    } finally {
      if (contender !== undefined) await contender.crash();
    }
  });
});
