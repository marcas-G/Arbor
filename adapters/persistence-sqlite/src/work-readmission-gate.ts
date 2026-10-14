import type { ExecutionId } from "@arbor/domain";
import {
  type ReadmissionGateIntegrityFailure,
  type ReadmissionSourceKind,
  type ReadmissionTargetMismatch,
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
  readonly episode_kind: string | null;
  readonly episode_ref: string | null;
  readonly episode_revision: number | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly settled_at: string | null;
  readonly stop_requested_at: string | null;
  readonly episode_json: string | null;
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
                      e.workspace_id, e.episode_kind, e.episode_ref,
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
            readonly kind: ReadmissionSourceKind;
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
