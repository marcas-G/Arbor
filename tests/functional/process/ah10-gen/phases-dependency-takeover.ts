import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
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

export const ah10GenTakeoverDeclareDependency = async (
  crashSide: "before" | "after",
): Promise<void> => {
  const marker = `AH10-dependency-${crypto.randomUUID().slice(0, 8)}`;
  const dependencyKind = `ah10-dependency-${marker}`;
  const events: Ah10Probe[] = [];
  const providerMarkerCalls: string[] = [];
  let probeArmed = false;
  let seedWaitIssued = false;
  let producerWorkspaceId = "";
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
          ? { _tag: "Text", text: `Dependency Work admitted for ${marker}` }
          : {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Declare dependency ${marker}.`,
                why: "qualify generation-scoped dependency command takeover",
                constraints: [],
                completionExpectation:
                  "one exact dependency is durably declared",
                verificationMission: {
                  goal: `Verify dependency declaration ${marker}`,
                  criteria: [
                    {
                      criterionId: "ah10-dependency-declared",
                      requirement:
                        "the dependency is durable and initially unsatisfied",
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "AH10 process fixture",
              },
            };
      }
      if (!context.includes(marker) || !available.has("declare_dependency")) {
        return { _tag: "HttpError", status: 422 };
      }
      if (!probeArmed) {
        seedWaitIssued = true;
        return manualWait(
          `AH10 seed Work waits for dependency takeover probe ${marker}`,
        );
      }
      providerMarkerCalls.push(`provider-call-${index}`);
      return {
        _tag: "ToolCall",
        name: "declare_dependency",
        arguments: {
          producerBinding: {
            _tag: "WorkspaceBound",
            workspaceId: producerWorkspaceId,
          },
          expectedDeliverable: {
            kind: dependencyKind,
            requiredArtifactRoles: [],
          },
        },
      };
    },
    onDaemonStdout: (line) => pushProbe(events, line),
  });
  fixtures.push(fixture);
  mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "AH10 DeclareDependency generation takeover",
  );
  producerWorkspaceId = project.rootWorkspaceId;
  const consumerWork = await admitRootWorkThroughPublicConversation(
    client,
    project,
    marker,
    `Please admit the dependency Work ${marker}.`,
  );
  const consumerWorkId = consumerWork.workId;
  const seedWorkAtWait = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (work) =>
      seedWaitIssued &&
      work?.workId === consumerWorkId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  if (seedWorkAtWait === null || seedWorkAtWait.workId !== consumerWorkId) {
    throw new Error("AH10 dependency seed Work did not reach Manual wait");
  }
  expect(seedWorkAtWait.revision).toBe(0);
  await fixture.crash();
  probeArmed = true;
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
        crashSide === "before" ? "1" : "0",
      ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE: "1",
    },
  });
  await client.command(project.projectId, "SteerWork", {
    workId: consumerWorkId,
    workspaceId: project.rootWorkspaceId,
    expectedWorkRevision: seedWorkAtWait.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume dependency takeover action ${marker}.`,
    },
    provenance: { source: "HumanInput" },
  });

  const oldAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "old" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  if (oldAction === undefined) {
    throw new Error("AH10 old DeclareDependency intent probe was absent");
  }
  expect(oldAction.callRef).toMatch(/^call_/u);
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", "old-lease-renewal.pause"),
    "pause",
  );
  await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "old" &&
          event.boundary === "AH10BeforeLeaseRenewal" &&
          event.executionId === oldAction.executionId &&
          event.pauseRequested === true,
      ),
    (event) => event !== undefined,
    30_000,
  );
  const leaseAtPause = readAh10Rows(fixture.databaseFile).leases.find(
    (lease) => lease.execution_id === oldAction.executionId,
  );
  expect(leaseAtPause?.generation).toBe(0);
  expect(Date.parse(leaseAtPause?.expires_at ?? "")).toBeGreaterThan(
    Date.now(),
  );
  const expiredOldLease = await waitForPublic(
    async () =>
      readAh10Rows(fixture.databaseFile).leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      ),
    (lease) =>
      lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
    40_000,
  );
  expect(expiredOldLease?.generation).toBe(0);
  expect(fixture.daemonProcessSnapshot()?.alive).toBe(true);

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
  expect(fixture.daemonProcessSnapshot()?.alive).toBe(true);
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
    const fenced = await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).commands.filter(
          (command) =>
            command.resolution === "TerminalRejected" &&
            command.terminal_error_json?.includes("FencingRejected"),
        ),
      (rows) => rows.length === 1,
      15_000,
    );
    expect(fenced).toHaveLength(1);
  }
  expect(readAh10Rows(fixture.databaseFile).dependencies).toHaveLength(0);
  await fixture.crash();
  if (crashSide === "before") {
    expect(
      readAh10Rows(fixture.databaseFile).commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      ),
    ).toHaveLength(0);
  }

  releaseGate(fixture, "new", "action-intent");
  await waitForPublic(
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
      readonly dependencyId?: string;
      readonly consumerWorkId?: string;
      readonly state?: string;
      readonly revision?: number;
    };
    return (
      result.consumerWorkId === consumerWorkId &&
      result.state === "Unsatisfied" &&
      result.revision === 0
    );
  });
  expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
  expect(committed).toHaveLength(1);
  if (crashSide === "after") {
    expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
  }
  expect(final.dependencies).toHaveLength(1);
  expect(final.dependencies[0]).toMatchObject({
    dependency_id: (
      JSON.parse(committed[0]?.result_json ?? "{}") as {
        dependencyId?: string;
      }
    ).dependencyId,
    project_id: project.projectId,
    consumer_work_id: consumerWorkId,
    producer_binding: JSON.stringify({
      _tag: "WorkspaceBound",
      workspaceId: producerWorkspaceId,
    }),
    expected_deliverable: JSON.stringify({
      kind: dependencyKind,
      requiredArtifactRoles: [],
    }),
    revision: 0,
    state: "Unsatisfied",
  });
  expect(final.actions).toContainEqual(
    expect.objectContaining({
      execution_id: oldAction.executionId,
      provider_turn_id: oldAction.providerTurnId,
      logical_action_id: oldAction.logicalActionId,
      call_ref: oldAction.callRef,
      action_kind: "declare_dependency",
      state: "Applied",
    }),
  );
  expect(
    final.actionObservations.filter((observation) =>
      observation.source_ref.startsWith(
        `observation_${oldAction.executionId}_`,
      ),
    ),
  ).toHaveLength(1);
  expect(providerMarkerCalls).toHaveLength(1);
  expect(newDaemon.daemonErrors).toEqual([]);
  expect(fixture.daemonErrors).toEqual([]);
  releaseGate(fixture, "new", "action-result");
  await newDaemon.crash();
};
