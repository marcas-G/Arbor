import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
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
  it("reuses a committed same-Step approval claim after a process crash before effect admission", async () => {
    const marker = `P38-CLAIM-CRASH-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
      firstDaemonEntry: p4FenceChild,
      preserveDirectoryOnStop: true,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolIntentCommit",
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

    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );

    const probe = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolIntentCommit",
        ),
      (event) => event !== undefined,
      60_000,
    );
    if (probe === undefined) {
      throw new Error("P38 claim-commit crash probe was absent");
    }
    expect(probe.executionId).toBe(run.before.approval?.execution_id);
    expect(probe.invocationId).toBe(run.before.approval?.tool_invocation_id);

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
    expect(claimed.action?.state).toBe("Pending");
    expect(claimed.effectCount).toBe(0);
    expect(claimed.matchingInvocationCount).toBe(1);
    expect(claimed.executionApprovalCount).toBe(1);
    expect(claimed.recoveryBinding).toMatchObject({
      recovery_binding_state: "Bound",
      binding_sha256: claimed.recoveryBinding?.recovery_binding_sha256,
    });
    expect(claimed.recoveryBinding?.recovery_binding_sha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(
      JSON.parse(claimed.recoveryBinding?.canonical_binding_json ?? "{}"),
    ).toMatchObject({
      bindingVersion: 1,
      executionId: run.before.approval?.execution_id,
      invocationId: run.before.approval?.tool_invocation_id,
      providerTurnId: run.before.step?.provider_turn_id,
      logicalStepNo: run.before.approval?.logical_step_no,
      repairAttempt: run.before.approval?.repair_attempt,
      logicalActionId: run.before.approval?.logical_action_id,
      actionIndex: run.before.approval?.action_index,
      callRef: run.before.approval?.call_ref,
      approvalId: run.approvalId,
      approvalPreConsumeRevision: run.revision + 1,
      approvalConsumedRevision: run.revision + 2,
      approvalConsumedBy: run.before.approval?.tool_invocation_id,
    });
    expect(claimed.attempt0).toMatchObject({
      attempt_no: 0,
      admission_state: "NotAdmitted",
      admission_source: "P39Claim",
      admission_time_precision: "NotAdmitted",
      binding_sha256: claimed.recoveryBinding?.recovery_binding_sha256,
    });
    expectP38ReceiptProjection(claimed, run);

    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
    });
    try {
      await run.fixture.crash();
      await run.fixture.restart({
        entry: p4FenceChild,
        daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
      });

      const recovered = await waitForResumedAction(run.snapshot, "Consumed");
      expect(recovered.approval).toMatchObject({
        state: "Consumed",
        revision: run.revision + 2,
        consumed_by: run.before.approval?.tool_invocation_id,
      });
      expect(recovered.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        effect_admission_state: "MayHaveStarted",
        settlement_kind: "Success",
      });
      expect(recovered.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(recovered.effectCount).toBe(1);
      expect(recovered.matchingInvocationCount).toBe(1);
      expect(recovered.executionApprovalCount).toBe(1);
      expect(recovered.recoveryBinding).toEqual(claimed.recoveryBinding);
      expect(recovered.attempt0).toMatchObject({
        attempt_no: 0,
        admission_state: "MayHaveStarted",
        admission_source: "P39Admission",
        admission_time_precision: "TransactionTimestamp",
        binding_sha256: recovered.recoveryBinding?.recovery_binding_sha256,
      });
      expectP38ReceiptProjection(recovered, run, {
        admissionState: "MayHaveStarted",
        admissionSource: "P39Admission",
      });
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });

  it("keeps the consumed approval bound after a crash following a non-idempotent effect", async () => {
    const marker = `P38-EFFECT-CRASH-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
      firstDaemonEntry: p4FenceChild,
      preserveDirectoryOnStop: true,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolEffectBeforeSettlement",
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

    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    const probe = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolEffectBeforeSettlement",
        ),
      (event) => event !== undefined,
      60_000,
    );
    if (probe === undefined) {
      throw new Error("P38 post-effect crash probe was absent");
    }
    expect(probe.executionId).toBe(run.before.approval?.execution_id);
    expect(probe.invocationId).toBe(run.before.approval?.tool_invocation_id);

    const afterEffect = run.snapshot();
    expect(afterEffect.approval).toMatchObject({
      state: "Consumed",
      side_effect_semantics: "NonIdempotent",
      revision: run.revision + 2,
      consumed_by: run.before.approval?.tool_invocation_id,
    });
    expect(afterEffect.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      effect_admission_state: "MayHaveStarted",
      settlement_kind: null,
    });
    expect(afterEffect.effectCount).toBe(1);
    expect(afterEffect.matchingInvocationCount).toBe(1);
    expect(afterEffect.executionApprovalCount).toBe(1);
    const providerCallCountAfterEffect = run.fixture.providerCalls.length;

    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "new",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
      },
    });
    try {
      await run.fixture.crash();
      await run.fixture.restart({
        entry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        },
      });
      const recovered = await waitForPublic(
        async () => run.snapshot(),
        (snapshot) =>
          snapshot.approval?.state === "Consumed" &&
          snapshot.execution?.settlement_kind === "OutcomeUnknown" &&
          snapshot.step?.state === "SettlementProposed" &&
          snapshot.action?.state === "ReconciliationPending" &&
          snapshot.invocation?.effect_admission_state === "MayHaveStarted" &&
          snapshot.invocation.settlement_kind === "OutcomeUnknown" &&
          snapshot.effectCount === 1 &&
          snapshot.matchingInvocationCount === 1 &&
          snapshot.executionApprovalCount === 1,
        60_000,
      );
      expect(recovered.approval).toMatchObject({
        state: "Consumed",
        revision: run.revision + 2,
        consumed_by: run.before.approval?.tool_invocation_id,
      });
      expect(recovered.execution).toMatchObject({
        stop_requested_at: null,
        settlement_kind: "OutcomeUnknown",
      });
      expect(
        JSON.parse(recovered.execution?.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: [run.before.approval?.tool_invocation_id],
        },
      });
      expect(recovered.step?.state).toBe("SettlementProposed");
      expect(recovered.action?.state).toBe("ReconciliationPending");
      expect(recovered.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        effect_admission_state: "MayHaveStarted",
        settlement_kind: "OutcomeUnknown",
      });
      expect(recovered.recoveryBinding).toEqual(afterEffect.recoveryBinding);
      expect(recovered.attempt0).toEqual(afterEffect.attempt0);
      expect(run.fixture.providerCalls).toHaveLength(
        providerCallCountAfterEffect,
      );
      expect(
        probes.filter(
          (event) => event.boundary === "AH7AfterToolEffectBeforeSettlement",
        ),
      ).toHaveLength(1);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });
});
