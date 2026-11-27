import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  p38AfterEach,
  resolveApproval,
  startExecutableApproval,
  waitForResumedAction,
} from "./support.js";

afterEach(p38AfterEach);

describe("pending P38 public Executable approval qualification", () => {
  it.each(["Reject", "Expire"] as const)(
    "%s is terminal, resumes the original action without admitting the shell effect",
    async (resolution) => {
      const marker = `P38-${resolution.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const run = await startExecutableApproval(marker);
      if (resolution === "Reject") {
        const rejected = await resolveApproval(
          run.client,
          run.project.projectId,
          run.approvalId,
          run.revision,
          "Reject",
        );
        expect(rejected).toMatchObject({ body: { resolution: "Committed" } });
      } else {
        const db = new DatabaseSync(run.fixture.databaseFile);
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          db.prepare(
            "UPDATE action_approvals SET expires_at = ? WHERE approval_id = ? AND route_kind = 'Executable' AND state = 'Pending' AND revision = ?",
          ).run("2000-01-01T00:00:00.000Z", run.approvalId, run.revision);
        } finally {
          db.close();
        }
      }

      const resumed = await waitForResumedAction(
        run.snapshot,
        resolution === "Reject" ? "Rejected" : "Expired",
      );
      expect(resumed.approval?.state).toBe(
        resolution === "Reject" ? "Rejected" : "Expired",
      );
      expect(resumed.approval?.execution_id).toBe(
        run.before.approval?.execution_id,
      );
      expect(resumed.approval?.logical_step_no).toBe(
        run.before.approval?.logical_step_no,
      );
      expect(resumed.approval?.logical_action_id).toBe(
        run.before.approval?.logical_action_id,
      );
      expect(resumed.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(resumed.action?.state).toBe("TerminalRejected");
      expect(resumed.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        settlement_kind: "Denied",
      });
      expect(
        JSON.parse(resumed.invocation?.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "Denied",
        reasonCode:
          resolution === "Reject" ? "ApprovalRejected" : "ApprovalExpired",
      });
      expect(resumed.effectCount).toBe(0);
    },
  );
});
