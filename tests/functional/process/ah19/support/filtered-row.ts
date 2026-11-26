import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startProductionFixture } from "../../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../../../support/public-client.js";
import {
  type Ah19Probe,
  type Ah19ProviderRequest,
  childEntry,
  fixtures,
  holdAh19ProviderReport,
  probes,
  providerRequests,
  startReportServer,
} from "./diagnostics.js";
import { ah19WorkSeed } from "./seed.js";
import { readTypedSessionRows } from "./snapshot.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export const prepareFilteredRowScenario = async (
  boundary:
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit",
) => {
  probes.length = 0;
  providerRequests.length = 0;
  const marker = `AH19-FILTERED-FRONTIER-${crypto.randomUUID()}`;
  const workSeed = ah19WorkSeed(
    "Keep the Work request pinned while filtering one timeline row.",
    marker,
    "qualify filtered-row checkpoint and restart coverage",
  );
  const nativeGate = holdAh19ProviderReport(
    (request) => request.operationKind === "CompactionNative",
  );
  const reportUrl = await startReportServer(nativeGate.beforeAcknowledge);
  const childOutput: string[] = [];
  const daemonEnvironment = {
    ARBOR_AH19_BOUNDARY: boundary,
    ARBOR_AH19_FRONTIER_TEXT_ONLY: "1",
    ARBOR_AH19_CONTEXT_WINDOW: "1000000",
    ARBOR_AH19_REPORT_URL: reportUrl,
    ARBOR_AH19_ROOT_WORK_SEED_JSON: JSON.stringify(workSeed),
  };
  const fixture = await startProductionFixture({
    reply: () => ({ _tag: "HttpError", status: 500 }),
    firstDaemonEntry: childEntry,
    daemonEnvironment,
    onDaemonStdout: (line) => {
      childOutput.push(line);
      try {
        const probe = JSON.parse(line) as Ah19Probe;
        if (probe.tag === "AH19_PROBE") probes.push(probe);
      } catch {
        // Keep non-probe process output in fixture diagnostics.
      }
    },
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "AH19 filtered Work frontier compaction",
  );
  await submitHumanMessage(client, project, `请创建并开始目标 ${marker}。`);
  const approval = await waitForApproval(client, project, marker);
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "Approve",
    reason: "AH19 filtered frontier Work seed",
  });
  const admittedWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective: string;
        revision: number;
        status: string;
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (work) =>
      work?.objective === workSeed.objective && work.workId !== undefined,
    60_000,
  );
  const workId = admittedWork?.workId;
  if (workId === undefined) {
    throw new Error("filtered frontier Work was not admitted");
  }

  const filterEntryKey = `inb_${randomUUID().replaceAll("-", "")}`;
  const filterText = `${marker}-filtered-session-content`;
  const filteredItem = {
    _tag: "UserMessage",
    source: {
      _tag: "InboxEntry",
      workspaceId: project.rootWorkspaceId,
      entryKey: filterEntryKey,
      kind: "HumanConversation",
    },
    contentRef: `inbox:${filterEntryKey}`,
    text: filterText,
    trust: "DataOnly",
    delivery: "Steer",
  };
  const currentWork = async () =>
    client.view<{
      workId?: string;
      revision: number;
      status: string;
      activeExecution?: { executionId: string };
    } | null>("current-work", { workspaceId: project.rootWorkspaceId });
  const typedRowsNow = () =>
    readTypedSessionRows(fixture.databaseFile, project.rootSessionId);
  const idleWork = await waitForPublic(
    currentWork,
    (work) =>
      work?.workId === workId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
    60_000,
  );
  if (idleWork?.workId !== workId) {
    throw new Error("filtered-row Work was not idle before short inputs");
  }
  const compactionDaemonEnvironment = {
    ...daemonEnvironment,
    ARBOR_AH19_CONTEXT_WINDOW: "16384",
    ARBOR_AH19_ROOT_WORK_ALREADY_ASSIGNED: "1",
  };
  await fixture.crash();
  const db = new DatabaseSync(fixture.databaseFile);
  let filterSequence: number;
  try {
    const session = db
      .prepare("SELECT context_epoch FROM sessions WHERE session_id = ?")
      .get(project.rootSessionId) as { context_epoch: number };
    const next = db
      .prepare(
        "SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence FROM session_entries WHERE session_id = ?",
      )
      .get(project.rootSessionId) as { sequence: number };
    filterSequence = next.sequence;
    const payloadJson = JSON.stringify(filteredItem);
    const contentHash = createHash("sha256").update(payloadJson).digest("hex");
    db.prepare(
      `INSERT INTO session_entries (
         session_id, sequence, entry_kind, item_type, schema_version,
         context_epoch, payload_json, created_at, source_kind, source_ref,
         content_hash
       ) VALUES (?, ?, 'Input', 'UserMessage', 2, ?, ?, ?, 'InboxEntry', ?, ?)`,
    ).run(
      project.rootSessionId,
      filterSequence,
      session.context_epoch,
      payloadJson,
      new Date().toISOString(),
      filterEntryKey,
      contentHash,
    );
  } finally {
    db.close();
  }
  await fixture.restart({
    entry: childEntry,
    daemonEnvironment: compactionDaemonEnvironment,
  });
  const restartedIdleWork = await waitForPublic(
    currentWork,
    (work) =>
      work?.workId === workId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
    60_000,
  );
  if (restartedIdleWork?.workId !== workId) {
    throw new Error("filtered-row Work was not idle after bound change");
  }
  let nativeRequest: Ah19ProviderRequest | undefined;
  let compactionGuidance: string | undefined;
  for (let index = 0; index < 15; index += 1) {
    const before: Awaited<ReturnType<typeof currentWork>> = await waitForPublic(
      currentWork,
      (work) =>
        work?.workId === workId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
      60_000,
    );
    if (before === null || before.workId !== workId) {
      throw new Error("Work stopped being current during text turns");
    }
    const rowsBeforeSteer = typedRowsNow().length;
    const requestsBeforeSteer = providerRequests.length;
    const guidance = `${marker} bounded typed Work input ${index} ${"x".repeat(3000)}`;
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: before.revision,
      steer: {
        severity: "Normal",
        guidance,
      },
      provenance: { source: "HumanInput" },
    });
    const afterSteer = await waitForPublic(
      async () => ({
        work: await currentWork(),
        rowCount: typedRowsNow().length,
        requestCount: providerRequests.length,
        nativeRequest: providerRequests.find(
          (request) => request.operationKind === "CompactionNative",
        ),
      }),
      (state) =>
        state.nativeRequest !== undefined ||
        (state.work?.revision === before.revision + 1 &&
          state.work?.activeExecution === undefined &&
          state.rowCount > rowsBeforeSteer &&
          state.requestCount > requestsBeforeSteer),
      60_000,
    ).catch((error: unknown) => {
      const diagnosticDb = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      let recentExecutions: unknown;
      try {
        recentExecutions = diagnosticDb
          .prepare(
            "SELECT execution_id, episode_kind, episode_revision, settlement_kind, settlement_json FROM executions ORDER BY admitted_at DESC LIMIT 4",
          )
          .all();
      } finally {
        diagnosticDb.close();
      }
      throw new Error(
        `AH19 bounded-frontier public Steer ${index} stalled: ${error instanceof Error ? error.message : String(error)}; providers=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, toolNames, workActionHistoryCount }) => ({ operationKind, providerTurnId, toolNames, workActionHistoryCount })))}; recentExecutions=${JSON.stringify(recentExecutions)}; child=${childOutput.slice(-30).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (afterSteer.nativeRequest !== undefined) {
      nativeRequest = afterSteer.nativeRequest;
      compactionGuidance = guidance;
      break;
    }
  }

  const finalGuidance =
    compactionGuidance ??
    `${marker} final public Work input completes the 64-row window ${"y".repeat(5000)}`;
  if (nativeRequest === undefined) {
    await fixture.crash();
    const lowWindowEnvironment = {
      ...compactionDaemonEnvironment,
      ARBOR_AH19_CONTEXT_WINDOW: "8192",
    };
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: lowWindowEnvironment,
    });
    const finalIdleWork = await waitForPublic(
      currentWork,
      (work) =>
        work?.workId === workId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
      60_000,
    );
    if (finalIdleWork?.workId !== workId) {
      throw new Error("Work stopped being current before the frontier request");
    }
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: finalIdleWork.revision,
      steer: {
        severity: "Normal",
        guidance: finalGuidance,
      },
      provenance: { source: "HumanInput" },
    });
    nativeRequest = await waitForPublic(
      async () =>
        providerRequests.find(
          (request) => request.operationKind === "CompactionNative",
        ),
      (request) => request !== undefined,
      120_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 filtered frontier did not reach Native compaction: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, workActionHistoryCount }) => ({ operationKind, providerTurnId, workActionHistoryCount })))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
  }
  return {
    nativeGate,
    fixture,
    client,
    project,
    workId,
    filterEntryKey,
    filterText,
    filterSequence,
    finalGuidance,
    compactionDaemonEnvironment,
    currentWork,
    typedRowsNow,
    nativeRequest,
  };
};
