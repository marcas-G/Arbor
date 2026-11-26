import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  commitP1BeforeExecutableApproval,
  expireStoppedInitialOwner,
  p4FenceChild,
  p38AfterEach,
  resolveApproval,
  startExecutableApproval,
} from "./support.js";

afterEach(p38AfterEach);

describe("pending P38 public Executable approval qualification", () => {
  it.each(["before-resolution", "after-resolution"] as const)(
    "Stop %s interrupts the same public approval action after owner-exit recovery",
    async (ordering) => {
      const marker = `P38-STOP-${ordering.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const probes: Array<{
        readonly tag?: string;
        readonly role?: string;
        readonly boundary?: string;
        readonly executionId?: string;
        readonly invocationId?: string;
      }> = [];
      const run = await startExecutableApproval(marker, {
        ...(ordering === "after-resolution"
          ? { trustedLocalSandboxPolicy: true }
          : {}),
        firstDaemonEntry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "old",
          ...(ordering === "after-resolution"
            ? {
                ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolIntentCommit",
              }
            : {}),
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
      if (ordering === "after-resolution") {
        await commitP1BeforeExecutableApproval(run);
      }
      const gateDirectory = join(
        dirname(run.fixture.databaseFile),
        "p4-fence-gates",
      );
      mkdirSync(gateDirectory, { recursive: true });
      if (ordering === "before-resolution") {
        writeFileSync(join(gateDirectory, "old-driver.request"), "pause");
      }

      let oldOwnerPause: (typeof probes)[number] | undefined;
      if (ordering === "after-resolution") {
        const firstNewProbe = probes.length;
        await resolveApproval(
          run.client,
          run.project.projectId,
          run.approvalId,
          run.revision,
          "Approve",
        );
        oldOwnerPause = await waitForPublic(
          async () =>
            probes
              .slice(firstNewProbe)
              .find(
                (event) =>
                  event.role === "old" &&
                  event.boundary === "AH7AfterToolIntentCommit",
              ),
          (event) => event !== undefined,
          60_000,
        );
        if (oldOwnerPause === undefined) {
          throw new Error("P38 post-resolution pre-effect pause was absent");
        }
        expect(oldOwnerPause.executionId).toBe(
          run.before.approval?.execution_id,
        );
        expect(oldOwnerPause.invocationId).toBe(
          run.before.approval?.tool_invocation_id,
        );
      }

      const firstNewProbe = probes.length;
      const stopResponse = await run.client.command(
        run.project.projectId,
        "StopExecution",
        { executionId: run.before.approval?.execution_id },
      );
      expect(stopResponse).toMatchObject({ body: { resolution: "Committed" } });

      if (ordering === "before-resolution") {
        oldOwnerPause = await waitForPublic(
          async () =>
            probes
              .slice(firstNewProbe)
              .find(
                (event) =>
                  event.role === "old" &&
                  event.boundary === "AH10AfterLeaseAcquired",
              ),
          (event) => event !== undefined,
          60_000,
        );
        if (oldOwnerPause === undefined) {
          throw new Error("P38 pre-resolution stopped-owner pause was absent");
        }
        expect(oldOwnerPause.executionId).toBe(
          run.before.approval?.execution_id,
        );
      }

      const beforeOwnerExit = run.snapshot();
      expect(beforeOwnerExit.execution?.stop_requested_at).not.toBeNull();
      expect(beforeOwnerExit.execution?.settlement_kind).toBeNull();
      expect(beforeOwnerExit.approval).toMatchObject(
        ordering === "before-resolution"
          ? {
              state: "Cancelled",
              revision: run.revision + 1,
              cancellation_reason: "StopRequested",
            }
          : {
              state: "Consumed",
              revision: run.revision + 2,
              consumed_by: run.before.approval?.tool_invocation_id,
            },
      );
      expect(beforeOwnerExit.inboxConsumedAt).not.toBeNull();
      expect(beforeOwnerExit.executionStopEventCount).toBe(1);
      const resolutionEvents = beforeOwnerExit.approvalEvents
        .filter((event) => event.event_type === "ExecutableApprovalResolved")
        .map(
          (event) =>
            JSON.parse(event.payload_json) as {
              readonly resolution?: string;
              readonly reasonCode?: string;
              readonly toolInvocationId?: string;
            },
        );
      expect(resolutionEvents).toHaveLength(1);
      expect(resolutionEvents[0]).toMatchObject(
        ordering === "before-resolution"
          ? { resolution: "Cancelled", reasonCode: "StopRequested" }
          : {
              resolution: "Approved",
              toolInvocationId: run.before.approval?.tool_invocation_id,
            },
      );
      expect(beforeOwnerExit.effectCount).toBe(0);
      if (ordering === "before-resolution") {
        expect(beforeOwnerExit.invocation).toBeUndefined();
      } else {
        expect(beforeOwnerExit.invocation).toMatchObject({
          invocation_id: run.before.approval?.tool_invocation_id,
          effect_admission_state: "NotAdmitted",
          settlement_kind: null,
        });
      }

      const expired = await expireStoppedInitialOwner(run);
      expect(expired.before.generation).toBe(expired.after.generation);
      expect(Date.parse(expired.after.expires_at)).toBeLessThan(Date.now());
      const peerEvents: Array<Record<string, unknown>> = [];
      const peer = await run.fixture.startAdditionalDaemon({
        entry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_FENCE_TRACE_NEW: "1",
        },
        onStdout: (line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.tag === "P4_FENCE_PROBE") peerEvents.push(event);
          } catch {
            // Ordinary daemon output is diagnostic data, not a probe.
          }
        },
      });
      try {
        const recovered = await waitForPublic(
          async () => run.snapshot(),
          (snapshot) =>
            snapshot.execution?.settlement_kind === "Interrupted" &&
            (ordering === "before-resolution"
              ? snapshot.invocation === undefined
              : snapshot.invocation?.settlement_kind === "Interrupted") &&
            snapshot.effectCount === 0,
          60_000,
        ).catch((error: unknown) => {
          throw new Error(
            `${String(error)}; peerEvents=${JSON.stringify(peerEvents)}; peerErrors=${JSON.stringify(peer.daemonErrors)}`,
          );
        });
        expect(
          JSON.parse(recovered.execution?.settlement_json ?? "{}"),
        ).toMatchObject({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
        expect(recovered.approval?.logical_action_id).toBe(
          run.before.approval?.logical_action_id,
        );
        expect(recovered.step?.provider_turn_id).toBe(
          run.before.step?.provider_turn_id,
        );
        expect(recovered.action?.state).not.toBe("Applied");
        expect(recovered.executionStopEventCount).toBe(1);
        expect(recovered.inboxConsumedAt).not.toBeNull();
        expect(
          recovered.approvalEvents.filter(
            (event) => event.event_type === "ExecutableApprovalResolved",
          ),
        ).toHaveLength(1);
        expect(recovered.effectCount).toBe(0);
        if (ordering === "after-resolution") {
          expect(recovered.invocation).toMatchObject({
            invocation_id: run.before.approval?.tool_invocation_id,
            approval_id: run.approvalId,
            effect_admission_state: "NotAdmitted",
            settlement_kind: "Interrupted",
          });
          expect(recovered.recoveryBinding).toMatchObject({
            recovery_binding_state: "Bound",
          });
          expect(recovered.attempt0).toMatchObject({
            attempt_no: 0,
            admission_state: "NotAdmitted",
            admission_source: "Claim",
          });
        }
        expect(run.fixture.daemonErrors).toEqual([]);
        expect(peer.daemonErrors).toEqual([]);
      } finally {
        await peer.crash();
      }
    },
  );

  it.each([0, 1])(
    "public Stop and TTL expiry race on exact approval revision in iteration %i",
    async (iteration) => {
      const marker = `P38-STOP-TTL-${iteration}-${crypto.randomUUID().slice(0, 8)}`;
      const probes: Array<{
        readonly tag?: string;
        readonly role?: string;
        readonly boundary?: string;
        readonly executionId?: string;
        readonly commandId?: string;
        readonly outcomeTag?: string;
        readonly approvalIds?: ReadonlyArray<string>;
      }> = [];
      const run = await startExecutableApproval(marker, {
        firstDaemonEntry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "old",
          ARBOR_P4_STOP_TTL_RACE: "ttl-main-blocked",
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
      const gateDirectory = join(
        dirname(run.fixture.databaseFile),
        "p4-fence-gates",
      );
      mkdirSync(gateDirectory, { recursive: true });
      const ttlPeerEvents: Array<(typeof probes)[number]> = [];
      const ttlPeer = await run.fixture.startAdditionalDaemon({
        entry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_STOP_TTL_RACE: "ttl-worker",
        },
        onStdout: (line) => {
          try {
            const event = JSON.parse(line) as (typeof probes)[number];
            if (event.tag === "P4_FENCE_PROBE") ttlPeerEvents.push(event);
          } catch {
            // Ordinary daemon output is diagnostic data, not a probe.
          }
        },
      });
      writeFileSync(join(gateDirectory, "ttl-before.request"), "pause");
      const db = new DatabaseSync(run.fixture.databaseFile);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.prepare(
          `UPDATE action_approvals SET expires_at = ?
            WHERE approval_id = ? AND route_kind = 'Executable'
              AND state = 'Pending' AND revision = ?`,
        ).run("2000-01-01T00:00:00.000Z", run.approvalId, run.revision);
      } finally {
        db.close();
      }
      const mainTtlReady = waitForPublic(
        async () =>
          probes.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "P38TTLBeforeExpiryTransaction",
          ),
        (event) => event !== undefined,
        60_000,
      );
      const peerTtlReady = waitForPublic(
        async () =>
          ttlPeerEvents.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "P38TTLBeforeExpiryTransaction",
          ),
        (event) => event !== undefined,
        60_000,
      );
      await Promise.all([mainTtlReady, peerTtlReady]).catch(
        (error: unknown) => {
          const diagnosticDb = new DatabaseSync(run.fixture.databaseFile, {
            readOnly: true,
          });
          let approvalRow: unknown;
          let userVersion: unknown;
          try {
            approvalRow = diagnosticDb
              .prepare(
                "SELECT state, revision, expires_at FROM action_approvals WHERE approval_id = ?",
              )
              .get(run.approvalId);
            userVersion = diagnosticDb.prepare("PRAGMA user_version").get();
          } finally {
            diagnosticDb.close();
          }
          throw new Error(
            `${String(error)}; mainProbes=${JSON.stringify(probes)}; peerProbes=${JSON.stringify(ttlPeerEvents)}; mainProcess=${JSON.stringify(run.fixture.daemonProcessSnapshot())}; mainErrors=${JSON.stringify(run.fixture.daemonErrors)}; peerProcess=${JSON.stringify(ttlPeer?.daemonProcessSnapshot())}; peerErrors=${JSON.stringify(ttlPeer?.daemonErrors)}; approval=${JSON.stringify(approvalRow)}; userVersion=${JSON.stringify(userVersion)}`,
          );
        },
      );

      const stopPromise = run.client
        .command(run.project.projectId, "StopExecution", {
          executionId: run.before.approval?.execution_id,
        })
        .then(
          (payload) => ({ ok: true as const, payload }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      await waitForPublic(
        async () =>
          probes.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "P38StopExecutionBeforeTransaction",
          ),
        (event) => event !== undefined,
        60_000,
      );
      await Promise.all([
        writeFile(join(gateDirectory, "old-ttl-before.release"), "release"),
        writeFile(join(gateDirectory, "new-ttl-before.release"), "release"),
      ]);
      const stopOutcome = await stopPromise;
      if (!stopOutcome.ok) {
        throw new Error(
          `public Stop failed: ${stopOutcome.error}; probes=${JSON.stringify(probes)}; daemonErrors=${JSON.stringify(run.fixture.daemonErrors)}`,
        );
      }
      expect(stopOutcome.payload).toMatchObject({
        body: { resolution: "Committed" },
      });
      const recovered = await waitForPublic(
        async () => run.snapshot(),
        (snapshot) =>
          snapshot.execution?.settlement_kind === "Interrupted" &&
          snapshot.effectCount === 0 &&
          (snapshot.approval?.state === "Cancelled" ||
            snapshot.approval?.state === "Expired"),
        60_000,
      );
      expect(recovered.execution?.stop_requested_at).not.toBeNull();
      expect(
        JSON.parse(recovered.execution?.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      });
      expect(["Cancelled", "Expired"]).toContain(recovered.approval?.state);
      expect(recovered.approval).toMatchObject({
        state: recovered.approval?.state,
        revision: run.revision + 1,
      });
      expect(recovered.executionStopEventCount).toBe(1);
      expect(
        recovered.approvalEvents.filter(
          (event) => event.event_type === "ExecutableApprovalResolved",
        ),
      ).toHaveLength(1);
      expect(recovered.inboxConsumedAt).not.toBeNull();
      if (recovered.invocation !== undefined) {
        expect(recovered.invocation.effect_admission_state).toBe("NotAdmitted");
        expect(recovered.invocation.settlement_kind).toBe("Denied");
        expect(
          JSON.parse(recovered.invocation.settlement_json ?? "{}"),
        ).toMatchObject({
          _tag: "Denied",
        });
      }
      expect(recovered.effectCount).toBe(0);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(ttlPeer.daemonErrors).toEqual([]);
      await ttlPeer.crash();
    },
  );

  it("keeps StopRequested as the Execution cause when a P4 Denied winner committed first", async () => {
    const marker = `P38-STOP-DENIED-WINNER-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
      readonly outcomeTag?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
      firstDaemonEntry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY:
          "P4ExecutableToolRuntimeOutcomeDenied",
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
    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Reject",
    );
    const deniedPause = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "P4ExecutableToolRuntimeOutcome" &&
            event.outcomeTag === "Denied",
        ),
      (event) => event !== undefined,
      60_000,
    );
    if (deniedPause === undefined) {
      throw new Error("P38 committed-Denied pre-AgentLoop pause was absent");
    }
    expect(deniedPause.executionId).toBe(run.before.approval?.execution_id);
    expect(deniedPause.invocationId).toBe(
      run.before.approval?.tool_invocation_id,
    );
    const deniedBeforeStop = run.snapshot();
    expect(deniedBeforeStop.execution?.settlement_kind).toBeNull();
    expect(deniedBeforeStop.approval).toMatchObject({
      state: "Rejected",
      revision: run.revision + 1,
    });
    expect(deniedBeforeStop.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
    });
    expect(deniedBeforeStop.effectCount).toBe(0);

    const stopResponse = await run.client.command(
      run.project.projectId,
      "StopExecution",
      { executionId: run.before.approval?.execution_id },
    );
    expect(stopResponse).toMatchObject({ body: { resolution: "Committed" } });
    const beforeOwnerExit = run.snapshot();
    expect(beforeOwnerExit.execution?.stop_requested_at).not.toBeNull();
    expect(beforeOwnerExit.execution?.settlement_kind).toBeNull();
    expect(beforeOwnerExit.invocation).toEqual(deniedBeforeStop.invocation);
    expect(beforeOwnerExit.executionStopEventCount).toBe(1);
    expect(
      beforeOwnerExit.approvalEvents.filter(
        (event) => event.event_type === "ExecutableApprovalResolved",
      ),
    ).toHaveLength(1);

    const expired = await expireStoppedInitialOwner(run);
    expect(expired.before.generation).toBe(expired.after.generation);
    expect(Date.parse(expired.after.expires_at)).toBeLessThan(Date.now());
    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
    });
    try {
      const recovered = await waitForPublic(
        async () => run.snapshot(),
        (snapshot) =>
          snapshot.execution?.settlement_kind === "Interrupted" &&
          snapshot.action !== undefined &&
          snapshot.action.state !== "Applied" &&
          snapshot.effectCount === 0,
        60_000,
      );
      expect(
        JSON.parse(recovered.execution?.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      });
      expect(recovered.approval).toEqual(deniedBeforeStop.approval);
      expect(recovered.invocation).toEqual(deniedBeforeStop.invocation);
      expect(recovered.action?.state).toMatch(/^(Pending|TerminalRejected)$/u);
      expect(recovered.approval?.logical_action_id).toBe(
        run.before.approval?.logical_action_id,
      );
      expect(recovered.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(recovered.executionStopEventCount).toBe(1);
      expect(
        recovered.approvalEvents.filter(
          (event) => event.event_type === "ExecutableApprovalResolved",
        ),
      ).toHaveLength(1);
      expect(recovered.inboxConsumedAt).not.toBeNull();
      expect(recovered.effectCount).toBe(0);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });
});
