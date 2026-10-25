import type { ExecutionId, ProviderTurnId, Sha256 } from "@arbor/domain";
import {
  type ReadmissionGateIntegrityFailure,
  type ReadmissionSourceKind,
  type ReadmissionTargetMismatch,
  sha256Hex,
  type TerminalProviderFailureKind,
  type TerminalProviderFailureSource,
  TransactionScope,
  WorkReadmissionGateStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface TargetRow {
  readonly work_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly revision: number;
}

interface ExecutionRow {
  readonly execution_id: string;
  readonly project_id: string;
  readonly binding_kind: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly admitted_at: string;
  readonly episode_kind: string | null;
  readonly episode_ref: string | null;
  readonly episode_revision: number | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly settled_at: string | null;
  readonly stop_requested_at: string | null;
  readonly episode_json: string | null;
}

interface TerminalStepRow {
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly provider_turn_id: string;
  readonly manifest_id: string | null;
  readonly state: string;
  readonly settlement_json: string | null;
}

interface TerminalTurnRow {
  readonly provider_turn_id: string;
  readonly execution_id: string;
  readonly session_id: string;
  readonly manifest_id: string | null;
  readonly output_contract_ref: string;
  readonly settled_at: string | null;
  readonly finish_reason: string | null;
  readonly manifest_execution_id: string | null;
  readonly manifest_session_id: string | null;
  readonly manifest_provider_turn_id: string | null;
  readonly compiled_request_hash: string | null;
  readonly manifest_json: string | null;
}

interface TerminalAttemptRow {
  readonly attempt_no: number;
  readonly settled_at: string | null;
  readonly outcome: string;
  readonly provider_error_kind: string | null;
  readonly failure_taxonomy_version: string;
  readonly retry_decision: string | null;
}

interface ExecutionScopeRow {
  readonly execution_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
}

interface FactRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly failure_code: string;
  readonly fact_kind: "DeliverReplayFact" | "AssignWorkBindingFact";
  readonly detail_id: string;
}

interface EventRow {
  readonly event_id: string;
  readonly project_id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_ref: string;
  readonly correlation_ref: string | null;
  readonly payload_json: string;
}

interface Episode {
  readonly _tag: string;
  readonly workId?: string;
  readonly targetWorkRevision?: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const decodeJson = (value: string): unknown => JSON.parse(value) as unknown;

const exactEpisode = (
  row: ExecutionRow,
):
  | { readonly episode: Episode; readonly reason?: never }
  | {
      readonly episode?: never;
      readonly reason: "EpisodeMalformed" | "EpisodeVersionUnsupported";
    } => {
  if (row.episode_json === null) {
    return { reason: "EpisodeMalformed" };
  }
  let parsed: unknown;
  try {
    parsed = decodeJson(row.episode_json);
  } catch {
    return { reason: "EpisodeMalformed" };
  }
  const value = record(parsed);
  if (value === null || typeof value._tag !== "string") {
    return { reason: "EpisodeMalformed" };
  }
  if (
    ![
      "WorkEpisode",
      "ConversationResponseEpisode",
      "InboxEpisode",
      "DecisionEpisode",
      "ExecutionBoundEpisode",
      "LegacyAmbiguousEpisode",
    ].includes(value._tag)
  ) {
    return { reason: "EpisodeVersionUnsupported" };
  }
  if (value._tag === "WorkEpisode") {
    if (
      typeof value.workId !== "string" ||
      typeof value.targetWorkRevision !== "number" ||
      !Number.isSafeInteger(value.targetWorkRevision) ||
      value.targetWorkRevision < 0 ||
      row.binding_kind !== "workspace" ||
      row.episode_kind !== "WorkEpisode" ||
      row.episode_ref !== value.workId ||
      Number(row.episode_revision) !== value.targetWorkRevision
    ) {
      return { reason: "EpisodeMalformed" };
    }
  } else if (value._tag === "ConversationResponseEpisode") {
    if (
      typeof value.messageId !== "string" ||
      typeof value.responseJobRevision !== "number" ||
      !Number.isSafeInteger(value.responseJobRevision) ||
      row.binding_kind !== "workspace" ||
      row.episode_kind !== value._tag ||
      row.episode_ref !== value.messageId ||
      Number(row.episode_revision) !== value.responseJobRevision
    )
      return { reason: "EpisodeMalformed" };
  } else if (value._tag === "InboxEpisode") {
    if (
      typeof value.entryKey !== "string" ||
      typeof value.inputKind !== "string" ||
      row.binding_kind !== "workspace" ||
      row.episode_kind !== value._tag ||
      row.episode_ref !== value.entryKey ||
      Number(row.episode_revision) !== 0
    )
      return { reason: "EpisodeMalformed" };
  } else if (value._tag === "DecisionEpisode") {
    if (
      typeof value.decisionId !== "string" ||
      value.decisionKind !== "SelectCurrentWork" ||
      typeof value.requestRevision !== "number" ||
      !Number.isSafeInteger(value.requestRevision) ||
      row.binding_kind !== "workspace" ||
      row.episode_kind !== value._tag ||
      row.episode_ref !== value.decisionId ||
      Number(row.episode_revision) !== value.requestRevision
    )
      return { reason: "EpisodeMalformed" };
  } else if (value._tag === "ExecutionBoundEpisode") {
    if (
      typeof value.executionId !== "string" ||
      value.executionId !== row.execution_id ||
      row.binding_kind !== "execution_bound"
    )
      return { reason: "EpisodeMalformed" };
  } else {
    return { reason: "EpisodeMalformed" };
  }
  return { episode: value as unknown as Episode };
};

const runtimeSafetyStop = (row: ExecutionRow): boolean => {
  if (row.settled_at === null || row.settlement_kind !== "Interrupted")
    return false;
  let value: Record<string, unknown> | null;
  try {
    value = record(decodeJson(row.settlement_json ?? ""));
  } catch {
    throw new Error("SettlementMalformed");
  }
  if (value === null || value._tag !== "Interrupted") {
    throw new Error("SettlementMalformed");
  }
  const result = record(value.result);
  if (result?._tag === "StopRequested") {
    if (row.stop_requested_at === null) {
      throw new Error("SettlementMalformed");
    }
    return false;
  }
  if (
    result?._tag !== "ControlledInterruption" ||
    typeof result.reason !== "string"
  ) {
    throw new Error("SettlementMalformed");
  }
  return result.reason === "RuntimeSafetyStop";
};

const outcomeUnknown = (row: ExecutionRow): boolean => {
  if (row.settled_at === null || row.settlement_kind !== "OutcomeUnknown") {
    return false;
  }
  let value: Record<string, unknown> | null;
  try {
    value = record(decodeJson(row.settlement_json ?? ""));
  } catch {
    throw new Error("SettlementMalformed");
  }
  const reconciliation = record(value?.reconciliation);
  const valid =
    value?._tag === "OutcomeUnknown" &&
    reconciliation?._tag === "ReconciliationRequired" &&
    Array.isArray(reconciliation.invocationRefs) &&
    reconciliation.invocationRefs.length > 0 &&
    reconciliation.invocationRefs.every(
      (ref) => typeof ref === "string" && ref.length > 0,
    );
  if (!valid) throw new Error("SettlementMalformed");
  return true;
};

const terminalProviderFailureKind = (
  row: ExecutionRow,
): TerminalProviderFailureKind | null => {
  if (row.settled_at === null || row.settlement_kind !== "Failed") return null;
  let value: Record<string, unknown> | null;
  try {
    value = record(decodeJson(row.settlement_json ?? ""));
  } catch {
    throw new Error("SettlementMalformed");
  }
  const failure = record(value?.failure);
  if (
    value?._tag !== "Failed" ||
    failure?._tag !== "ExecutionFailure" ||
    typeof failure.reason !== "string"
  ) {
    throw new Error("SettlementMalformed");
  }
  const prefix = "ProviderFailure:";
  if (!failure.reason.startsWith(prefix)) return null;
  const kind = failure.reason.slice(prefix.length);
  return kind === "AuthenticationFailed" ||
    kind === "RequestRejected" ||
    kind === "ProtocolViolation"
    ? kind
    : null;
};

const unknownProviderFailureSettlement = (row: ExecutionRow): boolean => {
  if (row.settled_at === null || row.settlement_kind !== "Failed") return false;
  let value: Record<string, unknown> | null;
  try {
    value = record(decodeJson(row.settlement_json ?? ""));
  } catch {
    throw new Error("SettlementMalformed");
  }
  const failure = record(value?.failure);
  return (
    value?._tag === "Failed" &&
    failure?._tag === "ExecutionFailure" &&
    failure.reason === "ProviderFailure:UnknownProviderFailure"
  );
};

const isCanonicalUtc = (value: string): boolean => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
};

const isFailureCode = (kind: FactRow["fact_kind"], code: string): boolean =>
  kind === "DeliverReplayFact"
    ? [
        "LegacyMessageMissingEvent",
        "LegacyEventMissingMessage",
        "LegacyMessageBindingMismatch",
        "LegacyInboxConflict",
        "PriorReceiptDecodeMismatch",
        "PriorReceiptResultMismatch",
        "RejectedReceiptEffectConflict",
        "PriorReceiptEffectConflict",
      ].includes(code)
    : [
        "LegacyUnbound",
        "MissingBinding",
        "DuplicateBinding",
        "MalformedBinding",
        "RefMismatch",
        "AuthorityMismatch",
        "ForeignTarget",
        "PlacementMismatch",
        "SourceActionMismatch",
        "ReceiptMismatch",
        "WorkMismatch",
        "ProvenanceMismatch",
        "EventMismatch",
        "CommitLifecycleMismatch",
      ].includes(code);

export const WorkReadmissionGateStoreLive: Layer.Layer<
  WorkReadmissionGateStore,
  never,
  SqlClient
> = Layer.effect(
  WorkReadmissionGateStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(repositoryFailure("WorkReadmissionGateStore", "query")),
      );

    const hasBlockingSource: WorkReadmissionGateStore["Service"]["hasBlockingSource"] =
      (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const targetRows = yield* run(
            sql.unsafe<TargetRow>(
              "SELECT work_id, project_id, workspace_id, revision FROM works WHERE work_id = ?",
              [input.workId],
            ),
          );
          const target = targetRows[0];
          const mismatch = (
            reasonCode: ReadmissionTargetMismatch["reasonCode"],
          ): ReadmissionTargetMismatch => ({
            _tag: "ReadmissionTargetMismatch",
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            workId: input.workId,
            requestedWorkRevision: input.workRevision,
            reasonCode,
          });
          if (target === undefined) {
            return yield* Effect.fail(mismatch("ReadmissionTargetMissing"));
          }
          if (
            target.project_id !== input.projectId ||
            target.workspace_id !== input.workspaceId
          ) {
            return yield* Effect.fail(
              mismatch("ReadmissionTargetScopeMismatch"),
            );
          }
          if (Number(target.revision) !== input.workRevision) {
            return yield* Effect.fail(
              mismatch("ReadmissionTargetRevisionMismatch"),
            );
          }

          const makeIntegrity = (
            reasonCode: ReadmissionGateIntegrityFailure["reasonCode"],
            executionId?: ExecutionId,
            sourceKind?: ReadmissionSourceKind,
          ): ReadmissionGateIntegrityFailure => ({
            _tag: "ReadmissionGateIntegrityFailure",
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            workId: input.workId,
            requestedWorkRevision: input.workRevision,
            ...(executionId === undefined ? {} : { executionId }),
            ...(sourceKind === undefined ? {} : { sourceKind }),
            reasonCode,
          });

          const executions = yield* run(
            sql.unsafe<ExecutionRow>(
              `SELECT e.execution_id, e.project_id, e.binding_kind,
                      e.workspace_id, e.session_id, e.admitted_at,
                      e.episode_kind, e.episode_ref,
                      e.episode_revision, e.settlement_kind,
                      e.settlement_json, e.settled_at, e.stop_requested_at,
                      s.episode_json
                 FROM executions AS e
                 LEFT JOIN agent_execution_state AS s
                   ON s.execution_id = e.execution_id
                WHERE e.project_id = ? OR e.execution_id IN (
                  SELECT execution_id FROM deliver_replay_attention_facts
                   WHERE target_workspace_id = ?
                  UNION
                  SELECT execution_id FROM assign_work_binding_attention_facts
                   WHERE target_workspace_id = ?
                )
                ORDER BY e.execution_id`,
              [input.projectId, input.workspaceId, input.workspaceId],
            ),
          );
          const executionsById = new Map(
            executions.map((row) => [row.execution_id, row]),
          );

          const terminalCandidates: Array<{
            readonly execution: ExecutionRow;
            readonly failureKind: TerminalProviderFailureKind;
          }> = [];
          for (const execution of executions) {
            // Scope from the durable binding columns before decoding any
            // Episode payload. Malformed evidence for another Work, revision,
            // Workspace, Project, or Episode must not make this target's
            // admission unavailable. Once the columns name the exact target,
            // exactEpisode below still validates their agreement with the
            // durable Agent Runtime state.
            if (
              execution.project_id !== input.projectId ||
              execution.workspace_id !== input.workspaceId ||
              execution.binding_kind !== "workspace" ||
              execution.episode_kind !== "WorkEpisode" ||
              execution.episode_ref !== input.workId ||
              Number(execution.episode_revision) !== input.workRevision
            ) {
              continue;
            }
            try {
              const failureKind = terminalProviderFailureKind(execution);
              if (failureKind !== null) {
                terminalCandidates.push({ execution, failureKind });
              } else if (unknownProviderFailureSettlement(execution)) {
                const steps = yield* run(
                  sql.unsafe<TerminalStepRow>(
                    `SELECT logical_step_no, repair_attempt, provider_turn_id,
                            manifest_id, state, settlement_json
                       FROM agent_loop_steps
                      WHERE execution_id = ? AND state = 'SettlementProposed'
                      ORDER BY logical_step_no, repair_attempt`,
                    [execution.execution_id],
                  ),
                );
                if (steps.length !== 1 || steps[0] === undefined) {
                  return yield* Effect.fail(
                    makeIntegrity(
                      steps.length === 0
                        ? "SourceSettlementStepMissing"
                        : "SourceSettlementStepNonUnique",
                      execution.execution_id as ExecutionId,
                      "TerminalProviderFailureSettlement",
                    ),
                  );
                }
                const attempts = yield* run(
                  sql.unsafe<TerminalAttemptRow>(
                    `SELECT attempt_no, settled_at, outcome, provider_error_kind,
                            failure_taxonomy_version, retry_decision
                       FROM provider_attempts
                      WHERE provider_turn_id = ?
                      ORDER BY attempt_no`,
                    [steps[0].provider_turn_id],
                  ),
                );
                const finalAttempt = attempts.at(-1);
                if (finalAttempt === undefined) {
                  return yield* Effect.fail(
                    makeIntegrity(
                      "SourceProviderAttemptMissing",
                      execution.execution_id as ExecutionId,
                      "TerminalProviderFailureSettlement",
                    ),
                  );
                }
                if (
                  finalAttempt.provider_error_kind === null &&
                  finalAttempt.outcome === "TerminalFailure" &&
                  finalAttempt.retry_decision === "Stop"
                ) {
                  // A killed Provider process can leave only ProcessLost
                  // evidence. It is not one of the closed terminal kinds, so
                  // retain the same-revision admission barrier as bounded
                  // integrity instead of inventing a provider failure code.
                  return yield* Effect.fail(
                    makeIntegrity(
                      "SourceProviderAttemptMismatch",
                      execution.execution_id as ExecutionId,
                      "TerminalProviderFailureSettlement",
                    ),
                  );
                }
              }
            } catch {
              return yield* Effect.fail(
                makeIntegrity(
                  "SettlementMalformed",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
          }
          terminalCandidates.sort((left, right) => {
            const admitted = left.execution.admitted_at.localeCompare(
              right.execution.admitted_at,
            );
            return admitted !== 0
              ? admitted
              : left.execution.execution_id.localeCompare(
                  right.execution.execution_id,
                );
          });

          const terminalSources: Array<TerminalProviderFailureSource> = [];
          for (const candidate of terminalCandidates) {
            const execution = candidate.execution;
            if (execution.episode_json === null) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceEpisodeStateMissing",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            const decoded = exactEpisode(execution);
            if (decoded.episode === undefined) {
              return yield* Effect.fail(
                makeIntegrity(
                  decoded.reason,
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            if (decoded.episode._tag !== "WorkEpisode") continue;
            if (
              decoded.episode.workId !== input.workId ||
              decoded.episode.targetWorkRevision === undefined
            ) {
              continue;
            }
            if (decoded.episode.targetWorkRevision < input.workRevision) {
              continue;
            }
            if (decoded.episode.targetWorkRevision > input.workRevision) {
              return yield* Effect.fail(
                makeIntegrity(
                  "FutureWorkRevision",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }

            const stepRows = yield* run(
              sql.unsafe<TerminalStepRow>(
                `SELECT logical_step_no, repair_attempt, provider_turn_id,
                        manifest_id, state, settlement_json
                   FROM agent_loop_steps
                  WHERE execution_id = ? AND state = 'SettlementProposed'
                  ORDER BY logical_step_no, repair_attempt`,
                [execution.execution_id],
              ),
            );
            if (stepRows.length === 0) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceSettlementStepMissing",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            if (stepRows.length !== 1) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceSettlementStepNonUnique",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            const step = stepRows[0] as TerminalStepRow;
            if (
              step.settlement_json === null ||
              step.settlement_json !== execution.settlement_json
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceSettlementMismatch",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }

            const turnRows = yield* run(
              sql.unsafe<TerminalTurnRow>(
                `SELECT t.provider_turn_id, t.execution_id, t.session_id,
                        t.manifest_id, t.output_contract_ref, t.settled_at,
                        t.finish_reason,
                        m.execution_id AS manifest_execution_id,
                        m.session_id AS manifest_session_id,
                        m.provider_turn_id AS manifest_provider_turn_id,
                        m.compiled_request_hash, m.manifest_json
                   FROM provider_turns AS t
                   LEFT JOIN model_context_manifests AS m
                     ON m.manifest_id = t.manifest_id
                    AND m.provider_turn_id = t.provider_turn_id
                  WHERE t.provider_turn_id = ?`,
                [step.provider_turn_id],
              ),
            );
            if (turnRows.length === 0) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProviderTurnMissing",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            if (turnRows.length !== 1) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProviderTurnNonUnique",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            const turn = turnRows[0] as TerminalTurnRow;
            if (
              turn.execution_id !== execution.execution_id ||
              turn.session_id !== execution.session_id ||
              turn.provider_turn_id !== step.provider_turn_id ||
              turn.finish_reason !== "Failed" ||
              turn.settled_at === null
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProviderTurnMismatch",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            if (
              turn.manifest_id === null ||
              (step.manifest_id !== null &&
                turn.manifest_id !== step.manifest_id) ||
              turn.manifest_json === null ||
              turn.manifest_execution_id !== execution.execution_id ||
              turn.manifest_session_id !== execution.session_id ||
              turn.manifest_provider_turn_id !== turn.provider_turn_id ||
              typeof turn.compiled_request_hash !== "string" ||
              turn.compiled_request_hash.length === 0 ||
              turn.output_contract_ref.length === 0
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  turn.manifest_json === null
                    ? "SourceManifestMissing"
                    : "SourceManifestMismatch",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            let manifest: Record<string, unknown> | null;
            try {
              manifest = record(decodeJson(turn.manifest_json));
            } catch {
              manifest = null;
            }
            const bindingFingerprint =
              manifest?.resolvedModelBindingFingerprint;
            if (
              manifest?.providerTurnId !== turn.provider_turn_id ||
              manifest.executionId !== execution.execution_id ||
              manifest.sessionId !== execution.session_id ||
              manifest.logicalStepNo !== Number(step.logical_step_no) ||
              manifest.repairAttempt !== Number(step.repair_attempt) ||
              manifest.compiledRequestHash !== turn.compiled_request_hash ||
              manifest.outputContractRef !== turn.output_contract_ref ||
              typeof bindingFingerprint !== "string" ||
              !/^p16fp_[0-9a-f]{64}$/u.test(bindingFingerprint)
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceManifestMismatch",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }

            const attempts = yield* run(
              sql.unsafe<TerminalAttemptRow>(
                `SELECT attempt_no, settled_at, outcome, provider_error_kind,
                        failure_taxonomy_version, retry_decision
                   FROM provider_attempts
                  WHERE provider_turn_id = ?
                  ORDER BY attempt_no`,
                [turn.provider_turn_id],
              ),
            );
            if (attempts.length === 0) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProviderAttemptMissing",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            const attempt = attempts.at(-1) as TerminalAttemptRow;
            if (
              !Number.isSafeInteger(attempt.attempt_no) ||
              attempt.attempt_no < 0 ||
              attempt.settled_at === null ||
              attempt.outcome !== "TerminalFailure" ||
              attempt.provider_error_kind !== candidate.failureKind ||
              attempt.retry_decision !== "Stop"
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProviderAttemptMismatch",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            if (attempt.failure_taxonomy_version !== "phase1-v2") {
              return yield* Effect.fail(
                makeIntegrity(
                  "FailureTaxonomyUnsupported",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            if (!isCanonicalUtc(attempt.settled_at)) {
              return yield* Effect.fail(
                makeIntegrity(
                  "FailureOccurrenceTimeInvalid",
                  execution.execution_id as ExecutionId,
                  "TerminalProviderFailureSettlement",
                ),
              );
            }
            const failureFingerprint = sha256Hex(
              JSON.stringify({
                version: "terminal-provider-failure-v1",
                failureKind: candidate.failureKind,
                failureTaxonomyVersion: attempt.failure_taxonomy_version,
                resolvedModelBindingFingerprint: bindingFingerprint,
                compiledRequestHash: turn.compiled_request_hash,
                outputContractRef: turn.output_contract_ref,
              }),
            ) as Sha256;
            terminalSources.push({
              sourceKind: "TerminalProviderFailureSettlement",
              executionId: execution.execution_id as ExecutionId,
              logicalStepNo: Number(step.logical_step_no),
              repairAttempt: Number(step.repair_attempt),
              providerTurnId: turn.provider_turn_id as ProviderTurnId,
              attemptNo: Number(attempt.attempt_no),
              failureKind: candidate.failureKind,
              failureFingerprint,
            });
          }
          const earliestTerminalSource = terminalSources[0];
          if (earliestTerminalSource !== undefined) {
            return Option.some(earliestTerminalSource);
          }
          const facts = yield* run(
            sql.unsafe<FactRow>(
              `SELECT attention_fact_id, event_id, project_id, execution_id,
                      target_workspace_id, logical_action_id, failure_code,
                      'DeliverReplayFact' AS fact_kind, message_id AS detail_id
                 FROM deliver_replay_attention_facts
                WHERE target_workspace_id = ?
               UNION ALL
               SELECT attention_fact_id, event_id, project_id, execution_id,
                      target_workspace_id, logical_action_id, failure_code,
                      'AssignWorkBindingFact' AS fact_kind,
                      committed_command_id AS detail_id
                 FROM assign_work_binding_attention_facts
                WHERE target_workspace_id = ?`,
              [input.workspaceId, input.workspaceId],
            ),
          );
          const events = yield* run(
            sql.unsafe<EventRow>(
              `SELECT event_id, project_id, event_type, event_version,
                      aggregate_ref, correlation_ref, payload_json
                 FROM domain_events
                WHERE event_type IN ('DeliverReplayEscalated',
                                     'AssignWorkTargetBindingEscalated',
                                     'ReconciliationEscalated')
                  AND (project_id = ? OR aggregate_ref = ?)
                ORDER BY event_id`,
              [input.projectId, input.workspaceId],
            ),
          );
          const eventsById = new Map(
            events.map((event) => [event.event_id, event]),
          );
          const findExecutionScope = (executionId: string) =>
            Effect.gen(function* () {
              const known = executionsById.get(executionId);
              if (known !== undefined) return known;
              const rows = yield* run(
                sql.unsafe<ExecutionScopeRow>(
                  `SELECT execution_id, project_id, workspace_id
                     FROM executions WHERE execution_id = ?`,
                  [executionId],
                ),
              );
              return rows[0] ?? null;
            });
          const candidates: Array<{
            readonly executionId: ExecutionId;
            readonly kind: Exclude<
              ReadmissionSourceKind,
              "TerminalProviderFailureSettlement"
            >;
            readonly fact?: FactRow;
            readonly event?: EventRow;
          }> = [];

          for (const execution of executions) {
            if (
              execution.workspace_id !== input.workspaceId ||
              execution.settled_at === null
            )
              continue;
            if (execution.settlement_kind === "Interrupted") {
              // Interrupted is broader than the RAI source: in particular,
              // ordinary StopRequested recovery settlements are not holds.
              // Decode the settlement before demanding Work Episode state so
              // a non-source Execution admitted but never dispatched remains
              // outside this gate.
              try {
                if (runtimeSafetyStop(execution)) {
                  candidates.push({
                    executionId: execution.execution_id as ExecutionId,
                    kind: "RuntimeSafetyStopSettlement",
                  });
                }
              } catch {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SettlementMalformed",
                    execution.execution_id as ExecutionId,
                    "RuntimeSafetyStopSettlement",
                  ),
                );
              }
            } else if (execution.settlement_kind === "OutcomeUnknown") {
              try {
                if (outcomeUnknown(execution)) {
                  candidates.push({
                    executionId: execution.execution_id as ExecutionId,
                    kind: "OutcomeUnknownSettlement",
                  });
                }
              } catch {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SettlementMalformed",
                    execution.execution_id as ExecutionId,
                    "OutcomeUnknownSettlement",
                  ),
                );
              }
            }
          }

          for (const fact of facts) {
            if (
              fact.project_id !== input.projectId ||
              fact.target_workspace_id !== input.workspaceId ||
              !isFailureCode(fact.fact_kind, fact.failure_code)
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceFactEventMismatch",
                  fact.execution_id as ExecutionId,
                  fact.fact_kind,
                ),
              );
            }
            const event = eventsById.get(fact.event_id);
            if (event === undefined) {
              // DeliverReplayEscalated.event_id is audit-only: P9 deliberately
              // has no FK to the prunable journal. The immutable fact remains
              // the durable readmission witness after pruning. AssignWork's
              // fact still requires its event witness.
              if (fact.fact_kind !== "DeliverReplayFact") {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceFactEventMismatch",
                    fact.execution_id as ExecutionId,
                    fact.fact_kind,
                  ),
                );
              }
              candidates.push({
                executionId: fact.execution_id as ExecutionId,
                kind: fact.fact_kind,
                fact,
              });
              continue;
            }
            let payload: Record<string, unknown> | null = null;
            try {
              payload = record(decodeJson(event.payload_json));
            } catch {
              // handled by the bounded witness mismatch below
            }
            const isDeliver = fact.fact_kind === "DeliverReplayFact";
            const expectedType = isDeliver
              ? "DeliverReplayEscalated"
              : "AssignWorkTargetBindingEscalated";
            const eventMatches =
              event.project_id === fact.project_id &&
              event.event_type === expectedType &&
              Number(event.event_version) === 1 &&
              event.aggregate_ref === fact.target_workspace_id &&
              event.correlation_ref === fact.logical_action_id &&
              payload?.executionId === fact.execution_id &&
              payload?.targetWorkspaceId === fact.target_workspace_id &&
              payload?.logicalActionId === fact.logical_action_id &&
              payload?.failureCode === fact.failure_code &&
              payload?.attentionFactId === fact.attention_fact_id &&
              (isDeliver
                ? payload?.messageId === fact.detail_id
                : payload?.committedCommandId === fact.detail_id);
            if (!eventMatches) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceFactEventMismatch",
                  fact.execution_id as ExecutionId,
                  fact.fact_kind,
                ),
              );
            }
            candidates.push({
              executionId: fact.execution_id as ExecutionId,
              kind: fact.fact_kind,
              fact,
              event,
            });
          }

          for (const event of events) {
            if (
              event.event_type !== "ReconciliationEscalated" ||
              event.project_id !== input.projectId
            ) {
              continue;
            }
            let payload: Record<string, unknown> | null = null;
            try {
              payload = record(decodeJson(event.payload_json));
            } catch {
              const aggregateScope = yield* findExecutionScope(
                event.aggregate_ref,
              );
              if (aggregateScope === null) {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceExecutionMissing",
                    event.aggregate_ref as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              if (aggregateScope.project_id !== input.projectId) {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceProjectMismatch",
                    event.aggregate_ref as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              if (aggregateScope.workspace_id !== input.workspaceId) continue;
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceEventExecutionMismatch",
                  event.aggregate_ref as ExecutionId,
                  "ReconciliationEscalationEvent",
                ),
              );
            }
            const executionId = payload?.executionId;
            const payloadExecutionId =
              typeof executionId === "string" ? executionId : undefined;
            const identitiesMatch =
              payloadExecutionId !== undefined &&
              event.aggregate_ref === payloadExecutionId;
            if (!identitiesMatch) {
              const aggregateScope = yield* findExecutionScope(
                event.aggregate_ref,
              );
              if (aggregateScope === null) {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceExecutionMissing",
                    event.aggregate_ref as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              if (aggregateScope.project_id !== input.projectId) {
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceProjectMismatch",
                    event.aggregate_ref as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              const aggregateInRequestedWorkspace =
                aggregateScope.workspace_id === input.workspaceId;
              if (payloadExecutionId === undefined) {
                if (!aggregateInRequestedWorkspace) continue;
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceEventExecutionMismatch",
                    event.aggregate_ref as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              const payloadScope =
                yield* findExecutionScope(payloadExecutionId);
              if (payloadScope === null) {
                if (!aggregateInRequestedWorkspace) continue;
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceExecutionMissing",
                    payloadExecutionId as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              if (payloadScope.project_id !== input.projectId) {
                if (!aggregateInRequestedWorkspace) continue;
                return yield* Effect.fail(
                  makeIntegrity(
                    "SourceProjectMismatch",
                    payloadExecutionId as ExecutionId,
                    "ReconciliationEscalationEvent",
                  ),
                );
              }
              if (
                !aggregateInRequestedWorkspace &&
                payloadScope.workspace_id !== input.workspaceId
              )
                continue;
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceEventExecutionMismatch",
                  (aggregateInRequestedWorkspace
                    ? event.aggregate_ref
                    : payloadExecutionId) as ExecutionId,
                  "ReconciliationEscalationEvent",
                ),
              );
            }
            const executionScope =
              yield* findExecutionScope(payloadExecutionId);
            if (executionScope === null) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceExecutionMissing",
                  payloadExecutionId as ExecutionId,
                  "ReconciliationEscalationEvent",
                ),
              );
            }
            if (executionScope.project_id !== input.projectId) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProjectMismatch",
                  payloadExecutionId as ExecutionId,
                  "ReconciliationEscalationEvent",
                ),
              );
            }
            if (executionScope.workspace_id !== input.workspaceId) continue;
            if (
              Number(event.event_version) !== 1 ||
              typeof payload?.invocationRefsFingerprint !== "string" ||
              !Array.isArray(payload.refs)
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceEventExecutionMismatch",
                  payloadExecutionId as ExecutionId,
                  "ReconciliationEscalationEvent",
                ),
              );
            }
            candidates.push({
              executionId: payloadExecutionId as ExecutionId,
              kind: "ReconciliationEscalationEvent",
              event,
            });
          }

          const seen = new Set<string>();
          for (const candidate of candidates) {
            const candidateKey = `${candidate.executionId}:${candidate.kind}:${candidate.event?.event_id ?? candidate.fact?.attention_fact_id ?? "settlement"}`;
            if (seen.has(candidateKey)) continue;
            seen.add(candidateKey);
            const execution = executionsById.get(candidate.executionId);
            if (execution === undefined) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceExecutionMissing",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            if (execution.project_id !== input.projectId) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceProjectMismatch",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            if (execution.workspace_id !== input.workspaceId) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceWorkspaceMismatch",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            if (execution.episode_json === null) {
              return yield* Effect.fail(
                makeIntegrity(
                  "SourceEpisodeStateMissing",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            const decoded = exactEpisode(execution);
            if (decoded.episode === undefined) {
              return yield* Effect.fail(
                makeIntegrity(
                  decoded.reason,
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            if (decoded.episode._tag !== "WorkEpisode") continue;
            if (
              decoded.episode.workId === undefined ||
              decoded.episode.targetWorkRevision === undefined
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "EpisodeMalformed",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            const sourceWorkRows = yield* run(
              sql.unsafe<TargetRow>(
                "SELECT work_id, project_id, workspace_id, revision FROM works WHERE work_id = ?",
                [decoded.episode.workId],
              ),
            );
            const sourceWork = sourceWorkRows[0];
            if (sourceWork === undefined) {
              return yield* Effect.fail(
                makeIntegrity(
                  "WorkMissing",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            if (
              sourceWork.project_id !== input.projectId ||
              sourceWork.workspace_id !== input.workspaceId
            ) {
              return yield* Effect.fail(
                makeIntegrity(
                  "WorkScopeMismatch",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            const sourceRevision = decoded.episode.targetWorkRevision;
            const currentRevision = Number(sourceWork.revision);
            if (sourceRevision > currentRevision) {
              return yield* Effect.fail(
                makeIntegrity(
                  "FutureWorkRevision",
                  candidate.executionId,
                  candidate.kind,
                ),
              );
            }
            if (
              decoded.episode.workId === input.workId &&
              sourceRevision === input.workRevision
            ) {
              return Option.some({
                sourceKind: candidate.kind,
                executionId: candidate.executionId,
              });
            }
          }
          return Option.none();
        });

    return WorkReadmissionGateStore.of({ hasBlockingSource });
  }),
);
