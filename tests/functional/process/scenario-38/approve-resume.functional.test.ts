import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitP1BeforeExecutableApproval,
  p38AfterEach,
  resolveApproval,
  sandboxPolicyV2DaemonChild,
  startExecutableApproval,
  waitForResumedAction,
} from "./support.js";

afterEach(p38AfterEach);

describe("pending P38 public Executable approval qualification", () => {
  it("approves over the public API and resumes the same Execution/AgentLoopStep", async () => {
    const marker = `P38-APPROVE-${crypto.randomUUID().slice(0, 8)}`;
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
    });
    await commitP1BeforeExecutableApproval(run);
    const approved = await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    expect(approved).toMatchObject({ body: { resolution: "Committed" } });

    const resumed = await waitForResumedAction(run.snapshot, "Consumed");
    expect(resumed.approval?.state).toBe("Consumed");
    expect(resumed.approval).toMatchObject({
      execution_id: run.before.approval?.execution_id,
      logical_step_no: run.before.approval?.logical_step_no,
      repair_attempt: run.before.approval?.repair_attempt,
      action_index: run.before.approval?.action_index,
      logical_action_id: run.before.approval?.logical_action_id,
      tool_invocation_id: run.before.approval?.tool_invocation_id,
    });
    expect(resumed.step?.provider_turn_id).toBe(
      run.before.step?.provider_turn_id,
    );
    expect(resumed.action?.state).toBe("Applied");
    expect(resumed.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      settlement_kind: "Success",
    });
    expect(resumed.effectCount).toBe(1);
  });

  it("survives restart with two daemons and consumes one approval/effect", async () => {
    const marker = `P38-TAKEOVER-${crypto.randomUUID().slice(0, 8)}`;
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
    });
    await commitP1BeforeExecutableApproval(run);
    await run.fixture.crash();
    await run.fixture.restart({ entry: sandboxPolicyV2DaemonChild });
    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    const peer = await run.fixture.startAdditionalDaemon({
      entry: resolve("apps/single-workspace/dist/main.js"),
    });
    try {
      const recovered = await waitForResumedAction(run.snapshot, "Consumed");
      expect(recovered.approval?.state).toBe("Consumed");
      expect(recovered.approval).toMatchObject({
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
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });
});
