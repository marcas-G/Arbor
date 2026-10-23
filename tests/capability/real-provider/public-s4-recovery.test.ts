import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { ProductionFixture } from "../../functional/support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  functionalId,
  submitHumanMessage,
  waitForExecutableApproval,
  waitForPublic,
} from "../../functional/support/public-client.js";
import {
  armProviderResponseGate,
  type BoundProviderRequestEvidence,
  discoverProductionProviderConfig,
  finishRealProviderFixture,
  makeDeadlinePublicClient,
  type ProviderRequestEvidence,
  providerRequestsMatching,
  readProviderCaptures,
  repositoryBuildAssets,
  type StartedRealProviderFixture,
  startedProviderRequests,
  startRealProviderFixture,
  validateRealJourneyEvidenceRoot,
  waitForHeldProviderResponse,
  writeRealProviderEvidence,
} from "./public-real-journey-support.js";

const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S4";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const RESPONSE_GATE_DIRECTORY_ENV = "ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR";
const JOURNEY_BUDGET_MS = 20 * 60_000;

interface TranscriptEntry {
  readonly kind: string;
  readonly body?: string;
  readonly messageId?: string;
  readonly responseStatus?: {
    readonly state: string;
    readonly reason?: string;
    readonly revision?: number;
  };
}

interface TranscriptPage {
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

const explicitConfigPath =
  process.env.ARBOR_PUBLIC_S1_CONFIG?.trim() ||
  process.env.ARBOR_CONFIG?.trim();
const readiness = discoverProductionProviderConfig();
const evidenceRootReadiness = validateRealJourneyEvidenceRoot();
const missingAssetsAtLoad = repositoryBuildAssets();
const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : readiness.ready
      ? explicitConfigPath === undefined
        ? "set ARBOR_PUBLIC_S1_CONFIG to the authorized Provider config path"
        : readiness.config.path.toLowerCase() !==
            resolve(explicitConfigPath).toLowerCase()
          ? "resolved Provider config path does not match the explicit test path"
          : !evidenceRootReadiness.ready
            ? evidenceRootReadiness.reason
            : missingAssetsAtLoad.length > 0
              ? `build ${missingAssetsAtLoad.join(", ")} before qualification`
              : undefined
      : readiness.reason;

const activeFixtures: Array<ProductionFixture> = [];
afterEach(async () => {
  for (const fixture of activeFixtures.splice(0)) await fixture.stop();
});

const transcript = (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  workspaceId: string,
) =>
  client.view<TranscriptPage>("transcript", {
    workspaceId,
    conversationOnly: true,
    limit: 20,
  });

const waitWithinDeadline = async <A>(input: {
  readonly deadlineAt: number;
  readonly read: () => Promise<A>;
  readonly predicate: (value: A) => boolean;
  readonly label: string;
  readonly timeoutMs?: number;
}): Promise<A> => {
  const timeoutMs = Math.min(
    input.timeoutMs ?? 90_000,
    input.deadlineAt - Date.now(),
  );
  if (timeoutMs <= 0)
    throw new Error(`S4 deadline expired before ${input.label}`);
  try {
    return await waitForPublic(input.read, input.predicate, timeoutMs);
  } catch {
    throw new Error(
      `S4 public state did not reach ${input.label} before deadline`,
    );
  }
};

const entryKey = (entry: TranscriptEntry): string =>
  `${entry.kind}:${entry.messageId ?? entry.body ?? "missing-identity"}`;

const requestText = (request: Record<string, unknown>): string =>
  JSON.stringify(request);

const requireBoundProviderRequests = (
  evidence: ReadonlyArray<ProviderRequestEvidence>,
  context: string,
): ReadonlyArray<BoundProviderRequestEvidence> => {
  const invalid = evidence.find((candidate) => candidate._tag === "Invalid");
  if (invalid !== undefined) {
    throw new Error(
      `S4 ${context} Provider request evidence is ambiguous: ${invalid.reason}`,
    );
  }
  return evidence.filter(
    (candidate): candidate is BoundProviderRequestEvidence =>
      candidate._tag === "Bound",
  );
};

const isStrictlyInside = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
};

const assertPrivateFixturePaths = (fixture: ProductionFixture): void => {
  expect(isStrictlyInside(fixture.directory, fixture.databaseFile)).toBe(true);
  expect(isStrictlyInside(fixture.directory, fixture.workspaceDirectory)).toBe(
    true,
  );
  expect(isStrictlyInside("C:\\Arbor", fixture.databaseFile)).toBe(false);
  expect(isStrictlyInside("C:\\Arbor", fixture.workspaceDirectory)).toBe(false);
};

const sanitizeErrorKind = (error: unknown): string =>
  error instanceof Error ? error.name.slice(0, 80) : "UnknownFailure";

const withRealFixture = async <A>(input: {
  readonly caseId: string;
  readonly responseGate?: boolean;
  readonly body: (
    run: StartedRealProviderFixture,
    deadlineAt: number,
  ) => Promise<A>;
}): Promise<A> => {
  if (!readiness.ready)
    throw new Error("REAL NOT QUALIFIED: provider config is unavailable");
  if (!evidenceRootReadiness.ready) {
    throw new Error("REAL NOT QUALIFIED: private evidence root is unavailable");
  }
  const run = await startRealProviderFixture({
    config: readiness.config,
    evidenceRoot: evidenceRootReadiness.path,
    journeyId: input.caseId,
    ...(input.responseGate === true ? { responseGate: true } : {}),
  });
  activeFixtures.push(run.fixture);
  const deadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  let status: "PASS" | "FAIL" = "FAIL";
  let result: A | undefined;
  let caught: unknown;
  let scenario: Readonly<Record<string, unknown>> = {};
  let finalized:
    | Awaited<ReturnType<typeof finishRealProviderFixture>>
    | undefined;
  try {
    result = await input.body(run, deadlineAt);
    if (typeof result === "object" && result !== null) {
      scenario = result as Readonly<Record<string, unknown>>;
    }
    status = "PASS";
  } catch (error) {
    caught = error;
    scenario = { ...scenario, failureKind: sanitizeErrorKind(error) };
  } finally {
    finalized = await finishRealProviderFixture(run, status);
    writeRealProviderEvidence({
      run,
      journeyId: input.caseId,
      config: readiness.config,
      status: finalized.status,
      state: scenario,
      ...(finalized.error === undefined
        ? caught === undefined
          ? {}
          : { error: sanitizeErrorKind(caught) }
        : { error: finalized.error }),
    });
    activeFixtures.splice(activeFixtures.indexOf(run.fixture), 1);
  }
  if (caught !== undefined) throw caught;
  if (finalized?.status !== "PASS") {
    throw new Error(
      "REAL public S4 fixture cleanup did not complete successfully",
    );
  }
  return result as A;
};

const publicWorkDetail = async (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  projectId: string,
  workspaceId: string,
  workId: string,
) =>
  client.view<{
    workId: string;
    workspaceId: string;
    lifecycle: string;
    revision: number;
  }>("work-detail", { projectId, workspaceId, workId });

interface ApprovalBinding {
  readonly approvalId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly toolInvocationId: string;
  readonly approvalState: string;
  readonly approvalRevision: number;
  readonly stepState: string;
  readonly actionState: string;
  readonly invocationCount: number;
}

const readPendingApprovalBinding = (
  databaseFile: string,
  approvalId: string,
): ApprovalBinding => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT a.approval_id, a.execution_id, e.episode_ref AS work_id,
                a.logical_step_no, a.repair_attempt, a.action_index,
                a.logical_action_id, a.call_ref, a.tool_invocation_id,
                a.state AS approval_state, a.revision AS approval_revision,
                s.state AS step_state, x.state AS action_state,
                (SELECT COUNT(*) FROM tool_invocations i
                  WHERE i.invocation_id = a.tool_invocation_id) AS invocation_count
           FROM action_approvals a
           JOIN executions e ON e.execution_id = a.execution_id
           JOIN agent_loop_steps s ON s.execution_id = a.execution_id
             AND s.logical_step_no = a.logical_step_no
             AND s.repair_attempt = a.repair_attempt
           JOIN agent_loop_step_actions x ON x.execution_id = a.execution_id
             AND x.logical_step_no = a.logical_step_no
             AND x.repair_attempt = a.repair_attempt
             AND x.action_index = a.action_index
             AND x.logical_action_id = a.logical_action_id
          WHERE a.approval_id = ? AND e.episode_kind = 'WorkEpisode'
            AND a.route_kind = 'Executable'
            AND a.binding_proven = 1`,
      )
      .get(approvalId) as
      | {
          approval_id: string;
          execution_id: string;
          work_id: string;
          logical_step_no: number;
          repair_attempt: number;
          action_index: number;
          logical_action_id: string;
          call_ref: string;
          tool_invocation_id: string;
          approval_state: string;
          approval_revision: number;
          step_state: string;
          action_state: string;
          invocation_count: number;
        }
      | undefined;
    if (row === undefined)
      throw new Error("public approval has no exact durable binding");
    const binding: ApprovalBinding = {
      approvalId: row.approval_id,
      executionId: row.execution_id,
      workId: row.work_id,
      logicalStepNo: row.logical_step_no,
      repairAttempt: row.repair_attempt,
      actionIndex: row.action_index,
      logicalActionId: row.logical_action_id,
      callRef: row.call_ref,
      toolInvocationId: row.tool_invocation_id,
      approvalState: row.approval_state,
      approvalRevision: row.approval_revision,
      stepState: row.step_state,
      actionState: row.action_state,
      invocationCount: row.invocation_count,
    };
    if (
      binding.approvalState !== "Pending" ||
      binding.approvalRevision !== 0 ||
      binding.invocationCount !== 0
    ) {
      throw new Error(
        "Executable approval was not pending before effect admission",
      );
    }
    return binding;
  } finally {
    database.close();
  }
};

interface FailClosedConversationSnapshot {
  readonly job: {
    readonly messageId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly state: string;
    readonly activeExecutionId: string | null;
    readonly nextAttemptNo: number;
    readonly nextEligibleAt: string | null;
    readonly attentionReason: string | null;
    readonly lastFailureClass: string | null;
    readonly hasResponseBody: boolean;
    readonly revision: number;
  };
  readonly humanMessage: {
    readonly messageId: string;
    readonly state: string;
    readonly claimedByExecutionId: string | null;
    readonly settledAt: string | null;
  };
  readonly execution: {
    readonly executionId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly episodeKind: string;
    readonly episodeRef: string;
    readonly episodeRevision: number;
    readonly sessionId: string;
    readonly settlementKind: string | null;
    readonly settledAt: string | null;
  };
  readonly step: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly providerTurnId: string;
    readonly manifestId: string | null;
    readonly state: string;
    readonly decoderVersion: string | null;
    readonly hasSuccessor: boolean;
  };
  readonly providerTurn: {
    readonly providerTurnId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly manifestId: string;
    readonly settledAt: string | null;
    readonly finishReason: string | null;
  };
  readonly manifest: {
    readonly manifestId: string;
    readonly providerTurnId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly hasPortableRequest: boolean;
  } | null;
  readonly providerAttempt: {
    readonly attemptNo: number;
    readonly outcome: string;
    readonly providerErrorKind: string | null;
    readonly retrySafety: string | null;
    readonly retryDecision: string | null;
    readonly retryReason: string | null;
    readonly successEvidenceVersion: string | null;
    readonly observation: Readonly<Record<string, unknown>> | null;
  };
  readonly recoveryDecision: {
    readonly causeTag: string;
    readonly retrySafety: string;
    readonly retryDecision: string;
    readonly retryReason: string;
  } | null;
  readonly lease: {
    readonly generation: number;
    readonly workerIncarnationId: string;
  } | null;
  readonly consumerOffsets: ReadonlyArray<{
    readonly consumerId: string;
    readonly lastSequence: number;
  }>;
  readonly maxProjectEventSequence: number | null;
  readonly workspaceSchedulerTimerCount: number;
}

interface ConversationLeaseBinding {
  readonly executionId: string;
  readonly generation: number;
  readonly workerIncarnationId: string;
}

const readConversationLeaseBinding = (input: {
  readonly databaseFile: string;
  readonly messageId: string;
}): ConversationLeaseBinding => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT jobs.active_execution_id AS execution_id,
                leases.generation, leases.worker_incarnation_id
           FROM conversation_response_jobs AS jobs
           JOIN execution_leases AS leases
             ON leases.execution_id = jobs.active_execution_id
          WHERE jobs.message_id = ?`,
      )
      .get(input.messageId) as
      | {
          execution_id: string;
          generation: number;
          worker_incarnation_id: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error(
        "pending ConversationResponse has no active Execution lease",
      );
    }
    return {
      executionId: row.execution_id,
      generation: row.generation,
      workerIncarnationId: row.worker_incarnation_id,
    };
  } finally {
    database.close();
  }
};

const readFailClosedConversationSnapshot = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
}): FailClosedConversationSnapshot => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  database.exec("BEGIN");
  try {
    const jobRow = database
      .prepare(
        `SELECT message_id, project_id, root_workspace_id, state,
                active_execution_id, next_attempt_no, next_eligible_at,
                attention_reason, last_failure_class,
                response_body IS NOT NULL AS has_response_body, revision
           FROM conversation_response_jobs WHERE message_id = ?`,
      )
      .get(input.messageId) as
      | {
          message_id: string;
          project_id: string;
          root_workspace_id: string;
          state: string;
          active_execution_id: string | null;
          next_attempt_no: number;
          next_eligible_at: string | null;
          attention_reason: string | null;
          last_failure_class: string | null;
          has_response_body: number;
          revision: number;
        }
      | undefined;
    if (jobRow === undefined || jobRow.active_execution_id === null) {
      throw new Error(
        "public NeedsAttention message has no active Execution binding",
      );
    }
    const messageRow = database
      .prepare(
        `SELECT message_id, project_id, root_workspace_id, state,
                claimed_by_execution_id, settled_at
           FROM human_messages WHERE message_id = ?`,
      )
      .get(input.messageId) as
      | {
          message_id: string;
          project_id: string;
          root_workspace_id: string;
          state: string;
          claimed_by_execution_id: string | null;
          settled_at: string | null;
        }
      | undefined;
    const executionRow = database
      .prepare(
        `SELECT execution_id, project_id, workspace_id, episode_kind,
                episode_ref, episode_revision, session_id, settlement_kind,
                settled_at
           FROM executions WHERE execution_id = ?`,
      )
      .get(jobRow.active_execution_id) as
      | {
          execution_id: string;
          project_id: string;
          workspace_id: string;
          episode_kind: string;
          episode_ref: string;
          episode_revision: number;
          session_id: string;
          settlement_kind: string | null;
          settled_at: string | null;
        }
      | undefined;
    if (messageRow === undefined || executionRow === undefined) {
      throw new Error("NeedsAttention message or its Execution disappeared");
    }
    const stepRow = database
      .prepare(
        `SELECT logical_step_no, repair_attempt, provider_turn_id, manifest_id,
                state, decoder_version, successor_json IS NOT NULL AS has_successor
           FROM agent_loop_steps
          WHERE execution_id = ?
          ORDER BY logical_step_no DESC, repair_attempt DESC LIMIT 1`,
      )
      .get(executionRow.execution_id) as
      | {
          logical_step_no: number;
          repair_attempt: number;
          provider_turn_id: string | null;
          manifest_id: string | null;
          state: string;
          decoder_version: string | null;
          has_successor: number;
        }
      | undefined;
    if (
      stepRow?.provider_turn_id === undefined ||
      stepRow.provider_turn_id === null
    ) {
      throw new Error(
        "failed ConversationResponse Execution lacks its ProviderTurn",
      );
    }
    const providerTurnRow = database
      .prepare(
        `SELECT provider_turn_id, execution_id, session_id, manifest_id,
                settled_at, finish_reason
           FROM provider_turns WHERE provider_turn_id = ?`,
      )
      .get(stepRow.provider_turn_id) as
      | {
          provider_turn_id: string;
          execution_id: string;
          session_id: string;
          manifest_id: string;
          settled_at: string | null;
          finish_reason: string | null;
        }
      | undefined;
    if (providerTurnRow === undefined) {
      throw new Error("failed ConversationResponse ProviderTurn disappeared");
    }
    const manifestRow = database
      .prepare(
        `SELECT manifest_id, provider_turn_id, execution_id, session_id,
                portable_request_json IS NOT NULL AS has_portable_request
           FROM model_context_manifests WHERE manifest_id = ?`,
      )
      .get(providerTurnRow.manifest_id) as
      | {
          manifest_id: string;
          provider_turn_id: string;
          execution_id: string;
          session_id: string;
          has_portable_request: number;
        }
      | undefined;
    const attemptRow = database
      .prepare(
        `SELECT attempt_no, outcome, provider_error_kind, retry_safety,
                retry_decision, retry_reason, success_evidence_version,
                observation_json
           FROM provider_attempts WHERE provider_turn_id = ?
           ORDER BY attempt_no DESC LIMIT 1`,
      )
      .get(providerTurnRow.provider_turn_id) as
      | {
          attempt_no: number;
          outcome: string;
          provider_error_kind: string | null;
          retry_safety: string | null;
          retry_decision: string | null;
          retry_reason: string | null;
          success_evidence_version: string | null;
          observation_json: string | null;
        }
      | undefined;
    if (attemptRow === undefined) {
      throw new Error(
        "failed ConversationResponse ProviderAttempt disappeared",
      );
    }
    const recoveryRow = database
      .prepare(
        `SELECT cause_tag, retry_safety, retry_decision, retry_reason
           FROM provider_recovery_decisions WHERE provider_turn_id = ?
           ORDER BY sequence_no DESC LIMIT 1`,
      )
      .get(providerTurnRow.provider_turn_id) as
      | {
          cause_tag: string;
          retry_safety: string;
          retry_decision: string;
          retry_reason: string;
        }
      | undefined;
    const leaseRow = database
      .prepare(
        `SELECT generation, worker_incarnation_id FROM execution_leases
          WHERE execution_id = ?`,
      )
      .get(executionRow.execution_id) as
      | { generation: number; worker_incarnation_id: string }
      | undefined;
    const consumerOffsets = database
      .prepare(
        `SELECT consumer_id, last_sequence FROM consumer_offsets
          WHERE project_id = ? ORDER BY consumer_id`,
      )
      .all(input.projectId) as Array<{
      consumer_id: string;
      last_sequence: number;
    }>;
    const maxEventSequence = database
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM domain_events WHERE project_id = ?",
      )
      .get(input.projectId) as { sequence: number | null };
    const timerCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM scheduler_timers WHERE workspace_id = ?",
      )
      .get(input.workspaceId) as { count: number };

    if (
      jobRow.project_id !== input.projectId ||
      jobRow.root_workspace_id !== input.workspaceId ||
      messageRow.project_id !== input.projectId ||
      messageRow.root_workspace_id !== input.workspaceId ||
      executionRow.project_id !== input.projectId ||
      executionRow.workspace_id !== input.workspaceId ||
      executionRow.episode_ref !== input.messageId ||
      executionRow.session_id !== input.sessionId
    ) {
      throw new Error(
        "ConversationResponse recovery binding escaped its public scope",
      );
    }
    return {
      job: {
        messageId: jobRow.message_id,
        projectId: jobRow.project_id,
        workspaceId: jobRow.root_workspace_id,
        state: jobRow.state,
        activeExecutionId: jobRow.active_execution_id,
        nextAttemptNo: jobRow.next_attempt_no,
        nextEligibleAt: jobRow.next_eligible_at,
        attentionReason: jobRow.attention_reason,
        lastFailureClass: jobRow.last_failure_class,
        hasResponseBody: jobRow.has_response_body === 1,
        revision: jobRow.revision,
      },
      humanMessage: {
        messageId: messageRow.message_id,
        state: messageRow.state,
        claimedByExecutionId: messageRow.claimed_by_execution_id,
        settledAt: messageRow.settled_at,
      },
      execution: {
        executionId: executionRow.execution_id,
        projectId: executionRow.project_id,
        workspaceId: executionRow.workspace_id,
        episodeKind: executionRow.episode_kind,
        episodeRef: executionRow.episode_ref,
        episodeRevision: executionRow.episode_revision,
        sessionId: executionRow.session_id,
        settlementKind: executionRow.settlement_kind,
        settledAt: executionRow.settled_at,
      },
      step: {
        logicalStepNo: stepRow.logical_step_no,
        repairAttempt: stepRow.repair_attempt,
        providerTurnId: stepRow.provider_turn_id,
        manifestId: stepRow.manifest_id,
        state: stepRow.state,
        decoderVersion: stepRow.decoder_version,
        hasSuccessor: stepRow.has_successor === 1,
      },
      providerTurn: {
        providerTurnId: providerTurnRow.provider_turn_id,
        executionId: providerTurnRow.execution_id,
        sessionId: providerTurnRow.session_id,
        manifestId: providerTurnRow.manifest_id,
        settledAt: providerTurnRow.settled_at,
        finishReason: providerTurnRow.finish_reason,
      },
      manifest:
        manifestRow === undefined
          ? null
          : {
              manifestId: manifestRow.manifest_id,
              providerTurnId: manifestRow.provider_turn_id,
              executionId: manifestRow.execution_id,
              sessionId: manifestRow.session_id,
              hasPortableRequest: manifestRow.has_portable_request === 1,
            },
      providerAttempt: {
        attemptNo: attemptRow.attempt_no,
        outcome: attemptRow.outcome,
        providerErrorKind: attemptRow.provider_error_kind,
        retrySafety: attemptRow.retry_safety,
        retryDecision: attemptRow.retry_decision,
        retryReason: attemptRow.retry_reason,
        successEvidenceVersion: attemptRow.success_evidence_version,
        observation:
          attemptRow.observation_json === null
            ? null
            : (JSON.parse(attemptRow.observation_json) as Record<
                string,
                unknown
              >),
      },
      recoveryDecision:
        recoveryRow === undefined
          ? null
          : {
              causeTag: recoveryRow.cause_tag,
              retrySafety: recoveryRow.retry_safety,
              retryDecision: recoveryRow.retry_decision,
              retryReason: recoveryRow.retry_reason,
            },
      lease:
        leaseRow === undefined
          ? null
          : {
              generation: leaseRow.generation,
              workerIncarnationId: leaseRow.worker_incarnation_id,
            },
      consumerOffsets: consumerOffsets.map((row) => ({
        consumerId: row.consumer_id,
        lastSequence: row.last_sequence,
      })),
      maxProjectEventSequence: maxEventSequence.sequence,
      workspaceSchedulerTimerCount: timerCount.count,
    };
  } finally {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
};

const publicStateOracle = "PublicCommandsAndViewsAndWorkspaceArtifact" as const;

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL S4-A: unknown Provider outcome after hard restart is surfaced as NeedsAttention without replay"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    await withRealFixture({
      caseId: "s4-a-conversation-hard-restart",
      responseGate: true,
      body: async (run, deadlineAt) => {
        assertPrivateFixturePaths(run.fixture);
        const client = makeDeadlinePublicClient(run.fixture, deadlineAt);
        const marker = `S4A-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
        const recallCode = `RECALL-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
        const project = await createFunctionalProject(
          client,
          run.fixture.workspaceDirectory,
          `Real public S4 conversation ${marker}`,
          { resourceSelection: "ConversationOnly" },
        );
        const firstPrompt = `For this conversation, remember the exact code ${recallCode}. Reply with a short confirmation that includes it. Marker: ${marker}.`;
        await submitHumanMessage(client, project, firstPrompt);
        const firstTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "first assistant turn",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.some(
              (entry) =>
                entry.kind === "AssistantConversationTurn" &&
                entry.body?.includes(recallCode),
            ),
        });
        const firstAssistant = firstTranscript.entries.find(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body?.includes(recallCode),
        );
        if (firstAssistant === undefined)
          throw new Error("first public answer is missing");

        const capturesAfterCompletedTurn = readProviderCaptures(
          run.captureFile,
        );
        const completedTurnEvidence = requireBoundProviderRequests(
          providerRequestsMatching(capturesAfterCompletedTurn, (request) =>
            requestText(request).includes(firstPrompt),
          ),
          "completed turn",
        );
        if (completedTurnEvidence.length === 0) {
          throw new Error(
            "real Provider request for the completed turn was not captured",
          );
        }
        const completedTurnSuccess = completedTurnEvidence.find((evidence) =>
          evidence.bodyEvents.some(
            (capture) =>
              capture.event === "response-complete" &&
              capture.status !== undefined &&
              capture.status >= 200 &&
              capture.status < 300,
          ),
        );
        if (completedTurnSuccess === undefined) {
          throw new Error(
            "completed public turn has no captured successful Provider response",
          );
        }
        const firstTurnRequestIdsBeforeRestart = completedTurnEvidence
          .map((evidence) => evidence.requestId)
          .sort();
        const secondPrompt = `What exact code did I ask you to remember? Return it unchanged. Marker: ${marker}.`;
        const startsBeforePendingTurn = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).length;
        armProviderResponseGate(run, { requiredMessageText: secondPrompt });
        await submitHumanMessage(client, project, secondPrompt);
        const held = await waitForHeldProviderResponse(run, {
          afterSequence: startsBeforePendingTurn,
          deadlineAt,
        });
        expect(held.status).toBeGreaterThanOrEqual(200);
        expect(held.status).toBeLessThan(300);
        if (held.request === undefined) {
          throw new Error("held Provider response lacks its request body");
        }
        expect(requestText(held.request)).toContain(secondPrompt);
        const pendingTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "second user turn pending without an assistant answer",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.filter(
              (entry) => entry.kind === "HumanConversationTurn",
            ).length === 2 &&
            page.entries.filter(
              (entry) => entry.kind === "AssistantConversationTurn",
            ).length === 1 &&
            page.entries.some(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt,
            ),
        });
        const pendingIdentities = pendingTranscript.entries.map(entryKey);
        expect(new Set(pendingIdentities).size).toBe(pendingIdentities.length);

        const oldDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        const oldLease = readConversationLeaseBinding({
          databaseFile: run.fixture.databaseFile,
          messageId:
            pendingTranscript.entries.find(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt,
            )?.messageId ?? "",
        });
        await run.fixture.crash();
        expect(run.fixture.daemonsExited()).toBe(true);
        expect(run.fixture.daemonProcessSnapshot()?.alive).toBe(false);
        await run.fixture.restart({
          daemonEnvironment: {
            [CAPTURE_FILE_ENV]: run.captureFile,
            [RESPONSE_GATE_DIRECTORY_ENV]: "",
          },
        });
        const newDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        expect(newDaemonPid).toBeDefined();
        expect(newDaemonPid).not.toBe(oldDaemonPid);

        const failClosedTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "pending second turn surfaced as NeedsAttention",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.filter(
              (entry) => entry.kind === "HumanConversationTurn",
            ).length === 2 &&
            page.entries.filter(
              (entry) => entry.kind === "AssistantConversationTurn",
            ).length === 1 &&
            page.entries.some(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt &&
                entry.responseStatus?.state === "NeedsAttention" &&
                entry.responseStatus.reason === "UnknownFailure",
            ),
        });
        const finalIdentities = failClosedTranscript.entries.map(entryKey);
        expect(new Set(finalIdentities).size).toBe(finalIdentities.length);
        for (const pendingEntry of pendingTranscript.entries) {
          const recovered = failClosedTranscript.entries.filter(
            (entry) => entryKey(entry) === entryKey(pendingEntry),
          );
          expect(recovered).toHaveLength(1);
          expect(recovered[0]).toMatchObject({
            kind: pendingEntry.kind,
            body: pendingEntry.body,
            messageId: pendingEntry.messageId,
          });
        }
        expect(
          failClosedTranscript.entries.filter(
            (entry) =>
              entry.kind === "AssistantConversationTurn" &&
              entry.body === firstAssistant.body,
          ),
        ).toHaveLength(1);
        expect(
          failClosedTranscript.entries.filter(
            (entry) => entry.kind === "AssistantConversationTurn",
          ),
        ).toEqual([firstAssistant]);
        const pendingHuman = failClosedTranscript.entries.find(
          (entry) =>
            entry.kind === "HumanConversationTurn" &&
            entry.body === secondPrompt,
        );
        expect(pendingHuman?.responseStatus).toMatchObject({
          state: "NeedsAttention",
          reason: "UnknownFailure",
        });
        const failClosedSnapshot = readFailClosedConversationSnapshot({
          databaseFile: run.fixture.databaseFile,
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          sessionId: project.rootSessionId,
          messageId: pendingHuman?.messageId ?? "",
        });
        expect(failClosedSnapshot.job).toMatchObject({
          state: "NeedsAttention",
          attentionReason: "UnknownFailure",
          lastFailureClass: "UnknownFailure",
          hasResponseBody: false,
        });
        expect(failClosedSnapshot.job.activeExecutionId).toBe(
          failClosedSnapshot.execution.executionId,
        );
        expect(failClosedSnapshot.humanMessage).toMatchObject({
          messageId: pendingHuman?.messageId,
          state: "Pending",
          claimedByExecutionId: null,
          settledAt: null,
        });
        expect(failClosedSnapshot.execution).toMatchObject({
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          episodeKind: "ConversationResponseEpisode",
          episodeRef: pendingHuman?.messageId,
          sessionId: project.rootSessionId,
          settlementKind: "Failed",
        });
        expect(failClosedSnapshot.execution.settledAt).toBeTruthy();
        expect(failClosedSnapshot.step).toMatchObject({
          logicalStepNo: 0,
          repairAttempt: 0,
          state: "SettlementProposed",
          manifestId: null,
          decoderVersion: null,
          hasSuccessor: false,
        });
        expect(failClosedSnapshot.providerTurn).toMatchObject({
          executionId: failClosedSnapshot.execution.executionId,
          sessionId: project.rootSessionId,
          finishReason: "Failed",
        });
        expect(failClosedSnapshot.providerTurn.settledAt).toBeTruthy();
        expect(failClosedSnapshot.manifest).toMatchObject({
          manifestId: failClosedSnapshot.providerTurn.manifestId,
          providerTurnId: failClosedSnapshot.providerTurn.providerTurnId,
          executionId: failClosedSnapshot.execution.executionId,
          sessionId: project.rootSessionId,
          hasPortableRequest: true,
        });
        expect(failClosedSnapshot.providerAttempt).toMatchObject({
          attemptNo: 0,
          outcome: "TerminalFailure",
          retrySafety: "UnsafeReplay",
          retryDecision: "Stop",
          successEvidenceVersion: null,
          observation: {
            responseStarted: false,
            canonicalEventEmitted: false,
            consumerVisibleOutput: false,
            toolCallProposed: false,
            continuationAvailable: false,
            externalEffectPossible: true,
          },
        });
        expect(failClosedSnapshot.recoveryDecision).toMatchObject({
          causeTag: "ProcessLost",
          retrySafety: "UnsafeReplay",
          retryDecision: "Stop",
        });
        expect(failClosedSnapshot.lease).toMatchObject({
          generation: oldLease.generation + 1,
        });
        expect(failClosedSnapshot.execution.executionId).toBe(
          oldLease.executionId,
        );
        expect(failClosedSnapshot.lease?.workerIncarnationId).not.toBe(
          oldLease.workerIncarnationId,
        );
        expect(failClosedSnapshot.workspaceSchedulerTimerCount).toBe(0);
        expect(failClosedSnapshot.consumerOffsets.length).toBeGreaterThan(0);
        expect(failClosedSnapshot.maxProjectEventSequence).not.toBeNull();
        expect(
          failClosedSnapshot.consumerOffsets.every(
            (offset) =>
              offset.lastSequence ===
              failClosedSnapshot.maxProjectEventSequence,
          ),
        ).toBe(true);

        const recoveryQuietWindowMs = Math.min(1_500, deadlineAt - Date.now());
        if (recoveryQuietWindowMs <= 0) {
          throw new Error(
            "S4 deadline expired before bounded recovery stability window",
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, recoveryQuietWindowMs),
        );
        const stableTranscript = await transcript(
          client,
          project.rootWorkspaceId,
        );
        expect(stableTranscript.entries).toEqual(failClosedTranscript.entries);
        expect(
          readFailClosedConversationSnapshot({
            databaseFile: run.fixture.databaseFile,
            projectId: project.projectId,
            workspaceId: project.rootWorkspaceId,
            sessionId: project.rootSessionId,
            messageId: pendingHuman?.messageId ?? "",
          }),
        ).toEqual(failClosedSnapshot);

        const finalCaptures = readProviderCaptures(run.captureFile);
        const firstTurnEvidenceAfterRestart = requireBoundProviderRequests(
          providerRequestsMatching(
            finalCaptures,
            (request) =>
              requestText(request).includes(firstPrompt) &&
              !requestText(request).includes(secondPrompt),
          ),
          "completed turn after restart",
        );
        expect(
          firstTurnEvidenceAfterRestart
            .map((evidence) => evidence.requestId)
            .sort(),
        ).toEqual(firstTurnRequestIdsBeforeRestart);
        const recoveredPendingEvidence = requireBoundProviderRequests(
          providerRequestsMatching(finalCaptures, (request) =>
            requestText(request).includes(secondPrompt),
          ),
          "pending turn after restart",
        );
        expect(recoveredPendingEvidence).toHaveLength(1);
        expect(recoveredPendingEvidence[0]?.requestStart.processId).toBe(
          oldDaemonPid,
        );
        expect(recoveredPendingEvidence[0]?.requestId).toBe(held.requestId);
        expect(
          recoveredPendingEvidence[0]?.bodyEvents.map(
            (capture) => capture.event,
          ),
        ).toContain("response-held");
        expect(
          recoveredPendingEvidence[0]?.bodyEvents.map(
            (capture) => capture.event,
          ),
        ).not.toContain("response-released");
        expect(
          recoveredPendingEvidence[0]?.bodyEvents.some(
            (capture) => capture.event === "response-complete",
          ),
        ).toBe(true);
        expect(
          finalCaptures.some(
            (capture) =>
              capture.event === "request-start" &&
              capture.processId === newDaemonPid,
          ),
        ).toBe(false);
        expect(
          finalCaptures.some(
            (capture) =>
              capture.event === "response-released" &&
              capture.requestId === held.requestId,
          ),
        ).toBe(false);
        expect(run.fixture.providerCalls).toHaveLength(0);
        expect(run.fixture.daemonErrors).toEqual([]);

        return {
          oracleLayer: publicStateOracle,
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          sessionId: project.rootSessionId,
          workspaceMode: "ConversationOnly",
          firstUserPromptMarker: marker,
          completedTurnRequestIds: firstTurnRequestIdsBeforeRestart,
          heldPendingRequestId: held.requestId,
          pendingTranscriptIdentities: pendingIdentities,
          recoveredTranscriptIdentities: finalIdentities,
          oldDaemonPid,
          newDaemonPid,
          recoveryQuietWindowMs,
          failClosedPendingRequestIds: recoveredPendingEvidence
            .map((evidence) => evidence.requestId)
            .sort(),
          completedTurnProviderRequestCount:
            firstTurnRequestIdsBeforeRestart.length,
          pendingTurnReplayObservedAfterRestart: false,
          failClosedState: failClosedSnapshot,
          fixtureDatabase: run.fixture.databaseFile,
          captureFile: run.captureFile,
        };
      },
    });
  },
  JOURNEY_BUDGET_MS + 2 * 60_000,
);

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL S4-B: the same Work resumes after an Executable Approval survives hard restart"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    await withRealFixture({
      caseId: "s4-b-work-approval-hard-restart",
      body: async (run, deadlineAt) => {
        assertPrivateFixturePaths(run.fixture);
        const client = makeDeadlinePublicClient(run.fixture, deadlineAt);
        const marker = `S4B-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
        const fileName = `s4-approval-${marker.toLowerCase()}.txt`;
        const fileContent = `S4-APPROVED-ARTIFACT:${marker}`;
        const resourceCatalog = await client.projectResources();
        const availableProfiles = resourceCatalog.profiles.filter(
          (profile) => profile.available,
        );
        expect(availableProfiles).toHaveLength(1);
        expect(availableProfiles[0]).toMatchObject({
          resourceProfileRef: "project-root",
          available: true,
        });
        const project = await createFunctionalProject(
          client,
          run.fixture.workspaceDirectory,
          `Real public S4 approval ${marker}`,
          { resourceSelection: "Profile" },
        );
        await client.command(project.projectId, "GrantPermission", {
          permissionGrantId: functionalId("pgr"),
          issuer: "user:local",
          subject: {
            _tag: "WorkspaceAgent",
            workspaceId: project.rootWorkspaceId,
          },
          capability: "fs:write",
          target: project.rootWorkspaceId,
          expiresAt: new Date(deadlineAt).toISOString(),
        });
        const admittedWork = await admitRootWorkThroughPublicConversation(
          client,
          project,
          marker,
          `Please complete ${marker}: create only ${fileName} in this workspace with the exact single-line content ${fileContent}, then read it back. Ask for any required execution approval before writing.`,
        );
        const workId = admittedWork.workId;
        const workBefore = await waitWithinDeadline({
          deadlineAt,
          label: "approved Work detail",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) =>
            value.workId === workId && value.lifecycle === "Open",
        });
        const approval = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(90_000, deadlineAt - Date.now()),
        );
        const bindingBefore = readPendingApprovalBinding(
          run.fixture.databaseFile,
          approval.approvalId,
        );
        expect(bindingBefore.workId).toBe(workId);
        expect(bindingBefore.approvalId).toBe(approval.approvalId);
        expect(bindingBefore.approvalRevision).toBe(approval.revision);
        expect(bindingBefore.executionId).toBeTruthy();
        expect(bindingBefore.toolInvocationId).toBeTruthy();
        expect(existsSync(join(run.fixture.workspaceDirectory, fileName))).toBe(
          false,
        );

        const oldDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        await run.fixture.crash();
        expect(run.fixture.daemonsExited()).toBe(true);
        await run.fixture.restart({
          daemonEnvironment: { [CAPTURE_FILE_ENV]: run.captureFile },
        });
        const newDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        expect(newDaemonPid).toBeDefined();
        expect(newDaemonPid).not.toBe(oldDaemonPid);

        const resumedWork = await waitWithinDeadline({
          deadlineAt,
          label: "same Work after restart",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) =>
            value.workId === workId && value.lifecycle === "Open",
        });
        expect(resumedWork.workspaceId).toBe(project.rootWorkspaceId);
        expect(resumedWork.revision).toBe(workBefore.revision);
        const resumedApproval = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(90_000, deadlineAt - Date.now()),
        );
        expect(resumedApproval).toEqual(approval);
        const bindingAfter = readPendingApprovalBinding(
          run.fixture.databaseFile,
          approval.approvalId,
        );
        expect(bindingAfter).toEqual(bindingBefore);
        expect(existsSync(join(run.fixture.workspaceDirectory, fileName))).toBe(
          false,
        );
        const startsWhileApprovalWaits = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).length;
        const quietWindowMs = Math.min(1_500, deadlineAt - Date.now());
        if (quietWindowMs <= 0) {
          throw new Error(
            "S4 deadline expired before bounded approval idle window",
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, quietWindowMs),
        );
        const stillPending = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(15_000, deadlineAt - Date.now()),
        );
        expect(stillPending).toEqual(approval);
        expect(
          startedProviderRequests(readProviderCaptures(run.captureFile)),
        ).toHaveLength(startsWhileApprovalWaits);
        const providerRequestIdsBeforeApproval = new Set(
          requireBoundProviderRequests(
            providerRequestsMatching(
              readProviderCaptures(run.captureFile),
              (request) => requestText(request).includes(marker),
            ),
            "pending approval wait",
          ).map((evidence) => evidence.requestId),
        );

        await client.command(project.projectId, "ResolveExecutableApproval", {
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision: "Approve",
          reason: `approve the exact ${marker} workspace file action after restart`,
        });
        const artifactPath = join(run.fixture.workspaceDirectory, fileName);
        await waitWithinDeadline({
          deadlineAt,
          label: "approved real workspace artifact",
          read: async () => readFileSync(artifactPath, "utf8"),
          predicate: (content) => content === fileContent,
        });
        const continuedWork = await waitWithinDeadline({
          deadlineAt,
          label: "same Work remains publicly inspectable after approval",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) => value.workId === workId,
        });
        expect(continuedWork.workspaceId).toBe(project.rootWorkspaceId);
        const postApprovalEvidence = requireBoundProviderRequests(
          providerRequestsMatching(
            readProviderCaptures(run.captureFile),
            (request) => requestText(request).includes(marker),
          ),
          "post-approval Work",
        );
        const postApprovalRequests = postApprovalEvidence.filter(
          (evidence) =>
            evidence.requestStart.processId === newDaemonPid &&
            !providerRequestIdsBeforeApproval.has(evidence.requestId),
        );
        expect(postApprovalRequests.length).toBeGreaterThan(0);
        expect(run.fixture.providerCalls).toHaveLength(0);
        expect(run.fixture.daemonErrors).toEqual([]);

        return {
          oracleLayer: publicStateOracle,
          approvalBindingOracle: "ReadOnlySQLiteAuxiliary",
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          resourceProfileRef: availableProfiles[0]?.resourceProfileRef,
          workId,
          workRevisionBeforeRestart: workBefore.revision,
          workRevisionAfterRestartBeforeApproval: resumedWork.revision,
          executableApprovalId: approval.approvalId,
          executionId: bindingBefore.executionId,
          toolInvocationId: bindingBefore.toolInvocationId,
          logicalStepNo: bindingBefore.logicalStepNo,
          repairAttempt: bindingBefore.repairAttempt,
          actionIndex: bindingBefore.actionIndex,
          logicalActionId: bindingBefore.logicalActionId,
          callRef: bindingBefore.callRef,
          sameApprovalAndActionBindingSurvivedRestart: true,
          approvalWaitQuietWindowMs: quietWindowMs,
          oldDaemonPid,
          newDaemonPid,
          artifactPath,
          artifactSha256: createHash("sha256")
            .update(fileContent)
            .digest("hex"),
          postApprovalProviderRequests: postApprovalRequests.length,
          fixtureDatabase: run.fixture.databaseFile,
          captureFile: run.captureFile,
        };
      },
    });
  },
  JOURNEY_BUDGET_MS + 2 * 60_000,
);
