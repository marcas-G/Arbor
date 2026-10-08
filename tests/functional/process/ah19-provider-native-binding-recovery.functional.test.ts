import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../support/public-client.js";

interface Ah19Probe {
  readonly tag: "AH19_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
}

interface Ah19ProviderRequest {
  readonly event: "AH19_PROVIDER_REQUEST";
  readonly operationKind: string;
  readonly providerTurnId: string;
  readonly bindingVariant: string;
  readonly items: ReadonlyArray<{
    readonly _tag: string;
    readonly implementation?: string;
    readonly bindingFingerprint?: string;
    readonly opaqueItemRef?: string;
  }>;
}

interface Ah19Snapshot {
  readonly session: { session_id: string; context_epoch: number } | undefined;
  readonly checkpoints: Array<{
    sequence: number;
    item_type: string;
    source_ref: string | null;
    payload_json: string;
    content_hash: string;
  }>;
  readonly providerTurns: Array<{
    provider_turn_id: string;
    execution_id: string;
    session_id: string;
    context_epoch: number;
    manifest_id: string;
    output_contract_ref: string;
    settled_at: string | null;
    finish_reason: string | null;
    manifest_json: string | null;
    portable_request_json: string | null;
  }>;
  readonly providerAttempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    provider_error_kind: string | null;
    settled_at: string | null;
    observation_json: string;
    canonical_event_prefix_json: string;
    delivered_position: number | null;
    continuation_checkpoint_json: string | null;
  }>;
  readonly steps: Array<{
    logical_step_no: number;
    repair_attempt: number;
    provider_turn_id: string;
    state: string;
    next_action_index: number;
    predecessor_logical_step_no: number | null;
    predecessor_repair_attempt: number | null;
    successor_json: string | null;
    decoded_output_hash: string | null;
    model_output_session_sequence: number | null;
  }>;
  readonly actions: Array<{
    logical_step_no: number;
    repair_attempt: number;
    action_index: number;
    logical_action_id: string;
    call_ref: string;
    action_kind: string;
    state: string;
    revision: number;
    observation_source_ref: string | null;
  }>;
  readonly providerLinks: Array<{
    logical_step_no: number;
    repair_attempt: number;
    overflow_ordinal: number;
    role: string;
    provider_turn_id: string;
    predecessor_provider_turn_id: string | null;
    context_epoch: number;
    state: string;
  }>;
  readonly sessionEntries: Array<{
    sequence: number;
    entry_kind: string;
    item_type: string | null;
    source_ref: string | null;
    payload_json: string;
  }>;
  readonly execution:
    | {
        execution_id: string;
        settled_at: string | null;
        settlement_kind: string | null;
      }
    | undefined;
  readonly leases: Array<{
    execution_id: string;
    generation: number;
    expires_at: string;
  }>;
  readonly workWait: { work_id: string } | undefined;
  readonly responseJobs: Array<{
    message_id: string;
    state: string;
    response_body: string | null;
    response_execution_id: string | null;
  }>;
}

const childEntry = resolve(
  "tests/functional/support/ah19-native-daemon-child.mjs",
);
const fixtures: ProductionFixture[] = [];
const reportServers: Server[] = [];
const probes: Ah19Probe[] = [];
const providerRequests: Ah19ProviderRequest[] = [];

const startReportServer = async () => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        providerRequests.push(
          JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as Ah19ProviderRequest,
        );
        response.writeHead(204);
        response.end();
      } catch (error) {
        response.writeHead(400);
        response.end(String(error));
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AH19 report server has no TCP address");
  }
  reportServers.push(server);
  return `http://127.0.0.1:${address.port}/requests`;
};

const readSnapshot = (
  databaseFile: string,
  input: { sessionId: string; executionId: string; workId: string },
): Ah19Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    return {
      session: db
        .prepare(
          "SELECT session_id, context_epoch FROM sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as Ah19Snapshot["session"],
      checkpoints: db
        .prepare(
          `SELECT sequence, item_type, source_ref, payload_json, content_hash
             FROM session_entries WHERE session_id = ?
              AND item_type = 'CompactionCheckpoint' ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah19Snapshot["checkpoints"],
      providerTurns: db
        .prepare(
          `SELECT pt.provider_turn_id, pt.execution_id, pt.session_id,
                  pt.context_epoch, pt.manifest_id, pt.output_contract_ref,
                  pt.settled_at,
                  pt.finish_reason, m.manifest_json, m.portable_request_json
             FROM provider_turns pt
             LEFT JOIN model_context_manifests m
               ON m.provider_turn_id = pt.provider_turn_id
              AND m.manifest_id = pt.manifest_id
            WHERE pt.execution_id = ? ORDER BY pt.provider_turn_id`,
        )
        .all(input.executionId) as Ah19Snapshot["providerTurns"],
      providerAttempts: db
        .prepare(
          `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome,
                  pa.provider_error_kind, pa.settled_at, pa.observation_json,
                  pa.canonical_event_prefix_json, pa.delivered_position,
                  pa.continuation_checkpoint_json
             FROM provider_attempts pa JOIN provider_turns pt
               ON pt.provider_turn_id = pa.provider_turn_id
            WHERE pt.execution_id = ?
            ORDER BY pa.provider_turn_id, pa.attempt_no`,
        )
        .all(input.executionId) as Ah19Snapshot["providerAttempts"],
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  next_action_index,
                  predecessor_logical_step_no, predecessor_repair_attempt,
                  successor_json, decoded_output_hash,
                  model_output_session_sequence
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(input.executionId) as Ah19Snapshot["steps"],
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, action_kind, state, revision,
                  observation_source_ref
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(input.executionId) as Ah19Snapshot["actions"],
      providerLinks: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, overflow_ordinal, role,
                  provider_turn_id, predecessor_provider_turn_id,
                  context_epoch, state
             FROM agent_loop_step_provider_turns WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, overflow_ordinal, role`,
        )
        .all(input.executionId) as Ah19Snapshot["providerLinks"],
      sessionEntries: db
        .prepare(
          `SELECT sequence, entry_kind, item_type, source_ref, payload_json
             FROM session_entries WHERE session_id = ? ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah19Snapshot["sessionEntries"],
      execution: db
        .prepare(
          "SELECT execution_id, settled_at, settlement_kind FROM executions WHERE execution_id = ?",
        )
        .get(input.executionId) as Ah19Snapshot["execution"],
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .all(input.executionId) as Ah19Snapshot["leases"],
      workWait: db
        .prepare("SELECT work_id FROM work_waits WHERE work_id = ?")
        .get(input.workId) as Ah19Snapshot["workWait"],
      responseJobs: db
        .prepare(
          `SELECT message_id, state, response_body, response_execution_id
             FROM conversation_response_jobs
            WHERE active_execution_id = ? OR response_execution_id = ?
            ORDER BY message_id`,
        )
        .all(
          input.executionId,
          input.executionId,
        ) as Ah19Snapshot["responseJobs"],
    };
  } finally {
    db.close();
  }
};

const readExecutionIdForProviderTurn = (
  databaseFile: string,
  providerTurnId: string,
): string => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT execution_id FROM provider_turns WHERE provider_turn_id = ?",
      )
      .get(providerTurnId) as { execution_id: string } | undefined;
    if (row === undefined) {
      throw new Error(`AH19 ProviderTurn missing: ${providerTurnId}`);
    }
    return row.execution_id;
  } finally {
    db.close();
  }
};

const corruptNativeManifestLogicalStepNo = (
  databaseFile: string,
  providerTurnId: string,
  logicalStepNo: number,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT m.manifest_id, m.manifest_json
           FROM model_context_manifests m
          WHERE m.provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) throw new Error("AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    manifest.logicalStepNo = logicalStepNo;
    db.prepare(
      "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
    ).run(JSON.stringify(manifest), row.manifest_id);
  } finally {
    db.close();
  }
};

const corruptCompiledInferenceRequestHash = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`AH19 inference manifest missing: ${providerTurnId}`);
    }
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const originalHash = manifest.compiledRequestHash;
    if (typeof originalHash !== "string" || originalHash === "00000000") {
      throw new Error(
        `AH19 inference compiled hash invalid: ${providerTurnId}`,
      );
    }
    manifest.compiledRequestHash = "00000000";
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `AH19 inference hash corruption missed ${providerTurnId}`,
      );
    }
    return { originalHash, corruptedHash: manifest.compiledRequestHash };
  } finally {
    db.close();
  }
};

const corruptNativeSourceLink = (
  databaseFile: string,
  providerTurnId: string,
  corruption: "repairAttempt" | "role" | "predecessor",
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    if (corruption === "repairAttempt") db.exec("PRAGMA foreign_keys = OFF");
    const statement =
      corruption === "repairAttempt"
        ? "UPDATE agent_loop_step_provider_turns SET repair_attempt = 1 WHERE provider_turn_id = ?"
        : corruption === "role"
          ? "UPDATE agent_loop_step_provider_turns SET role = 'OverflowReplacement' WHERE provider_turn_id = ?"
          : "UPDATE agent_loop_step_provider_turns SET predecessor_provider_turn_id = ? WHERE provider_turn_id = ?";
    const result =
      corruption === "predecessor"
        ? db.prepare(statement).run(`ptn_${executionId}_0`, providerTurnId)
        : db.prepare(statement).run(providerTurnId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 source link corruption missed ${providerTurnId}`);
    }
  } finally {
    db.close();
  }
};

const corruptNativeSuccessPrefix = (
  databaseFile: string,
  providerTurnId: string,
  corruption:
    | "truncated"
    | "duplicate-terminal"
    | "invalid-continuation"
    | "identity-mismatch",
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT canonical_event_prefix_json
           FROM provider_attempts
          WHERE provider_turn_id = ? AND attempt_no = 0`,
      )
      .get(providerTurnId) as
      | { canonical_event_prefix_json: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`AH19 Native Attempt missing: ${providerTurnId}`);
    }
    const events = JSON.parse(row.canonical_event_prefix_json) as Array<
      Record<string, unknown>
    >;
    if (corruption === "truncated") {
      events.pop();
    } else if (corruption === "duplicate-terminal") {
      const terminal = events.at(-1);
      if (terminal === undefined) {
        throw new Error("AH19 Native prefix has no terminal to duplicate");
      }
      events.push({ ...terminal });
    } else if (corruption === "invalid-continuation") {
      const continuation = events.find(
        (event) => event._tag === "ContinuationState",
      );
      if (continuation === undefined) {
        throw new Error("AH19 Native prefix has no continuation state");
      }
      continuation.stateRef = "";
    } else {
      const started = events[0];
      if (started === undefined || started._tag !== "TurnStarted") {
        throw new Error("AH19 Native prefix has no TurnStarted event");
      }
      started.providerTurnId = `ptn_${executionId}_wrong_turn`;
    }
    const result = db
      .prepare(
        `UPDATE provider_attempts
            SET canonical_event_prefix_json = ?
          WHERE provider_turn_id = ? AND attempt_no = 0`,
      )
      .run(JSON.stringify(events), providerTurnId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Native prefix corruption missed ${providerTurnId}`);
    }
  } finally {
    db.close();
  }
};

const corruptStepSuccessorPredecessor = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare(
        `UPDATE agent_loop_steps
            SET predecessor_logical_step_no = 0,
                predecessor_repair_attempt = 0
          WHERE execution_id = ? AND logical_step_no = 2 AND repair_attempt = 0`,
      )
      .run(executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Step 2 successor corruption missed ${executionId}`);
    }
  } finally {
    db.close();
  }
};

const corruptStepSuccessorLogicalStepNo = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT successor_json FROM agent_loop_steps
          WHERE execution_id = ? AND logical_step_no = 1 AND repair_attempt = 0`,
      )
      .get(executionId) as { successor_json: string | null } | undefined;
    if (row?.successor_json === null || row?.successor_json === undefined) {
      throw new Error(`AH19 Step 1 successor missing: ${executionId}`);
    }
    const successor = JSON.parse(row.successor_json) as Record<string, unknown>;
    successor.logicalStepNo = 3;
    const result = db
      .prepare(
        `UPDATE agent_loop_steps SET successor_json = ?
          WHERE execution_id = ? AND logical_step_no = 1 AND repair_attempt = 0`,
      )
      .run(JSON.stringify(successor), executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Step 1 successor corruption missed ${executionId}`);
    }
  } finally {
    db.close();
  }
};

const startAtCheckpointBoundary = async (
  boundary:
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit"
    | "AH12BeforeSuccessCommit"
    | "AH11AfterStepEffectsCommit",
  extraDaemonEnvironment: Readonly<Record<string, string>> = {},
  episode: "Work" | "ConversationResponse" = "Work",
) => {
  probes.length = 0;
  providerRequests.length = 0;
  const reportUrl = await startReportServer();
  const childOutput: string[] = [];
  const fixture = await startProductionFixture({
    reply: () => ({ _tag: "HttpError", status: 500 }),
    firstDaemonEntry: childEntry,
    daemonEnvironment: {
      ARBOR_AH19_BOUNDARY: boundary,
      ARBOR_AH19_BINDING_VARIANT: "A",
      ARBOR_AH19_REPORT_URL: reportUrl,
      ...(episode === "ConversationResponse"
        ? { ARBOR_AH19_TERMINAL_CONVERSATION: "1" }
        : {}),
      ...extraDaemonEnvironment,
    },
    onDaemonStdout: (line) => {
      childOutput.push(line);
      try {
        const event = JSON.parse(line) as Ah19Probe;
        if (event.tag === "AH19_PROBE") probes.push(event);
      } catch {
        // Preserve other daemon output in fixture diagnostics.
      }
    },
  }).catch((error: unknown) => {
    throw new Error(
      `AH19 daemon failed startup: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}`,
    );
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH19 ProviderNative binding ${boundary}`,
  );
  const workId = functionalId("wrk");
  if (episode === "Work") {
    await client.command(project.projectId, "AssignWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: "Qualify a deployment-bound ProviderNative checkpoint.",
      why: "exercise AH19 Native binding qualification",
      constraints: ["never reuse opaque continuation across deployments"],
      completionExpectation: "continue the same logical step after compaction",
      verificationMission: {
        goal: "Verify one ProviderNative binding checkpoint",
        criteria: [
          {
            criterionId: "ah19-native-binding",
            requirement: "checkpoint continuation is deployment-bound",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "AH19 process fixture" },
      revision: 0,
    });
  } else {
    await submitHumanMessage(
      client,
      project,
      `AH19 terminal response ${crypto.randomUUID()}`,
    );
  }
  const probe = await waitForPublic(
    async () => {
      if (boundary !== "AH12BeforeSuccessCommit") {
        return probes.find((entry) => entry.boundary === boundary);
      }
      const request = providerRequests.find(
        (event) => event.operationKind === "CompactionNative",
      );
      if (request === undefined) return undefined;
      const executionId = readExecutionIdForProviderTurn(
        fixture.databaseFile,
        request.providerTurnId,
      );
      const snapshot = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      const turn = snapshot.providerTurns.find(
        (row) => row.provider_turn_id === request.providerTurnId,
      );
      const attempts = snapshot.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === request.providerTurnId,
      );
      const attempt = attempts[0];
      let events: Array<Record<string, unknown>> = [];
      let observation: Record<string, unknown> = {};
      try {
        events = JSON.parse(
          attempt?.canonical_event_prefix_json ?? "[]",
        ) as Array<Record<string, unknown>>;
        observation = JSON.parse(attempt?.observation_json ?? "{}") as Record<
          string,
          unknown
        >;
      } catch {
        return undefined;
      }
      const continuationEvents = events.filter(
        (event) => event._tag === "ContinuationState",
      );
      if (
        turn?.settled_at === null &&
        turn.output_contract_ref === "provider-native-compaction-v1" &&
        attempts.length === 1 &&
        attempt?.outcome === "InProgress" &&
        attempt.delivered_position === 0 &&
        attempt.continuation_checkpoint_json === null &&
        events[0]?._tag === "TurnStarted" &&
        events[0].providerTurnId === request.providerTurnId &&
        events[0].attemptNo === 0 &&
        continuationEvents.length === 1 &&
        continuationEvents[0]?.stateRef ===
          `ah19-opaque:${request.providerTurnId}` &&
        events.at(-1)?._tag === "TurnCompleted" &&
        events.at(-1)?.finishReason === "Stop" &&
        observation.responseStarted === true &&
        observation.canonicalEventEmitted === true &&
        observation.consumerVisibleOutput === false &&
        observation.toolCallProposed === false &&
        observation.continuationAvailable === true &&
        observation.externalEffectPossible === false
      ) {
        return {
          tag: "AH19_PROBE" as const,
          boundary,
          providerTurnId: request.providerTurnId,
          executionId,
        };
      }
      return undefined;
    },
    (entry) => entry !== undefined,
    60_000,
  ).catch((error: unknown) => {
    throw new Error(
      `AH19 checkpoint boundary missing ${boundary}: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}; providerRequests=${JSON.stringify(providerRequests)}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  if (probe === undefined) throw new Error("AH19 checkpoint probe missing");
  const executionId =
    probe.executionId ??
    readExecutionIdForProviderTurn(fixture.databaseFile, probe.providerTurnId);
  return {
    fixture,
    project,
    workId,
    probe: { ...probe, executionId },
    reportUrl,
    childOutput,
  };
};

const waitForLeaseExpiry = async (
  fixture: ProductionFixture,
  sessionId: string,
  executionId: string,
  workId: string,
) =>
  waitForPublic(
    async () =>
      readSnapshot(fixture.databaseFile, { sessionId, executionId, workId })
        .leases[0],
    (lease) =>
      lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
    35_000,
  );

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const server of reportServers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
    });
  }
});

describe("AH19 ProviderNative binding recovery", () => {
  it.each([
    "AH17BeforeCheckpointEpochCommit",
    "AH17AfterCheckpointEpochCommit",
  ] as const)(
    "persists one real ProviderNative checkpoint at %s",
    async (boundary) => {
      const scenario = await startAtCheckpointBoundary(boundary);
      const { fixture, project, workId, probe } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(probe.providerTurnId).toBe(nativeTurnId);
      expect(beforeKill.session?.context_epoch).toBe(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeKill.checkpoints).toHaveLength(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeKill.providerTurns).toHaveLength(3);
      const nativeTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(nativeTurn).toMatchObject({
        execution_id: executionId,
        session_id: project.rootSessionId,
        context_epoch: 0,
        settled_at: expect.any(String),
        finish_reason: "Stop",
        manifest_json: expect.any(String),
      });
      expect(JSON.parse(nativeTurn?.manifest_json ?? "{}")).toMatchObject({
        operationKind: "CompactionNative",
        resolvedModelBindingFingerprint:
          expect.stringMatching(/^p16fp_[0-9a-f]{64}$/u),
        inputFrontier: {
          firstSequence: expect.any(Number),
          lastSequence: expect.any(Number),
        },
        contextRefs: expect.arrayContaining([expect.any(String)]),
      });
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(providerRequests.map((event) => event.operationKind)).toEqual([
        "Inference",
        "Inference",
        "CompactionNative",
      ]);
      expect(beforeKill.steps).toEqual([
        expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
        expect.objectContaining({ logical_step_no: 1, repair_attempt: 0 }),
      ]);
      expect(
        beforeKill.sessionEntries.some((entry) =>
          entry.payload_json.includes("preserve-portable-frontier"),
        ),
      ).toBe(true);

      if (boundary === "AH17AfterCheckpointEpochCommit") {
        const checkpoint = JSON.parse(
          beforeKill.checkpoints[0]?.payload_json ?? "{}",
        ) as Record<string, unknown>;
        expect(checkpoint).toMatchObject({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          fromEpoch: 0,
          toEpoch: 1,
          opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
          bindingFingerprint: JSON.parse(nativeTurn?.manifest_json ?? "{}")
            .resolvedModelBindingFingerprint,
        });
      }
      expect(fixture.daemonErrors).toEqual([]);
    },
    120_000,
  );
});

describe("AH19 restart binding qualification", () => {
  it("fails closed rather than sending an older Native opaque checkpoint to a changed binding", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(targetNativeTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(beforeKill.checkpoints[0]?.source_ref).toBe(olderNativeTurnId);
    const olderCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(olderCheckpoint.opaqueItemRef).toBe(olderOpaqueRef);
    const targetNativeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === targetNativeTurnId,
    );
    expect(targetNativeTurn).toMatchObject({
      settled_at: expect.any(String),
      output_contract_ref: "provider-native-compaction-v1",
    });
    const targetNativeRequest = JSON.parse(
      targetNativeTurn?.portable_request_json ?? "{}",
    ) as { inputItems?: ReadonlyArray<Record<string, unknown>> };
    expect(
      targetNativeRequest.inputItems?.filter(
        (item) =>
          item._tag === "CompactionCheckpoint" &&
          item.implementation === "ProviderNative",
      ),
    ).toEqual([
      expect.objectContaining({
        implementation: "ProviderNative",
        opaqueItemRef: olderOpaqueRef,
      }),
    ]);
    expect(
      beforeKill.providerLinks.filter(
        (link) => link.provider_turn_id === targetNativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        logical_step_no: 2,
        repair_attempt: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_2`,
        context_epoch: 1,
      }),
    ]);
    const olderReplacementLink = beforeKill.providerLinks.find(
      (link) =>
        link.logical_step_no === 1 && link.role === "OverflowReplacement",
    );
    expect(olderReplacementLink).toMatchObject({
      provider_turn_id: `ptn_${executionId}_1_overflow_0`,
      predecessor_provider_turn_id: olderNativeTurnId,
      context_epoch: 1,
    });

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session?.context_epoch).toBe(1);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    expect(
      afterKill.providerTurns.find(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toEqual(targetNativeTurn);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_CAPTURE_EXIT: "1",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .catch((error: unknown) => {
        const childDiagnostics = childOutput.flatMap((line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery"
            ) {
              return [`${String(event.stage)}:${String(event.providerTurnId)}`];
            }
            if (
              event.tag === "AH19_CHILD_START" ||
              event.tag === "AH19_CHILD_BINDING" ||
              event.tag === "AH19_CHILD_ERROR" ||
              event.tag === "AH19_CHILD_EXIT"
            ) {
              return [JSON.stringify(event)];
            }
            return [];
          } catch {
            return [];
          }
        });
        const snapshot = readSnapshot(fixture.databaseFile, ids);
        throw new Error(
          `AH19 nested no-leak restart health failure: ${error instanceof Error ? error.message : String(error)}; child=${childDiagnostics.join(" | ")}; daemonStderr=${JSON.stringify(fixture.daemonErrors)}; snapshot=${JSON.stringify(
            {
              session: snapshot.session,
              checkpoints: snapshot.checkpoints.map((row) => ({
                sequence: row.sequence,
                source: row.source_ref,
                payload: row.payload_json,
              })),
              turns: snapshot.providerTurns.map((row) => ({
                id: row.provider_turn_id,
                epoch: row.context_epoch,
                settled: row.settled_at,
                finish: row.finish_reason,
              })),
              attempts: snapshot.providerAttempts.map((row) => ({
                id: row.provider_turn_id,
                no: row.attempt_no,
                outcome: row.outcome,
                error: row.provider_error_kind,
              })),
              steps: snapshot.steps.map((row) => ({
                step: row.logical_step_no,
                repair: row.repair_attempt,
                state: row.state,
                successor: row.successor_json,
              })),
              links: snapshot.providerLinks,
              execution: snapshot.execution,
              leases: snapshot.leases,
            },
          )}; BRequests=${JSON.stringify(
            providerRequests.filter(
              (request) => request.bindingVariant === "B",
            ),
          )}`,
        );
      });
    const recovery = await waitForPublic(
      async () => ({
        resumedSuccessor: childOutput.some((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
              providerTurnId?: string;
            };
            return (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage ===
                `NativeRebaseResumesPersistedSuccessor:from=1:to=2:providerTurn=ptn_${executionId}_2` &&
              event.providerTurnId === olderNativeTurnId
            );
          } catch {
            return false;
          }
        }),
        nestedRejected: childOutput.some((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
              providerTurnId?: string;
            };
            return (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage === "NestedNativeFrontierRejected" &&
              event.providerTurnId === targetNativeTurnId
            );
          } catch {
            return false;
          }
        }),
        leakedRequest: providerRequests.find(
          (event) =>
            event.bindingVariant === "B" &&
            event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
        ),
      }),
      (state) =>
        state.resumedSuccessor ||
        state.nestedRejected ||
        state.leakedRequest !== undefined,
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 nested Native rebase did not reach a bounded decision: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(recovery.resumedSuccessor).toBe(true);
    expect(recovery.nestedRejected).toBe(true);
    expect(recovery.leakedRequest).toBeUndefined();
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
      ),
    ).toEqual([]);
    const afterRejection = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRejection.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
  }, 180_000);

  it("fails closed when the persisted NextStepReady successor does not point back to its source", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    const targetStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 2 && step.repair_attempt === 0,
    );
    expect(sourceStep?.state).toBe("NextStepReady");
    expect(JSON.parse(sourceStep?.successor_json ?? "{}")).toMatchObject({
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    expect(targetStep).toMatchObject({
      predecessor_logical_step_no: 1,
      predecessor_repair_attempt: 0,
    });

    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptStepSuccessorPredecessor(fixture.databaseFile, executionId);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    expect(
      corrupted.steps.find((step) => step.logical_step_no === 2),
    ).toMatchObject({
      predecessor_logical_step_no: 0,
      predecessor_repair_attempt: 0,
    });

    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const successorCheckStage = await waitForPublic(
      async () =>
        childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                boundary?: string;
                stage?: string;
                providerTurnId?: string;
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage?.startsWith("NativeRebaseSuccessorChecks:") ===
                true &&
              event.stage.includes("predecessorStep=false") &&
              event.providerTurnId === olderNativeTurnId,
          ),
      (event) => event !== undefined,
      45_000,
    );
    expect(successorCheckStage?.stage).toContain("predecessorStep=false");
    expect(
      childOutput.some((line) =>
        line.includes("NativeRebaseResumesPersistedSuccessor"),
      ),
    ).toBe(false);
    const leakedRequests = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
    );
    expect(leakedRequests).toEqual([]);
    const afterRestart = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRestart.providerTurns.find(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toBeDefined();
    expect(
      afterRestart.checkpoints.some(
        (checkpoint) => checkpoint.source_ref === targetNativeTurnId,
      ),
    ).toBe(false);
  }, 180_000);

  it("fails closed when the persisted NextStepReady successor skips a logical step", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(sourceStep?.state).toBe("NextStepReady");
    expect(JSON.parse(sourceStep?.successor_json ?? "{}")).toMatchObject({
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptStepSuccessorLogicalStepNo(fixture.databaseFile, executionId);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    expect(
      JSON.parse(
        corrupted.steps.find((step) => step.logical_step_no === 1)
          ?.successor_json ?? "{}",
      ).logicalStepNo,
    ).toBe(3);

    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const successorCheckStage = await waitForPublic(
      async () =>
        childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                boundary?: string;
                stage?: string;
                providerTurnId?: string;
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage?.startsWith("NativeRebaseSuccessorChecks:") ===
                true &&
              event.stage.includes("exactNextStep=false") &&
              event.providerTurnId === olderNativeTurnId,
          ),
      (event) => event !== undefined,
      45_000,
    );
    expect(successorCheckStage?.stage).toContain("exactNextStep=false");
    expect(
      childOutput.some((line) =>
        line.includes("NativeRebaseResumesPersistedSuccessor"),
      ),
    ).toBe(false);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
      ),
    ).toEqual([]);
    const afterRestart = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRestart.providerTurns.some(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toBe(true);
    expect(
      afterRestart.checkpoints.some(
        (checkpoint) => checkpoint.source_ref === targetNativeTurnId,
      ),
    ).toBe(false);
  }, 180_000);

  it("rebases a StepEffectsCommitted Native source to its exact next successor without replaying effects", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_AH11_MATCH_INDEX: "2",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_1`;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const replacementTurnId = `ptn_${executionId}_1_overflow_0`;
    const replacementCallRef = `call_ah19_plan_${replacementTurnId.replaceAll(/[^a-zA-Z0-9]/gu, "_")}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(sourceInferenceTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(beforeKill.checkpoints[0]?.source_ref).toBe(olderNativeTurnId);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 1,
    });
    const olderReplacementLink = beforeKill.providerLinks.find(
      (link) =>
        link.logical_step_no === 1 && link.role === "OverflowReplacement",
    );
    expect(olderReplacementLink).toMatchObject({
      provider_turn_id: replacementTurnId,
      predecessor_provider_turn_id: olderNativeTurnId,
      context_epoch: 1,
    });
    const sourceAction = beforeKill.actions.filter(
      (action) => action.logical_step_no === 1 && action.repair_attempt === 0,
    );
    expect(sourceAction).toHaveLength(1);
    expect(sourceAction[0]).toMatchObject({
      call_ref: replacementCallRef,
      action_kind: "update_plan",
      state: "Applied",
    });
    expect(
      beforeKill.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          entry.payload_json.includes(replacementCallRef),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.providerTurnId === sourceInferenceTurnId,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.providerTurnId === replacementTurnId,
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.steps.find((step) => step.logical_step_no === 1)).toEqual(
      sourceStep,
    );
    expect(
      afterKill.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    const converged = await waitForPublic(
      async () => {
        const snapshot = readSnapshot(fixture.databaseFile, ids);
        const resumedStep = snapshot.steps.find(
          (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
        );
        const childFailure = childOutput.some((line) => {
          try {
            return (
              (JSON.parse(line) as { tag?: string }).tag === "AH19_CHILD_ERROR"
            );
          } catch {
            return false;
          }
        });
        return { snapshot, resumedStep, childFailure };
      },
      (state) =>
        state.resumedStep?.state === "NextStepReady" || state.childFailure,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 StepEffectsCommitted successor did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(
      converged.childFailure,
      `AH19 StepEffectsCommitted RED snapshot=${JSON.stringify({
        sessionEpoch: converged.snapshot.session?.context_epoch,
        checkpoints: converged.snapshot.checkpoints.map((entry) => ({
          sourceRef: entry.source_ref,
          payload: entry.payload_json,
        })),
        steps: converged.snapshot.steps.map((step) => ({
          step: step.logical_step_no,
          repair: step.repair_attempt,
          state: step.state,
          successor: step.successor_json,
        })),
        replacementLink: converged.snapshot.providerLinks.find(
          (link) =>
            link.logical_step_no === 1 && link.role === "OverflowReplacement",
        ),
        child: childOutput.filter(
          (line) =>
            line.includes("AH19NativeCheckpointRecovery") ||
            line.includes("AH19_CHILD_ERROR"),
        ),
        bindingBRequests: providerRequests.filter(
          (event) => event.bindingVariant === "B",
        ),
      })}`,
    ).toBe(false);
    const successorProgress = await waitForPublic(
      async () => ({
        snapshot: readSnapshot(fixture.databaseFile, ids),
        successorRequested: providerRequests.some(
          (event) =>
            event.bindingVariant === "B" &&
            event.operationKind === "Inference" &&
            event.providerTurnId === `ptn_${executionId}_2`,
        ),
      }),
      (state) =>
        state.successorRequested || state.snapshot.workWait !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 StepEffectsCommitted successor did not run: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}`,
      );
    });
    const finalSnapshot = successorProgress.snapshot;
    const resumedStep = finalSnapshot.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(resumedStep?.state).toBe("NextStepReady");
    const successor = JSON.parse(resumedStep?.successor_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(successor).toMatchObject({
      executionId,
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    expect(
      finalSnapshot.steps.find(
        (step) => step.logical_step_no === 2 && step.repair_attempt === 0,
      )?.predecessor_logical_step_no,
    ).toBe(1);
    expect(finalSnapshot.session?.context_epoch).toBe(2);
    expect(finalSnapshot.checkpoints).toHaveLength(2);
    expect(
      finalSnapshot.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
    expect(
      finalSnapshot.actions.filter((action) => action.logical_step_no === 1),
    ).toEqual(sourceAction);
    expect(
      finalSnapshot.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          entry.payload_json.includes(replacementCallRef),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "A" &&
          [sourceInferenceTurnId, replacementTurnId].includes(
            event.providerTurnId,
          ),
      ),
    ).toHaveLength(2);
    const bindingBSummary = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.operationKind === "CompactionSummary",
    );
    expect(bindingBSummary).toHaveLength(1);
    expect(
      bindingBSummary[0]?.items.filter(
        (item) => item.opaqueItemRef !== undefined,
      ),
    ).toEqual([]);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.operationKind === "Inference" &&
          event.providerTurnId === `ptn_${executionId}_2`,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.providerTurnId === replacementTurnId,
      ),
    ).toEqual([]);
    expect(
      providerRequests.some(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some(
            (item) => item.opaqueItemRef === `ah19-opaque:${olderNativeTurnId}`,
          ),
      ),
    ).toBe(false);
  }, 180_000);

  it("settles a terminal ConversationResponse from its pinned StepEffectsCommitted output after Native rebase", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      { ARBOR_AH19_AH11_MATCH_INDEX: "1" },
      "ConversationResponse",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const nativeTurnId = `ptn_${executionId}_0_native_compact_0`;
    const replacementTurnId = `ptn_${executionId}_0_overflow_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(sourceInferenceTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const responseJob = beforeKill.responseJobs[0];
    expect(responseJob).toMatchObject({
      state: "Running",
      response_body: null,
      response_execution_id: null,
    });
    expect(beforeKill.execution?.settlement_kind).toBeNull();
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(beforeKill.checkpoints[0]?.source_ref).toBe(nativeTurnId);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 0,
      model_output_session_sequence: expect.any(Number),
      decoded_output_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const sourcedAnswer = beforeKill.sessionEntries.find(
      (entry) =>
        entry.sequence === sourceStep?.model_output_session_sequence &&
        entry.source_ref === `${replacementTurnId}:assistant`,
    );
    expect(sourcedAnswer?.entry_kind).toBe("ModelOutput");
    expect(sourcedAnswer?.item_type).toBe("AssistantMessage");
    expect(sourcedAnswer?.source_ref).toBe(`${replacementTurnId}:assistant`);
    expect(sourcedAnswer?.payload_json).toContain(
      "AH19 recovered terminal conversation answer.",
    );
    expect(beforeKill.actions).toEqual([]);
    expect(
      providerRequests.filter(
        (event) =>
          event.providerTurnId === sourceInferenceTurnId ||
          event.providerTurnId === nativeTurnId ||
          event.providerTurnId === replacementTurnId,
      ),
    ).toHaveLength(3);

    await fixture.crash();
    expect(readSnapshot(fixture.databaseFile, ids).steps).toEqual(
      beforeKill.steps,
    );
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .catch((error: unknown) => {
        const qualification = childOutput.flatMap((line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            return event.tag === "AH19_PROBE"
              ? [`${String(event.boundary)}:${String(event.stage)}`]
              : event.tag === "AH19_CHILD_ERROR"
                ? [
                    `CHILD_ERROR:${String(event.message)}:${String(event.stack ?? "")}`,
                  ]
                : [String(event.tag)];
          } catch {
            return [];
          }
        });
        throw new Error(
          `AH19 ConversationResponse daemon restart failed: ${error instanceof Error ? error.message : String(error)}; qualification=${qualification.join(" | ")}; providerRequests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, bindingVariant, items }) => ({ operationKind, providerTurnId, bindingVariant, opaque: items.filter((item) => item.opaqueItemRef !== undefined).map((item) => item.opaqueItemRef) })))}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids), (_key, value) => (typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}…` : value))}`,
        );
      });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.execution !== undefined &&
        snapshot.execution.settled_at !== null &&
        snapshot.responseJobs.some((job) => job.state === "Answered"),
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 ConversationResponse terminal recovery did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const messageId = responseJob?.message_id;
    expect(messageId).toBeDefined();
    expect(
      recovered.execution,
      `AH19 ConversationResponse terminal mismatch: ${JSON.stringify({
        execution: recovered.execution,
        responseJobs: recovered.responseJobs,
        steps: recovered.steps,
        providerTurns: recovered.providerTurns.map((turn) => ({
          id: turn.provider_turn_id,
          epoch: turn.context_epoch,
          output: turn.output_contract_ref,
          settled: turn.settled_at,
          finish: turn.finish_reason,
        })),
        providerRequests: providerRequests.map((event) => ({
          id: event.providerTurnId,
          op: event.operationKind,
          binding: event.bindingVariant,
        })),
        child: childOutput
          .filter(
            (line) =>
              line.includes("AH19NativeCheckpointRecovery") ||
              line.includes("AH19_CHILD_ERROR"),
          )
          .slice(-12),
      })}`,
    ).toMatchObject({
      execution_id: executionId,
      settlement_kind: "Completed",
    });
    const recoveredStep = recovered.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(recoveredStep?.state).toBe("SettlementProposed");
    expect(recoveredStep?.successor_json).toBeNull();
    expect(recoveredStep?.decoded_output_hash).toBe(
      sourceStep?.decoded_output_hash,
    );
    expect(recoveredStep?.model_output_session_sequence).toBe(
      sourceStep?.model_output_session_sequence,
    );
    expect(recovered.responseJobs).toEqual([
      expect.objectContaining({
        message_id: messageId,
        state: "Answered",
        response_execution_id: executionId,
        response_body: "AH19 recovered terminal conversation answer.",
      }),
    ]);
    expect(
      recovered.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "ModelOutput" &&
          entry.item_type === "AssistantMessage" &&
          entry.source_ref === `${replacementTurnId}:assistant`,
      ),
    ).toEqual([sourcedAnswer]);
    expect(
      recovered.providerTurns.filter(
        (turn) =>
          turn.provider_turn_id === sourceInferenceTurnId ||
          turn.provider_turn_id === nativeTurnId ||
          turn.provider_turn_id === replacementTurnId,
      ),
    ).toHaveLength(3);
    const terminalBindingBSummary = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.operationKind === "CompactionSummary",
    );
    expect(terminalBindingBSummary).toHaveLength(1);
    expect(
      terminalBindingBSummary[0]?.items.some(
        (item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`,
      ),
    ).toBe(false);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);

  it("fails closed on a corrupted compiled hash for the pinned terminal output before Summary", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      { ARBOR_AH19_AH11_MATCH_INDEX: "1" },
      "ConversationResponse",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const replacementTurnId = `ptn_${executionId}_0_overflow_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 0,
    });
    expect(
      beforeKill.sessionEntries.some(
        (entry) =>
          entry.sequence === sourceStep?.model_output_session_sequence &&
          entry.source_ref === `${replacementTurnId}:assistant`,
      ),
    ).toBe(true);
    const nativeCheckpoint = beforeKill.checkpoints[0];
    expect(nativeCheckpoint).toBeDefined();
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const corrupted = corruptCompiledInferenceRequestHash(
      fixture.databaseFile,
      replacementTurnId,
    );
    expect(corrupted.originalHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(corrupted.corruptedHash).not.toBe(corrupted.originalHash);
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const failedClosed = await waitForPublic(
      async () => {
        const childFailure = childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                error?: { reason?: string };
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_CHILD_ERROR" &&
              event.error?.reason === "AgentLoopStepReplayBindingMismatch",
          );
        return {
          snapshot: readSnapshot(fixture.databaseFile, ids),
          childFailure,
        };
      },
      (value) => value.childFailure !== undefined,
      20_000,
    );
    expect(failedClosed.snapshot.leases[0]?.generation).toBe(1);
    expect(failedClosed.snapshot.session?.context_epoch).toBe(1);
    expect(failedClosed.snapshot.checkpoints).toEqual([nativeCheckpoint]);
    expect(
      failedClosed.snapshot.steps.find(
        (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
      ),
    ).toEqual(sourceStep);
    expect(failedClosed.snapshot.execution?.settlement_kind).toBeNull();
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);

  it("locally settles complete Native success evidence on the same Turn and Manifest after process loss", async () => {
    const scenario = await startAtCheckpointBoundary("AH12BeforeSuccessCommit");
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(nativeTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    const beforeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(beforeTurn).toMatchObject({
      output_contract_ref: "provider-native-compaction-v1",
      settled_at: null,
      finish_reason: null,
      manifest_json: expect.any(String),
      portable_request_json: expect.any(String),
    });
    const beforeAttempt = beforeKill.providerAttempts.find(
      (attempt) => attempt.provider_turn_id === nativeTurnId,
    );
    expect(beforeAttempt).toMatchObject({
      attempt_no: 0,
      outcome: "InProgress",
      delivered_position: 0,
      continuation_checkpoint_json: null,
    });
    const beforeObservation = JSON.parse(
      beforeAttempt?.observation_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeObservation).toEqual({
      responseStarted: true,
      canonicalEventEmitted: true,
      consumerVisibleOutput: false,
      toolCallProposed: false,
      continuationAvailable: true,
      externalEffectPossible: false,
    });
    const completePrefix = JSON.parse(
      beforeAttempt?.canonical_event_prefix_json ?? "[]",
    ) as Array<{ _tag?: string; finishReason?: string; stateRef?: string }>;
    expect(completePrefix.map((event) => event._tag)).toEqual([
      "TurnStarted",
      "ContinuationState",
      "TurnCompleted",
    ]);
    expect(completePrefix.at(-1)?.finishReason).toBe("Stop");
    expect(completePrefix[1]?.stateRef).toBe(`ah19-opaque:${nativeTurnId}`);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toEqual([
      expect.objectContaining({
        providerTurnId: nativeTurnId,
        bindingVariant: "A",
      }),
    ]);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toEqual(beforeTurn);
    expect(afterKill.providerAttempts).toEqual(beforeKill.providerAttempts);
    expect(afterKill.checkpoints).toEqual([]);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });

    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 unsettled Native Turn did not recover: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${scenario.childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recoveredNativeTurn = recovered.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(recoveredNativeTurn?.manifest_id).toBe(beforeTurn?.manifest_id);
    expect(recoveredNativeTurn?.manifest_json).toBe(beforeTurn?.manifest_json);
    expect(recoveredNativeTurn?.portable_request_json).toBe(
      beforeTurn?.portable_request_json,
    );
    expect(recoveredNativeTurn?.output_contract_ref).toBe(
      "provider-native-compaction-v1",
    );
    expect(recoveredNativeTurn?.finish_reason).toBe("Stop");
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_no: 0,
        outcome: "Success",
        delivered_position: completePrefix.length,
      }),
    ]);
    const nativeRequests = providerRequests.filter(
      (event) => event.operationKind === "CompactionNative",
    );
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests.map((event) => event.providerTurnId)).toEqual([
      nativeTurnId,
    ]);
    expect(
      recovered.checkpoints.filter(
        (entry) => entry.source_ref === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);

  it.each([
    "truncated",
    "duplicate-terminal",
    "invalid-continuation",
    "identity-mismatch",
  ] as const)(
    "does not locally settle Native success when its canonical prefix is %s",
    async (corruption) => {
      const scenario = await startAtCheckpointBoundary(
        "AH12BeforeSuccessCommit",
      );
      const { fixture, project, workId, probe, reportUrl } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const beforeTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const beforeAttempt = beforeKill.providerAttempts.find(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      );
      expect(beforeTurn).toMatchObject({
        output_contract_ref: "provider-native-compaction-v1",
        settled_at: null,
        manifest_json: expect.any(String),
      });
      expect(beforeAttempt).toMatchObject({
        outcome: "InProgress",
        delivered_position: 0,
      });

      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptNativeSuccessPrefix(
        fixture.databaseFile,
        nativeTurnId,
        corruption,
        executionId,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      expect(
        corrupted.providerAttempts.find(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        )?.outcome,
      ).toBe("InProgress");
      expect(
        corrupted.providerTurns.find(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toEqual(beforeTurn);

      const restartResult = await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_REPORT_URL: reportUrl,
          },
        })
        .then(
          () => ({ healthy: true as const }),
          (error: unknown) => ({ healthy: false as const, error }),
        );
      let rejected: Ah19Snapshot;
      if (restartResult.healthy) {
        rejected = await waitForPublic(
          async () => readSnapshot(fixture.databaseFile, ids),
          (snapshot) =>
            snapshot.providerAttempts.some(
              (attempt) =>
                attempt.provider_turn_id === nativeTurnId &&
                attempt.outcome === "TerminalFailure",
            ),
          60_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH19 malformed Native prefix was not failed closed (${corruption}): ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${scenario.childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
      } else {
        const childFailure = scenario.childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                error?: {
                  cause?: { safeDiagnostic?: string };
                };
              };
            } catch {
              return undefined;
            }
          })
          .find((event) => event?.tag === "AH19_CHILD_ERROR");
        expect(childFailure?.error?.cause?.safeDiagnostic).toBe(
          "provider-turn-recovery-stopped",
        );
        rejected = readSnapshot(fixture.databaseFile, ids);
      }
      const rejectedTurn = rejected.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(rejectedTurn).toMatchObject({
        output_contract_ref: "provider-native-compaction-v1",
        finish_reason: "Failed",
      });
      expect(rejected.session?.context_epoch).toBe(0);
      expect(rejected.checkpoints).toEqual([]);
      expect(
        rejected.providerTurns.filter(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toHaveLength(1);
      expect(
        providerRequests.filter(
          (event) => event.operationKind === "CompactionNative",
        ),
      ).toEqual([
        expect.objectContaining({
          providerTurnId: nativeTurnId,
          bindingVariant: "A",
        }),
      ]);
    },
    180_000,
  );

  it("locally commits the same settled Native receipt after a pre-checkpoint crash when the binding still matches", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toMatchObject({ settled_at: expect.any(String), finish_reason: "Stop" });
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session).toEqual(beforeKill.session);
    expect(afterKill.checkpoints).toEqual([]);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });

    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    );
    expect(recovered.checkpoints).toHaveLength(1);
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.some(
        (event) =>
          event.bindingVariant === "A" &&
          event.operationKind === "Inference" &&
          event.items.some(
            (item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`,
          ),
      ),
    ).toBe(true);
    expect(
      providerRequests.some(
        (event) => event.operationKind === "CompactionSummary",
      ),
    ).toBe(false);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);

  it("fails closed when a Native manifest claims a different source logical step", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.providerTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider_turn_id: nativeTurnId }),
      ]),
    );
    const beforeKillNativeManifest = JSON.parse(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      )?.manifest_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeKillNativeManifest.logicalStepNo).toBe(1);
    expect(
      beforeKill.providerLinks.filter(
        (link) => link.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        logical_step_no: 1,
        repair_attempt: 0,
        overflow_ordinal: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_1`,
        context_epoch: 0,
      }),
    ]);

    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptNativeManifestLogicalStepNo(fixture.databaseFile, nativeTurnId, 0);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    const corruptedNative = corrupted.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(
      JSON.parse(corruptedNative?.manifest_json ?? "{}").logicalStepNo,
    ).toBe(0);
    expect(nativeTurnId).toContain("_1_native_compact_0");

    const restartFailure = await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(restartFailure).not.toBeNull();
    const childFailure = scenario.childOutput
      .map((line) => {
        try {
          return JSON.parse(line) as {
            tag?: string;
            error?: { reason?: string };
          };
        } catch {
          return undefined;
        }
      })
      .find((event) => event?.tag === "AH19_CHILD_ERROR");
    expect(childFailure?.error?.reason).toBe(
      "AgentLoopStepReplayBindingMismatch",
    );
    const rejected = readSnapshot(fixture.databaseFile, ids);
    expect(rejected.session?.context_epoch).toBe(1);
    expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
    expect(rejected.execution?.settled_at).toBeNull();
    expect(rejected.leases.at(-1)?.generation).toBe(1);
    expect(rejected.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_step_no: 1,
          repair_attempt: 0,
          provider_turn_id: nativeTurnId.replace("_native_compact_0", ""),
          state: "Prepared",
        }),
      ]),
    );
    expect(
      rejected.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(
      rejected.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([expect.objectContaining({ attempt_no: 0, outcome: "Success" })]);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
  }, 150_000);

  it.each(["repairAttempt", "role", "predecessor"] as const)(
    "fails closed when the P20 source link has a mismatched %s",
    async (corruption) => {
      const scenario = await startAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const { fixture, project, workId, probe, reportUrl } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(
        beforeKill.providerLinks.find(
          (link) => link.provider_turn_id === nativeTurnId,
        ),
      ).toMatchObject({
        logical_step_no: 1,
        repair_attempt: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_1`,
        context_epoch: 0,
      });

      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptNativeSourceLink(
        fixture.databaseFile,
        nativeTurnId,
        corruption,
        executionId,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      const corruptedLink = corrupted.providerLinks.find(
        (link) => link.provider_turn_id === nativeTurnId,
      );
      expect(corruptedLink).toBeDefined();
      if (corruption === "repairAttempt") {
        expect(corruptedLink?.repair_attempt).toBe(1);
      } else if (corruption === "role") {
        expect(corruptedLink?.role).toBe("OverflowReplacement");
      } else {
        expect(corruptedLink?.predecessor_provider_turn_id).toBe(
          `ptn_${executionId}_0`,
        );
      }

      const restartFailure = await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "B",
            ARBOR_AH19_REPORT_URL: reportUrl,
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(restartFailure).not.toBeNull();
      const childFailure = scenario.childOutput
        .map((line) => {
          try {
            return JSON.parse(line) as {
              tag?: string;
              error?: { reason?: string };
            };
          } catch {
            return undefined;
          }
        })
        .find((event) => event?.tag === "AH19_CHILD_ERROR");
      expect(childFailure?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );
      const rejected = readSnapshot(fixture.databaseFile, ids);
      expect(rejected.session?.context_epoch).toBe(1);
      expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
      expect(rejected.execution?.settled_at).toBeNull();
      expect(rejected.leases.at(-1)?.generation).toBe(1);
      expect(
        rejected.steps.find((step) => step.logical_step_no === 1),
      ).toMatchObject({ repair_attempt: 0, state: "Prepared" });
      expect(
        providerRequests.filter((event) => event.bindingVariant === "B"),
      ).toEqual([]);
    },
    150_000,
  );

  it("rebuilds through portable Summary after a committed Native checkpoint's binding changes", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const nativeCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(nativeCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "ProviderNative",
      opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
    });
    const oldBindingFingerprint = nativeCheckpoint.bindingFingerprint;
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session).toEqual(beforeKill.session);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .catch((error: unknown) => {
        throw new Error(
          `AH19 gen1 daemon failed startup: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}`,
        );
      });

    await waitForPublic(
      async () =>
        providerRequests.some(
          (event) =>
            event.bindingVariant === "B" &&
            event.operationKind === "CompactionSummary",
        ),
      (seen) => seen,
      20_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 mismatch never requested portable Summary: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 2 &&
        snapshot.checkpoints.length === 2 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 portable rebase did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });

    const summaryCheckpoint = JSON.parse(
      recovered.checkpoints[1]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(summaryCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "Summary",
      fromEpoch: 1,
      toEpoch: 2,
      bindingFingerprint: null,
    });
    expect(summaryCheckpoint.summaryText).toContain(
      "Portable AH19 continuation B.",
    );
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    const mismatchedRequests = providerRequests.filter(
      (event) => event.bindingVariant === "B",
    );
    expect(mismatchedRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      mismatchedRequests
        .flatMap((event) => event.items)
        .some((item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`),
    ).toBe(false);
    expect(
      providerRequests.some(
        (event) =>
          event.operationKind === "CompactionSummary" &&
          event.bindingVariant === "B" &&
          event.items.some((item) => item._tag === "ControlResult"),
      ),
    ).toBe(true);
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(oldBindingFingerprint).toMatch(/^p16fp_[0-9a-f]{64}$/u);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
});
