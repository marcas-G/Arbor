import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../support/lease-qualification.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../support/public-client.js";

interface BoundaryProbe {
  readonly tag: "AH19_CONVERSATION_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
}

interface MessageRow {
  readonly message_id: string;
  readonly body_ref: string;
  readonly created_at: string;
  readonly state: string;
  readonly claimed_by_execution_id: string | null;
  readonly response_body: string | null;
  readonly attempt_no: number;
}

interface OwnerRow {
  readonly root_workspace_id: string;
  readonly context_epoch: number;
  readonly covered_through_created_at: string | null;
  readonly covered_through_message_id: string | null;
  readonly checkpoint_kind: string | null;
  readonly checkpoint_ref: string | null;
  readonly source_manifest_json: string | null;
  readonly producer_provider_turn_id: string | null;
}

interface ResponseJobRow {
  readonly state: string;
  readonly revision: number;
  readonly active_execution_id: string | null;
  readonly next_attempt_no: number;
  readonly response_body: string | null;
  readonly response_execution_id: string | null;
  readonly attention_reason: string | null;
  readonly last_failure_class: string | null;
  readonly last_failure_fingerprint: string | null;
}

const fixtures: ProductionFixture[] = [];
const childEntry = resolve(
  "tests/functional/support/ah19-conversation-checkpoint-crash-child.mjs",
);

const withDatabase = <A>(
  databaseFile: string,
  read: (db: DatabaseSync) => A,
): A => {
  const db = new DatabaseSync(databaseFile);
  try {
    return read(db);
  } finally {
    db.close();
  }
};

const messagesOf = (databaseFile: string): MessageRow[] =>
  withDatabase(
    databaseFile,
    (db) =>
      db
        .prepare(
          `SELECT message_id, body_ref, created_at, state, claimed_by_execution_id,
                response_body, attempt_no
           FROM human_messages ORDER BY created_at, message_id`,
        )
        .all() as unknown as MessageRow[],
  );

const ownerOf = (
  databaseFile: string,
  workspaceId: string,
): OwnerRow | undefined =>
  withDatabase(
    databaseFile,
    (db) =>
      db
        .prepare(
          `SELECT root_workspace_id, context_epoch, covered_through_created_at,
                covered_through_message_id, checkpoint_kind, checkpoint_ref,
                source_manifest_json, producer_provider_turn_id
           FROM conversation_checkpoint_owners WHERE root_workspace_id = ?`,
        )
        .get(workspaceId) as OwnerRow | undefined,
  );

const executionIdForMessage = (
  databaseFile: string,
  messageId: string,
): string | undefined =>
  withDatabase(
    databaseFile,
    (db) =>
      (
        db
          .prepare(
            `SELECT execution_id FROM executions
            WHERE episode_kind = 'ConversationResponseEpisode'
              AND episode_ref = ? ORDER BY admitted_at DESC LIMIT 1`,
          )
          .get(messageId) as { execution_id: string } | undefined
      )?.execution_id,
  );

const leaseForExecution = (
  databaseFile: string,
  executionId: string,
): { readonly generation: number; readonly expires_at: string } | undefined =>
  withDatabase(
    databaseFile,
    (db) =>
      db
        .prepare(
          "SELECT generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as
        | { readonly generation: number; readonly expires_at: string }
        | undefined,
  );

const responseJobForMessage = (
  databaseFile: string,
  messageId: string,
): ResponseJobRow | undefined =>
  withDatabase(
    databaseFile,
    (db) =>
      db
        .prepare(
          `SELECT state, revision, active_execution_id, next_attempt_no,
                response_body, response_execution_id, attention_reason,
                last_failure_class, last_failure_fingerprint
           FROM conversation_response_jobs WHERE message_id = ?`,
        )
        .get(messageId) as ResponseJobRow | undefined,
  );

const recoveryDiagnostics = (databaseFile: string, executionId: string) =>
  withDatabase(databaseFile, (db) => ({
    attempts: db
      .prepare(
        `SELECT message_id, attempt_no, execution_id, settled_at, settlement_kind,
              retry_decision_json FROM conversation_attempts WHERE execution_id = ?`,
      )
      .all(executionId),
    execution: db
      .prepare(
        `SELECT episode_kind, episode_ref, episode_revision, settlement_kind,
              settlement_json, settled_at FROM executions WHERE execution_id = ?`,
      )
      .get(executionId),
    steps: db
      .prepare(
        `SELECT logical_step_no, repair_attempt, provider_turn_id, state, revision,
              next_action_index, successor_json FROM agent_loop_steps
        WHERE execution_id = ? ORDER BY logical_step_no, repair_attempt`,
      )
      .all(executionId),
    providerTurns: (
      db
        .prepare(
          `SELECT t.provider_turn_id, t.context_epoch, t.output_contract_ref,
              t.settled_at, t.finish_reason, a.attempt_no, a.outcome,
              a.provider_error_kind, a.retry_decision, a.retry_reason,
              a.transport_metadata_json, a.observation_json,
              m.manifest_json, m.portable_request_json
         FROM provider_turns t LEFT JOIN provider_attempts a
           ON a.provider_turn_id = t.provider_turn_id
         LEFT JOIN model_context_manifests m
           ON m.provider_turn_id = t.provider_turn_id
        WHERE t.execution_id = ? ORDER BY t.created_at, a.attempt_no`,
        )
        .all(executionId) as Array<{
        readonly provider_turn_id: string;
        readonly context_epoch: number;
        readonly output_contract_ref: string;
        readonly finish_reason: string | null;
        readonly provider_error_kind: string | null;
        readonly retry_decision: string | null;
        readonly retry_reason: string | null;
        readonly transport_metadata_json: string | null;
        readonly portable_request_json: string | null;
      }>
    ).map((row) => {
      let requestItems: unknown;
      try {
        const request = JSON.parse(row.portable_request_json ?? "{}") as {
          readonly inputItems?: ReadonlyArray<{
            readonly _tag?: string;
            readonly role?: string;
            readonly text?: string;
            readonly summaryText?: string;
          }>;
        };
        requestItems = request.inputItems?.map((item) => ({
          tag: item._tag,
          role: item.role,
          text: (item.text ?? item.summaryText)?.slice(0, 120),
        }));
      } catch {
        requestItems = "invalid";
      }
      return {
        providerTurnId: row.provider_turn_id,
        epoch: row.context_epoch,
        contract: row.output_contract_ref,
        finishReason: row.finish_reason,
        providerErrorKind: row.provider_error_kind,
        retryDecision: row.retry_decision,
        retryReason: row.retry_reason,
        transportMetadata: row.transport_metadata_json,
        requestItems,
      };
    }),
  }));

describe("AH19 Conversation owner checkpoint process crash recovery", () => {
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.stop();
    }
  }, 120_000);

  it.each([
    "AH19BeforeConversationCheckpointOwnerCommit",
    "AH19AfterConversationCheckpointOwnerCommit",
  ] as const)(
    "recovers one same-episode owner checkpoint at %s",
    async (boundaryName) => {
      const marker = randomUUID().slice(0, 8);
      const priorText = `AH19_PRIOR_${marker}`;
      const currentText = `AH19_CURRENT_${marker}`;
      const summaryText = `AH19_PORTABLE_SUMMARY_${marker}`;
      const probes: BoundaryProbe[] = [];
      const daemonOutput: string[] = [];
      let overflowSent = false;
      const fixtureOptions: Parameters<typeof startProductionFixture>[0] = {
        firstDaemonEntry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_CONVERSATION_BOUNDARY: boundaryName,
        },
        onDaemonStdout: (line) => {
          daemonOutput.push(line);
          try {
            const candidate = JSON.parse(line) as BoundaryProbe;
            if (candidate.tag === "AH19_CONVERSATION_PROBE") {
              probes.push(candidate);
            }
          } catch {
            // Non-probe daemon diagnostics are retained by the fixture.
          }
        },
        reply: (call) => {
          const text = call.messages
            .map((message) => message.content ?? "")
            .join("\n");
          if (text.includes("Produce a compact continuation summary")) {
            return { _tag: "Text", text: summaryText };
          }
          if (text.includes(currentText) && !overflowSent) {
            overflowSent = true;
            return { _tag: "ContextLimit" };
          }
          return {
            _tag: "Text",
            text: text.includes(priorText)
              ? `AH19_PRIOR_ANSWER_${marker}`
              : `AH19_CURRENT_ANSWER_${marker}`,
          };
        },
      };
      const fixture = await startProductionFixture(fixtureOptions).catch(
        (error: unknown) => {
          throw new Error(
            `Conversation crash fixture failed to start: ${error instanceof Error ? error.message : String(error)}; stdout=${daemonOutput.join(" | ")}`,
          );
        },
      );
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH19 Conversation owner crash ${marker}`,
      );

      await submitHumanMessage(client, project, priorText);
      const priorMessage = await waitForPublic(
        async () => {
          const rows = messagesOf(fixture.databaseFile);
          const message = rows[0];
          return message === undefined
            ? undefined
            : {
                message,
                job: responseJobForMessage(
                  fixture.databaseFile,
                  message.message_id,
                ),
              };
        },
        (value) => value?.job?.state === "Answered",
        60_000,
      )
        .then((value) => value?.message)
        .catch((error: unknown) => {
          throw new Error(
            `prior Conversation turn did not answer: ${error instanceof Error ? error.message : String(error)}; job=${JSON.stringify(messagesOf(fixture.databaseFile))}; responseJob=${JSON.stringify(responseJobForMessage(fixture.databaseFile, messagesOf(fixture.databaseFile)[0]?.message_id ?? ""))}; probes=${JSON.stringify(probes)}; providerCalls=${JSON.stringify(fixture.providerCalls.map((call) => call.messages))}; daemon=${fixture.daemonErrors.join(" | ")}; stdout=${daemonOutput.join(" | ")}`,
          );
        });
      if (priorMessage === undefined)
        throw new Error("prior HumanMessage is missing");

      await submitHumanMessage(client, project, currentText);
      const submittedCurrent = await waitForPublic(
        async () => {
          const message = messagesOf(fixture.databaseFile)[1];
          return message === undefined
            ? undefined
            : {
                message,
                job: responseJobForMessage(
                  fixture.databaseFile,
                  message.message_id,
                ),
              };
        },
        (value) =>
          value?.job?.state === "Running" &&
          value.job.active_execution_id !== null,
        60_000,
      );
      if (submittedCurrent === undefined) {
        throw new Error("current response job was not admitted");
      }
      const currentMessage = submittedCurrent.message;
      if (currentMessage === undefined)
        throw new Error("current HumanMessage is missing");
      const legacyCurrentBefore = {
        state: currentMessage.state,
        claimed_by_execution_id: currentMessage.claimed_by_execution_id,
        response_body: currentMessage.response_body,
        attempt_no: currentMessage.attempt_no,
      };
      const currentExecutionId = executionIdForMessage(
        fixture.databaseFile,
        currentMessage.message_id,
      );
      if (currentExecutionId === undefined) {
        throw new Error("current response execution is missing");
      }

      const probe = await waitForPublic(
        async () =>
          probes.find((candidate) => candidate.boundary === boundaryName),
        (value) => value !== undefined,
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `Conversation owner boundary was not reached: ${error instanceof Error ? error.message : String(error)}; probes=${JSON.stringify(probes)}; calls=${JSON.stringify(fixture.providerCalls.map((call) => call.messages.map((message) => message.content)))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (probe === undefined)
        throw new Error("Conversation checkpoint probe is absent");
      expect(probe.executionId).toBe(currentExecutionId);
      expect(probe.providerTurnId).toContain("_compact_");
      expect(fixture.daemonProcessSnapshot()?.alive).toBe(true);

      const ownerAtKill = ownerOf(
        fixture.databaseFile,
        project.rootWorkspaceId,
      );
      expect(ownerAtKill).toBeDefined();
      expect(ownerAtKill?.context_epoch).toBe(
        boundaryName === "AH19BeforeConversationCheckpointOwnerCommit" ? 0 : 1,
      );
      if (boundaryName === "AH19AfterConversationCheckpointOwnerCommit") {
        expect(ownerAtKill).toMatchObject({
          checkpoint_kind: "Summary",
          covered_through_message_id: priorMessage.message_id,
        });
      }
      const jobAtKill = responseJobForMessage(
        fixture.databaseFile,
        currentMessage.message_id,
      );
      expect(jobAtKill).toMatchObject({
        state: "Running",
        active_execution_id: currentExecutionId,
      });

      await fixture.crash();
      const lease = leaseForExecution(fixture.databaseFile, currentExecutionId);
      if (lease === undefined)
        throw new Error("current response lease is missing");
      await expireExecutionLeaseAfterOwnerExitForQualification({
        databaseFile: fixture.databaseFile,
        executionId: currentExecutionId,
        expected: {
          generation: lease.generation,
          expiresAt: lease.expires_at,
        },
        daemon: {
          crash: fixture.crash,
          snapshot: fixture.daemonProcessSnapshot,
        },
      });
      await fixture.restart();

      const answeredCurrent = await waitForPublic(
        async () =>
          responseJobForMessage(
            fixture.databaseFile,
            currentMessage.message_id,
          ),
        (job) => job?.state === "Answered" || job?.state === "NeedsAttention",
        90_000,
      ).catch((error: unknown) => {
        throw new Error(
          `same ConversationResponseEpisode did not answer after restart: ${error instanceof Error ? error.message : String(error)}; owner=${JSON.stringify(ownerOf(fixture.databaseFile, project.rootWorkspaceId))}; job=${JSON.stringify(responseJobForMessage(fixture.databaseFile, currentMessage.message_id))}; calls=${JSON.stringify(fixture.providerCalls.map((call) => call.messages.map((message) => message.content)))}; daemon=${fixture.daemonErrors.join(" | ")}; stdout=${daemonOutput.join(" | ")}`,
        );
      });
      if (
        answeredCurrent === undefined ||
        answeredCurrent.state !== "Answered"
      ) {
        throw new Error(
          `conversation recovery entered Attention: job=${JSON.stringify(answeredCurrent)}; evidence=${JSON.stringify(recoveryDiagnostics(fixture.databaseFile, currentExecutionId))}; owner=${JSON.stringify(ownerOf(fixture.databaseFile, project.rootWorkspaceId))}; calls=${JSON.stringify(fixture.providerCalls.map((call) => call.messages.map((message) => ((message.content ?? "").includes("AH19_") ? (message.content ?? "").slice(-80) : (message.content ?? "").slice(0, 40)))))}; stdout=${daemonOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      expect(answeredCurrent).toMatchObject({
        state: "Answered",
        active_execution_id: null,
        response_execution_id: currentExecutionId,
        response_body: expect.stringContaining(`AH19_CURRENT_ANSWER_${marker}`),
        next_attempt_no: 1,
      });
      const legacyCurrentAfter = messagesOf(fixture.databaseFile)[1];
      expect(legacyCurrentAfter).toMatchObject({
        body_ref: currentMessage.body_ref,
        created_at: currentMessage.created_at,
        state: legacyCurrentBefore.state,
        claimed_by_execution_id: legacyCurrentBefore.claimed_by_execution_id,
        response_body: legacyCurrentBefore.response_body,
        attempt_no: legacyCurrentBefore.attempt_no,
      });
      const finalOwner = ownerOf(fixture.databaseFile, project.rootWorkspaceId);
      expect(finalOwner).toMatchObject({
        context_epoch: 1,
        checkpoint_kind: "Summary",
        covered_through_message_id: priorMessage.message_id,
        producer_provider_turn_id: probe.providerTurnId,
      });
      const sourceManifest = JSON.parse(
        finalOwner?.source_manifest_json ?? "{}",
      ) as {
        currentMessageId?: string;
        currentRunningJobRevision?: number;
        currentRunningAttemptNo?: number;
        currentAdmissionJobRevision?: number;
        coveredSources?: ReadonlyArray<{
          messageId: string;
          answeredJobRevision: number;
          admissionJobRevision: number;
          responseExecutionId: string;
          attemptNo: number;
          responseBodySha256: string;
        }>;
      };
      expect(sourceManifest).toMatchObject({
        currentMessageId: currentMessage.message_id,
        currentRunningJobRevision: 1,
        currentRunningAttemptNo: 0,
        currentAdmissionJobRevision: 0,
      });
      expect(
        sourceManifest.coveredSources?.map((source) => source.messageId),
      ).toEqual([priorMessage.message_id]);
      expect(sourceManifest.coveredSources?.[0]).toMatchObject({
        answeredJobRevision: 2,
        admissionJobRevision: 0,
        responseExecutionId: expect.any(String),
        attemptNo: 0,
        responseBodySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      const summaryCalls = fixture.providerCalls.filter((call) =>
        call.messages.some((message) =>
          (message.content ?? "").includes(
            "Produce a compact continuation summary",
          ),
        ),
      );
      expect(summaryCalls).toHaveLength(1);
      expect(
        summaryCalls[0]?.messages.some((message) =>
          (message.content ?? "").includes(currentText),
        ),
      ).toBe(false);
      const currentInputCalls = fixture.providerCalls.filter((call) =>
        call.messages.some((message) =>
          (message.content ?? "").includes(currentText),
        ),
      );
      expect(currentInputCalls).toHaveLength(2);
      const replacementInput = currentInputCalls.at(-1);
      const replacementInputText = replacementInput?.messages
        .map((message) => message.content ?? "")
        .join("\n");
      expect((replacementInputText ?? "").split(currentText).length - 1).toBe(
        1,
      );
      const sessionCheckpointCount = withDatabase(
        fixture.databaseFile,
        (db) =>
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM session_entries
            WHERE session_id = ? AND item_type = 'CheckpointReference'`,
            )
            .get(project.rootSessionId) as { count: number },
      ).count;
      expect(sessionCheckpointCount).toBe(0);
    },
    180_000,
  );
});
