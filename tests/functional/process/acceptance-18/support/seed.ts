// Shared AH18 Work admission, measured seed and boundary startup — moved
// verbatim from ah18-overflow-linked-compaction-resume.functional.test.ts (B5 split).
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../../support/production-fixture.js";
import {
  createFunctionalProject,
  type FunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../../../support/public-client.js";
import {
  type Ah18CrashBoundary,
  ah18Child,
  fixtures,
  probes,
  providerServers,
} from "./fixture.js";
import {
  ah18SteerGuidance,
  ah18WorkObjective,
  startOverflowProvider,
} from "./provider.js";
import {
  type Ah18Probe,
  readSnapshot,
  readWorkExecutionId,
} from "./snapshot.js";

export const admitAh18PublicWork = async (
  client: ReturnType<typeof makePublicClient>,
  project: FunctionalProject,
  marker: string,
) => {
  const objective = ah18WorkObjective(marker);
  await submitHumanMessage(
    client,
    project,
    `Please create an AH18 overflow-recovery Work ${marker}: ${objective}`,
  );
  const approval = await waitForApproval(client, project, marker);
  expect(
    await client.view("current-work", {
      workspaceId: project.rootWorkspaceId,
    }),
  ).toBeNull();
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "Approve",
    reason: "AH18 public Work admission",
  });
  const currentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (work) => work?.workId !== undefined && work.objective === objective,
  );
  const workId = currentWork?.workId;
  if (currentWork === null || workId === undefined) {
    throw new Error("AH18 public Root approval did not expose the Open Work");
  }
  expect(currentWork).toMatchObject({ objective, revision: 0, status: "Open" });
  return { workId, revision: currentWork.revision };
};

export const waitForAh18ManualSeed = async (input: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly fixture: ProductionFixture;
  readonly project: FunctionalProject;
  readonly provider: Awaited<ReturnType<typeof startOverflowProvider>>;
  readonly workId: string;
}) => {
  await waitForPublic(
    async () =>
      input.provider.seedRequests.filter((request) => request.kind === "work")
        .length,
    (count) => count === 1,
  );
  await waitForPublic(
    () =>
      input.client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", {
        workspaceId: input.project.rootWorkspaceId,
      }),
    (work) =>
      work?.workId === input.workId &&
      work.revision === 0 &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  const seedExecutionId = await waitForPublic(
    async () => readWorkExecutionId(input.fixture.databaseFile, input.workId),
    (id) => id !== undefined,
  );
  if (seedExecutionId === undefined) {
    throw new Error("AH18 Manual-wait seed WorkEpisode was not admitted");
  }
  const seedSnapshot = readSnapshot(input.fixture.databaseFile, {
    sessionId: input.project.rootSessionId,
    executionId: seedExecutionId,
    workId: input.workId,
  });
  expect(seedSnapshot.session).toEqual({
    session_id: input.project.rootSessionId,
    context_epoch: 0,
  });
  expect(seedSnapshot.checkpoints).toEqual([]);
  expect(seedSnapshot.providerTurns).toHaveLength(1);
  expect(seedSnapshot.providerAttempts).toHaveLength(1);
  expect(seedSnapshot.providerAttempts[0]).toMatchObject({
    outcome: "Success",
    provider_error_kind: null,
  });
  expect(seedSnapshot.execution?.settlement_kind).not.toBe("Failed");
  expect(seedSnapshot.workWait).toMatchObject({
    work_id: input.workId,
    wait_mode: "Any",
  });
  expect(JSON.parse(seedSnapshot.workWait?.conditions_json ?? "[]")).toEqual([
    { _tag: "Manual" },
  ]);
  expect(
    input.provider.seedRequests.some((request) => request.kind === "root"),
  ).toBe(true);
  expect(input.provider.requests).toEqual([]);
  return { seedExecutionId, seedSnapshot };
};

export const startAh18MeasuredWork = async (input: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly fixture: ProductionFixture;
  readonly project: FunctionalProject;
  readonly provider: Awaited<ReturnType<typeof startOverflowProvider>>;
  readonly marker: string;
  readonly restartOptions?: Parameters<ProductionFixture["restart"]>[0];
}) => {
  const sourceWork = await admitAh18PublicWork(
    input.client,
    input.project,
    input.marker,
  );
  const seed = await waitForAh18ManualSeed({
    client: input.client,
    fixture: input.fixture,
    project: input.project,
    provider: input.provider,
    workId: sourceWork.workId,
  });
  await input.fixture.crash();
  await input.fixture.restart(input.restartOptions);
  await input.client.command(input.project.projectId, "SteerWork", {
    workId: sourceWork.workId,
    workspaceId: input.project.rootWorkspaceId,
    expectedWorkRevision: sourceWork.revision,
    steer: {
      severity: "Normal",
      guidance: ah18SteerGuidance(input.marker),
    },
    provenance: { source: "HumanInput" },
  });
  const executionId = await waitForPublic(
    async () =>
      readWorkExecutionId(input.fixture.databaseFile, sourceWork.workId),
    (id) => id !== undefined && id !== seed.seedExecutionId,
  );
  if (executionId === undefined) {
    throw new Error("AH18 measured WorkEpisode did not follow its Manual seed");
  }
  expect(executionId).not.toBe(seed.seedExecutionId);
  expect(
    input.provider.seedRequests.filter((request) => request.kind === "work"),
  ).toHaveLength(1);
  return {
    workId: sourceWork.workId,
    seedExecutionId: seed.seedExecutionId,
    executionId,
  };
};

export const startAtBoundary = async (boundary: Ah18CrashBoundary) => {
  const marker = `AH18-${randomUUID().slice(0, 8)}`;
  probes.length = 0;
  const provider = await startOverflowProvider(marker);
  providerServers.push(provider.server);
  const fixture = await startProductionFixture({
    reply: () => ({ _tag: "HttpError", status: 500 }),
    daemonEnvironment: {
      ARBOR_MODEL_BASE_URL: provider.baseUrl,
    },
    onDaemonStdout: (line) => {
      try {
        const probe = JSON.parse(line) as Ah18Probe;
        if (probe.tag === "AH18_PROBE") probes.push(probe);
      } catch {
        // Keep non-probe daemon output in the fixture for diagnostics.
      }
    },
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH18 linked overflow recovery ${marker}`,
  );
  const measured = await startAh18MeasuredWork({
    client,
    fixture,
    project,
    provider,
    marker,
    restartOptions: {
      entry: ah18Child,
      daemonEnvironment: {
        ARBOR_AH18_BOUNDARY: boundary,
        ARBOR_MODEL_BASE_URL: provider.baseUrl,
      },
    },
  });
  const { workId, seedExecutionId, executionId } = measured;
  expect(executionId).not.toBe(seedExecutionId);
  const boundaryProbe = await waitForPublic(
    async () => probes.find((probe) => probe.boundary === boundary),
    (probe) => probe !== undefined,
    45_000,
  ).catch((error: unknown) => {
    throw new Error(
      `AH18 boundary absent at ${boundary}: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  if (boundaryProbe === undefined) {
    throw new Error(`AH18 probe missing at ${boundary}`);
  }
  expect(boundaryProbe.executionId).toBe(executionId);
  expect(provider.requests.map((request) => request.kind)).toEqual([
    "initial-inference",
  ]);
  return {
    marker,
    provider,
    fixture,
    project,
    workId,
    seedExecutionId,
    boundaryProbe,
  };
};
