import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach } from "vitest";
import {
  ClockLive,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "../../../../adapters/persistence-sqlite/src/index.js";
import {
  TransactionPort,
  WorkspaceRepository,
  WorktreeStore,
} from "../../../../packages/ports/src/index.js";
import { archiveProductionFixtureFailure } from "../../support/fixture-failure-evidence.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../support/production-fixture.js";
import {
  type FunctionalProject,
  functionalId,
  type PublicClient,
} from "../../support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../support/schema44-bootstrap.js";
import type {
  P4OutcomeProbe,
  readP9OutcomeSourceForProbe,
} from "./p9-oracle.js";

export interface SandboxCandidate {
  readonly kind: string;
  readonly candidateId: string;
  readonly sandboxHandleBindingDigest: string;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly capabilityRevision?: number;
  readonly profile?: string;
  readonly networkMode?: string;
  readonly providerRegistryRevision?: number;
  readonly providerRegistryDigest?: string;
}

export interface CandidateRead {
  readonly commonPreconditions: {
    readonly episodeBinding: Record<string, unknown>;
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: string;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: string;
  };
  readonly candidates: ReadonlyArray<SandboxCandidate>;
}

export interface WorkspaceDetailForSandbox {
  readonly sandboxPolicyCandidateRead?: CandidateRead;
  readonly sandboxPolicy?: {
    readonly kind?: string;
    readonly status?: string;
    readonly profile?: string;
    readonly providerId?: string;
    readonly providerVersion?: string;
    readonly networkMode?: string;
    readonly policyRevision?: number;
  };
}

export const child = resolve(
  "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
);
export const freshWorkspacePurpose =
  "V6 E fresh candidate after registry drift";
export const safeInitialShellCommand = "git status --short";
export const shellCommandForWorkspacePurpose = (input: {
  readonly context: string;
  readonly safeCommand: string;
}): string =>
  input.context.includes(freshWorkspacePurpose)
    ? "Get-Date"
    : input.safeCommand;
export const fixtures: ProductionFixture[] = [];
export const artifactFixtureCleanups: Array<() => void> = [];
export const fixtureDiagnostics = new Map<ProductionFixture, () => unknown>();

export const decodeToolObservation = (
  value: unknown,
): Record<string, unknown> => {
  if (typeof value === "string")
    return JSON.parse(value) as Record<string, unknown>;
  if (value instanceof Uint8Array)
    return JSON.parse(new TextDecoder().decode(value)) as Record<
      string,
      unknown
    >;
  throw new Error("durable tool observation is not encoded bytes or text");
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const durableSandboxRead = (
  databaseFile: string,
  executionId: string,
  invocationId?: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const data = {
      lease: db
        .prepare(
          "SELECT execution_id, generation FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId),
      actions: db
        .prepare(
          `SELECT logical_action_id, state, action_index, logical_step_no,
                  repair_attempt, disposition_json, result_ref, settlement_ref,
                  observation_source_ref, revision
             FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index`,
        )
        .all(executionId),
      step: db
        .prepare(
          `SELECT state, next_action_index, revision FROM agent_loop_steps
            WHERE execution_id = ? ORDER BY logical_step_no DESC LIMIT 1`,
        )
        .get(executionId),
      invocation: db
        .prepare(
          `SELECT invocation_id, effect_admission_state, recovery_binding_state,
                  recovery_binding_sha256, settled_at, settlement_kind,
                  observation_json
             FROM tool_invocations
            WHERE execution_id = ? AND (? IS NULL OR invocation_id = ?)
            ORDER BY intent_at DESC LIMIT 1`,
        )
        .get(executionId, invocationId ?? null, invocationId ?? null),
      decisions: db
        .prepare(
          `SELECT COUNT(*) AS count FROM sandbox_policy_decisions
            WHERE execution_id = ?`,
        )
        .get(executionId),
      decisionEvents: db
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?`,
        )
        .get(executionId),
    };
    db.exec("COMMIT");
    return data;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

export const p1OwnedDomainSnapshot = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = {
      decisions: db
        .prepare(
          `SELECT project_id, workspace_id, execution_id, episode_binding_json,
                  policy_revision, expected_execution_revision,
                  expected_policy_revision, profile_id, provider_id,
                  network_policy_json, policy_digest, permission_grant_id,
                  grant_permission_command_id, operator_config_revision,
                  operator_config_digest, decision_command_id
             FROM sandbox_policy_decisions WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      decisionEvents: db
        .prepare(
          `SELECT event_id, project_id, sequence, event_type, event_version,
                  occurred_at, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?
            ORDER BY sequence`,
        )
        .all(executionId),
      invocations: db
        .prepare(
          `SELECT invocation_id, tool_name, effect_admission_state,
                  recovery_binding_state, recovery_binding_sha256, settled_at,
                  settlement_kind, observation_json
             FROM tool_invocations WHERE execution_id = ?
            ORDER BY invocation_id`,
        )
        .all(executionId),
      recoveryBindings: db
        .prepare(
          `SELECT b.invocation_id, b.binding_version,
                  b.canonical_binding_json, b.binding_sha256
             FROM tool_invocation_recovery_bindings b
             JOIN tool_invocations i USING (invocation_id)
            WHERE i.execution_id = ? ORDER BY b.invocation_id`,
        )
        .all(executionId),
      executableApprovals: db
        .prepare(
          `SELECT approval_id, route_kind, execution_id, state, revision,
                  consumed_by
             FROM action_approvals
            WHERE execution_id = ? AND route_kind = 'Executable'
            ORDER BY approval_id`,
        )
        .all(executionId),
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, state, result_ref,
                  settlement_ref, disposition_json, observation_source_ref,
                  revision
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId),
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  revision, next_action_index, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

export const freshExecutionDiagnosticSnapshot = (
  databaseFile: string,
  executionId: string,
  messageId?: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = {
      execution: db
        .prepare(
          `SELECT execution_id, project_id, workspace_id,
                  episode_kind, episode_ref, episode_revision, settled_at,
                  settlement_kind, settlement_json
             FROM executions WHERE execution_id = ?`,
        )
        .get(executionId),
      agentExecutionState: db
        .prepare(
          `SELECT episode_json FROM agent_execution_state
            WHERE execution_id = ?`,
        )
        .get(executionId),
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  revision, next_action_index, settlement_json,
                  successor_json, next_step_reason
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId),
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, route_kind, action_kind,
                  input_hash, state, result_ref, settlement_ref,
                  disposition_json, observation_source_ref, revision
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId),
      executableApprovals: db
        .prepare(
          `SELECT approval_id, execution_id, state, revision, consumed_by,
                  logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, tool_invocation_id
             FROM action_approvals
            WHERE execution_id = ? AND route_kind = 'Executable'
            ORDER BY approval_id`,
        )
        .all(executionId),
      invocations: db
        .prepare(
          `SELECT invocation_id, tool_name, side_effect_semantics,
                  effect_admission_state, recovery_binding_state,
                  recovery_binding_sha256, settled_at, settlement_kind,
                  settlement_json, observation_json
             FROM tool_invocations WHERE execution_id = ?
            ORDER BY intent_at`,
        )
        .all(executionId),
      recoveryBindings: db
        .prepare(
          `SELECT b.invocation_id, b.binding_version,
                  b.canonical_binding_json, b.binding_sha256
             FROM tool_invocation_recovery_bindings b
             JOIN tool_invocations i USING (invocation_id)
            WHERE i.execution_id = ? ORDER BY b.invocation_id`,
        )
        .all(executionId),
      sandboxDecisions: db
        .prepare(
          `SELECT policy_revision, policy_digest, profile_id, provider_id,
                  network_policy_json, decision_command_id
             FROM sandbox_policy_decisions WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      providerUnavailableFacts: db
        .prepare(
          `SELECT policy_revision, policy_digest, profile_id, provider_id,
                  provider_version, failure_code, attention_fact_id
             FROM sandbox_provider_unavailable_facts WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      conversationResponseJob:
        messageId === undefined
          ? undefined
          : db
              .prepare(
                `SELECT message_id, state, revision, active_execution_id,
                        next_attempt_no, attention_reason,
                        response_execution_id
                   FROM conversation_response_jobs WHERE message_id = ?`,
              )
              .get(messageId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

export const insertProductionPrimaryWorktree = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly path: string;
}) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: input.databaseFile }),
    ClockLive,
  );
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const worktrees = yield* WorktreeStore;
        const workspaces = yield* WorkspaceRepository;
        const workspaceOption = yield* tx.transact(
          workspaces.findById(input.workspaceId as never),
        );
        if (workspaceOption._tag === "None")
          throw new Error("primary GitWorktree fixture Workspace is absent");
        const workspace = workspaceOption.value;
        const nextWorkspaceRevision = workspace.revision + 1;
        const nextBoundaryRevision = workspace.resourceBoundaryRevision + 1;
        const boundary = {
          basisResponsibilityRevision: workspace.responsibilityRevision,
          addresses: [{ _tag: "GitWorktree" as const, path: input.path }],
        };
        yield* tx.transact(
          Effect.gen(function* () {
            yield* workspaces.updateResourceBoundaryIfRevision(
              input.workspaceId as never,
              workspace.revision,
              boundary,
              nextBoundaryRevision as never,
              nextWorkspaceRevision as never,
            );
            yield* worktrees.insert({
              worktreeId: functionalId("wt") as never,
              projectId: input.projectId as never,
              workspaceId: input.workspaceId as never,
              address: { _tag: "GitWorktree", path: input.path },
              state: "Active",
              createdAt: new Date().toISOString(),
            });
          }),
        );
      }),
      app,
    ),
  );
};

export const policyPayload = (input: {
  readonly read: CandidateRead;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) => {
  const osCandidate = input.read.candidates.find(
    (candidate) =>
      candidate.kind === "OsEnforced" &&
      candidate.providerId === "windows-restricted-appcontainer-job" &&
      candidate.profile === "ReadOnly" &&
      candidate.networkMode === "Disabled",
  );
  if (
    osCandidate === undefined ||
    osCandidate.providerVersion === undefined ||
    osCandidate.capabilityRevision === undefined ||
    osCandidate.providerRegistryRevision === undefined ||
    osCandidate.providerRegistryDigest === undefined
  )
    throw new Error("exact Supported Windows candidate missing");
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    episodeBinding: input.read.commonPreconditions.episodeBinding,
    expectedEpisodeRevision:
      input.read.commonPreconditions.expectedEpisodeRevision,
    expectedPolicyRevision:
      input.read.commonPreconditions.latestCommittedPolicyRevision,
    expectedWorkspaceRevision: input.read.commonPreconditions.workspaceRevision,
    expectedResourceBoundaryRevision:
      input.read.commonPreconditions.resourceBoundaryRevision,
    expectedSandboxHandleBindingDigest: osCandidate.sandboxHandleBindingDigest,
    expectedAuthorityBundleRevision:
      input.read.commonPreconditions.authorityBundleRevision,
    expectedAuthorityBundleDigest:
      input.read.commonPreconditions.authorityBundleDigest,
    expectedOperatorConfigRevision:
      input.read.commonPreconditions.operatorConfigRevision,
    expectedOperatorConfigDigest:
      input.read.commonPreconditions.operatorConfigDigest,
    expectedProviderRegistryRevision: osCandidate.providerRegistryRevision,
    expectedProviderRegistryDigest: osCandidate.providerRegistryDigest,
    profile: osCandidate.profile,
    providerId: osCandidate.providerId,
    providerVersion: osCandidate.providerVersion,
    capabilityRevision: osCandidate.capabilityRevision,
    networkPolicy: {
      kind: "OsEnforced",
      policy: { version: 1, mode: "Disabled", destinations: [] },
    },
    decisionExpiresAt: input.expiresAt,
  };
};

export const operatorCommand = async (
  baseUrl: string,
  projectId: string,
  commandType: string,
  payload: unknown,
  commandId = functionalId("cmd"),
) => {
  const response = await fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer operator",
    },
    body: JSON.stringify({
      commandType,
      commandId,
      projectId,
      actor: "user:operator",
      issuedAt: new Date().toISOString(),
      payload,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${commandType} operator command failed: ${JSON.stringify(body)}`,
    );
  return body;
};

export const sandboxDecisionDebug = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT d.policy_revision, d.policy_digest, d.profile_id, d.provider_id,
                d.expires_at, d.episode_binding_json, c.result_json
           FROM sandbox_policy_decisions d
           JOIN commands c ON c.command_id = d.decision_command_id
          WHERE d.execution_id = ? ORDER BY d.policy_revision DESC LIMIT 1`,
      )
      .get(executionId);
  } finally {
    db.close();
  }
};

type P9ActionRowLike = NonNullable<
  ReturnType<typeof readP9OutcomeSourceForProbe>["action"]
>;
type P9StepRowLike = NonNullable<
  ReturnType<typeof readP9OutcomeSourceForProbe>["step"]
>;

export interface V6eScenarioState {
  readonly marker: string;
  readonly daemonEnvironment: Record<string, string>;
  readonly probeLines: Record<string, unknown>[];
  readonly executableProbeLines: Record<string, unknown>[];
  readonly preparationProbeLines: Record<string, unknown>[];
  readonly schedulerProbeLines: Record<string, unknown>[];
  readonly stdoutLines: string[];
  readonly scriptedProviderTrace: Array<Record<string, unknown>>;
  readonly diagnosticState: Record<string, unknown>;
  providerCalls: number;
  sourceFilename: string | undefined;
  fixture: ProductionFixture | undefined;
  client: PublicClient | undefined;
  project: FunctionalProject | undefined;
  executionId: string;
  firstInvocationId: string;
  initialRead: CandidateRead | undefined;
  oldPayload: ReturnType<typeof policyPayload> | undefined;
  firstSettled:
    | {
        readonly probe: P4OutcomeProbe;
        readonly source: ReturnType<typeof readP9OutcomeSourceForProbe>;
      }
    | undefined;
  firstActionState: P9ActionRowLike | undefined;
  firstStepState: P9StepRowLike | undefined;
  p9Terminal: boolean;
  providerCallsBeforeFreshRoot: number;
  freshProjectRootDirectory: string;
  freshProject: FunctionalProject | undefined;
  freshExecutionId: string;
  freshWork: {
    readonly workId?: string;
    readonly activeExecution?: { readonly executionId: string };
  } | null;
  freshPreDriftRead: CandidateRead | undefined;
  freshExecutableApproval: { approvalId: string; revision: number } | undefined;
  preDriftCandidate: SandboxCandidate | undefined;
  freshPreIntentState:
    | ReturnType<typeof freshExecutionDiagnosticSnapshot>
    | undefined;
  freshPreIntentApproval:
    | ReturnType<
        typeof freshExecutionDiagnosticSnapshot
      >["executableApprovals"][number]
    | undefined;
  p1GrantExpiresAt: string;
  freshOldPayload: ReturnType<typeof policyPayload> | undefined;
}

export const createV6eScenarioState = (): V6eScenarioState => {
  const marker = `V6-E-${crypto.randomUUID().slice(0, 8)}`;
  const daemonEnvironment: Record<string, string> = {};
  daemonEnvironment.ARBOR_AUTH_TOKENS =
    "local=user:local,operator=user:operator";
  daemonEnvironment.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION = "1";
  daemonEnvironment.ARBOR_TICK_INTERVAL_MS = "25";
  daemonEnvironment.ARBOR_AH_BOUNDARY = "AH7AfterToolIntentCommit";
  return {
    marker,
    daemonEnvironment,
    probeLines: [],
    executableProbeLines: [],
    preparationProbeLines: [],
    schedulerProbeLines: [],
    stdoutLines: [],
    scriptedProviderTrace: [],
    diagnosticState: { phase: "fixture-started", marker },
    providerCalls: 0,
    sourceFilename: undefined,
    fixture: undefined,
    client: undefined,
    project: undefined,
    executionId: "",
    firstInvocationId: "",
    initialRead: undefined,
    oldPayload: undefined,
    firstSettled: undefined,
    firstActionState: undefined,
    firstStepState: undefined,
    p9Terminal: false,
    providerCallsBeforeFreshRoot: 0,
    freshProjectRootDirectory: "",
    freshProject: undefined,
    freshExecutionId: "",
    freshWork: null,
    freshPreDriftRead: undefined,
    freshExecutableApproval: undefined,
    preDriftCandidate: undefined,
    freshPreIntentState: undefined,
    freshPreIntentApproval: undefined,
    p1GrantExpiresAt: "",
    freshOldPayload: undefined,
  };
};

afterEach(async ({ task }) => {
  const cleanupErrors: unknown[] = [];
  const failed = (task.result?.errors?.length ?? 0) > 0;
  for (const fixture of fixtures.splice(0)) {
    let stopError: unknown;
    try {
      await fixture.stop();
    } catch (error) {
      stopError = error;
    }
    const diagnostic = fixtureDiagnostics.get(fixture)?.();
    fixtureDiagnostics.delete(fixture);
    if (!fixture.daemonsExited()) {
      cleanupErrors.push(
        new Error(
          `V6 failure fixture cannot be archived while daemon remains active; database=${fixture.databaseFile}`,
          { cause: stopError },
        ),
      );
    } else if (failed || stopError !== undefined) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      if (resultDirectory === undefined) {
        cleanupErrors.push(
          new Error(
            `V6 failure evidence cannot be archived without ARBOR_TEST_RESULT_DIRECTORY; fixture=${fixture.directory}`,
            { cause: stopError },
          ),
        );
      } else {
        try {
          const archivedDirectory = archiveProductionFixtureFailure({
            fixture,
            resultDirectory,
            artifactPrefix: "sandbox-policy-v6-fresh-work",
            evidence: {
              testName: task.name,
              daemonErrors: fixture.daemonErrors,
              primaryDaemon: fixture.daemonProcessSnapshot(),
              providerCalls: fixture.providerCalls,
              diagnostics: diagnostic,
              cleanupError:
                stopError instanceof Error ? stopError.message : undefined,
            },
          });
          process.stdout.write(
            `[V6_FAILURE_ARTIFACT] ${JSON.stringify({ testName: task.name, archivedDirectory, databaseFile: resolve(archivedDirectory, basename(fixture.databaseFile)) })}\n`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } else {
      try {
        removeFunctionalFixtureDirectory(fixture.directory);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  for (const cleanup of artifactFixtureCleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      cleanupErrors,
      "sandbox V6 fixture and synthetic artifact cleanup failed",
      { cause: cleanupErrors[0] },
    );
});
