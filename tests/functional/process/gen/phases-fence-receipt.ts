import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { waitForLiveOwnerLeaseExpiryForQualification } from "../../support/lease-qualification.js";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah10Probe,
  ah10Child,
  fixtures,
  manualWait,
  pushProbe,
  readAh10Rows,
  releaseGate,
} from "./support.js";

export const ah10GenTakeoverFenceReceipt = async (
  crashSide: "before" | "after",
): Promise<void> => {
  const marker = `AH10-${crypto.randomUUID().slice(0, 8)}`;
  const events: Ah10Probe[] = [];
  const providerMarkerCalls: string[] = [];
  let probeArmed = false;
  let seedWaitIssued = false;
  const fixture = await startProductionFixture({
    isolatedPortHandshake: true,
    reply: (call, index) => {
      const context = JSON.stringify(call.messages);
      const available = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (
        context.includes(marker) &&
        !available.has("claim_completion") &&
        available.has("assign_work")
      ) {
        return context.includes("WorkAssigned(")
          ? { _tag: "Text", text: `Parent Work admitted for ${marker}` }
          : {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Exercise AH10 takeover ${marker}.`,
                why: "qualify old owner fencing and new owner receipt lookup",
                constraints: [],
                completionExpectation:
                  "the pinned action commits one Deliverable",
                verificationMission: {
                  goal: `Verify AH10 source Work ${marker}`,
                  criteria: [
                    {
                      criterionId: "ah10-source-open",
                      requirement:
                        "the source Work remains open during takeover",
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "AH10 process fixture",
              },
            };
      }
      if (context.includes(marker) && available.has("produce_deliverable")) {
        if (!probeArmed) {
          seedWaitIssued = true;
          return manualWait(
            `seed Work waits for takeover probe ${marker}`,
          );
        }
        providerMarkerCalls.push(`provider-call-${index}`);
        return {
          _tag: "ToolCall",
          name: "produce_deliverable",
          arguments: { kind: "report", artifacts: [] },
        };
      }
      return { _tag: "HttpError", status: 422 };
    },
    onDaemonStdout: (line) => pushProbe(events, line),
  });
  fixtures.push(fixture);
  mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "AH10 real daemon takeover",
  );
  const sourceWork = await admitRootWorkThroughPublicConversation(
    client,
    project,
    marker,
    `Please create the AH10 takeover Parent Work ${marker}.`,
  );
  const sourceWorkId = sourceWork.workId;
  const seedWorkAtWait = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
    (work) =>
      seedWaitIssued &&
      work?.workId === sourceWorkId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  if (seedWorkAtWait === null || seedWorkAtWait.workId !== sourceWorkId) {
    throw new Error("AH10 public seed Work did not reach its Manual wait");
  }
  expect(seedWorkAtWait).toMatchObject({
    workId: sourceWorkId,
    revision: 0,
    status: "Open",
  });
  await fixture.crash();
  probeArmed = true;
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_PAUSE_LEASE_RENEWAL: "1",
      ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
        crashSide === "before" ? "1" : "0",
    },
  });
  await client.command(project.projectId, "SteerWork", {
    workId: sourceWorkId,
    workspaceId: project.rootWorkspaceId,
    expectedWorkRevision: seedWorkAtWait.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume the measured AH10 action ${marker}.`,
    },
    provenance: { source: "HumanInput" },
  });

  const oldActionGate = (event: Ah10Probe) =>
    event.role === "old" &&
    event.boundary === "AH7AfterActionIntentCommit" &&
    event.actionIndex === 0;
  const oldAction = await waitForPublic(
    async () => events.find(oldActionGate),
    (event) => event !== undefined,
    30_000,
  );
  if (oldAction === undefined)
    throw new Error("AH10 old action gate is absent");
  expect(oldAction?.providerTurnId).toMatch(/^ptn_/u);
  expect(oldAction?.executionId).toMatch(/^exe_/u);
  const oldLeasePause = (event: Ah10Probe) =>
    event.role === "old" &&
    event.boundary === "AH10BeforeLeaseRenewal" &&
    event.pauseRequested === true &&
    event.executionId === oldAction.executionId;
  const pauseEvidence = await waitForPublic(
    async () => events.find(oldLeasePause),
    (event) => event !== undefined,
    20_000,
  );
  if (pauseEvidence === undefined)
    throw new Error("AH10 old owner did not pause its lease renewal");

  const oldLease = readAh10Rows(fixture.databaseFile).leases.find(
    (lease) => lease.execution_id === oldAction?.executionId,
  );
  expect(oldLease).toMatchObject({ generation: 0 });
  if (oldLease === undefined) throw new Error("AH10 old lease row is absent");
  const expiredLease = await waitForLiveOwnerLeaseExpiryForQualification({
    databaseFile: fixture.databaseFile,
    executionId: oldAction.executionId,
    daemon: { snapshot: () => fixture.daemonProcessSnapshot() },
    pauseEvidence: {
      boundary: "AH10BeforeLeaseRenewal",
      pauseRequested: pauseEvidence.pauseRequested === true,
      executionId: pauseEvidence.executionId,
      fencingGeneration: pauseEvidence.fencingGeneration ?? -1,
    },
    expected: {
      workerId: oldLease.worker_id,
      workerIncarnationId: oldLease.worker_incarnation_id,
      generation: oldLease.generation,
      expiresAt: oldLease.expires_at,
    },
  });
  expect(expiredLease).toEqual(oldLease);

  const newDaemon = await fixture.startAdditionalDaemon({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "new",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
    },
    onStdout: (line) => pushProbe(events, line),
  });
  const newLease = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === oldAction.executionId,
      ),
    (event) => event !== undefined,
    45_000,
  );
  expect(newLease?.fencingGeneration).toBe(1);
  const oldLeaseAcquired = events.find(
    (event) =>
      event.role === "old" &&
      event.boundary === "AH10AfterLeaseAcquired" &&
      event.executionId === oldAction.executionId,
  );
  expect(oldLeaseAcquired?.workerIncarnationId).toBeTruthy();
  expect(newLease?.workerIncarnationId).toBeTruthy();
  expect(newLease?.workerIncarnationId).not.toBe(
    oldLeaseAcquired?.workerIncarnationId,
  );
  const newAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.executionId === oldAction.executionId &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
  expect(newAction?.callRef).toBe(oldAction.callRef);
  expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

  // Let the still-live generation-0 process attempt its actual canonical
  // command only after the DB lease has advanced to generation 1.
  releaseGate(fixture, "old", "action-intent");
  if (crashSide === "before") {
    const beforeCommit = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeFencedReceiptCommit" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(beforeCommit?.commandId).toMatch(/^cmd_/u);
    expect(
      readAh10Rows(fixture.databaseFile).commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      ),
    ).toHaveLength(0);
  } else {
    const fencedReceipt = await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).commands.filter(
          (command) =>
            command.resolution === "TerminalRejected" &&
            command.terminal_error_json?.includes("FencingRejected"),
        ),
      (rows) => rows.length === 1,
      15_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH10 old owner did not persist its fence receipt: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readAh10Rows(fixture.databaseFile))}; oldErrors=${fixture.daemonErrors.join(" | ")}; newErrors=${newDaemon.daemonErrors.join(" | ")}`,
      );
    });
    expect(fencedReceipt).toHaveLength(1);
  }
  expect(readAh10Rows(fixture.databaseFile).works).toHaveLength(1);
  await fixture.crash();

  // The gen-1 handler must see the persisted gen-0 FencingRejected receipt
  // before it sends its generation-scoped command.
  releaseGate(fixture, "new", "action-intent");
  const newActionResult = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionResultCommit" &&
          event.executionId === oldAction.executionId &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  expect(newActionResult?.providerTurnId).toBe(oldAction.providerTurnId);

  const final = readAh10Rows(fixture.databaseFile);
  const rejected = final.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );
  const committed = final.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null) {
      return false;
    }
    const result = JSON.parse(command.result_json) as {
      readonly sourceWorkId?: string;
      readonly kind?: string;
    };
    return result.sourceWorkId === sourceWorkId && result.kind === "report";
  });
  expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
  expect(committed).toHaveLength(1);
  if (crashSide === "after") {
    expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
  }
  expect(final.deliverables).toHaveLength(1);
  expect(final.works).toHaveLength(1);
  expect(final.deliverables[0]).toMatchObject({
    source_work_id: sourceWorkId,
    kind: "report",
  });
  expect(final.actions).toContainEqual(
    expect.objectContaining({
      execution_id: oldAction.executionId,
      provider_turn_id: oldAction.providerTurnId,
      action_index: 0,
      call_ref: oldAction.callRef,
      action_kind: "produce_deliverable",
      state: "Applied",
    }),
  );
  expect(providerMarkerCalls).toHaveLength(1);
  expect(newDaemon.daemonErrors).toEqual([]);
  expect(fixture.daemonErrors).toEqual([]);

  releaseGate(fixture, "new", "action-result");
  await newDaemon.crash();
};
