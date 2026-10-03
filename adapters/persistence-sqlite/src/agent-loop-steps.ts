import type { ExecutionId, ProviderTurnId } from "@arbor/domain";
import {
  type AgentLoopStepActionRecord,
  type AgentLoopStepActionState,
  type AgentLoopStepFence,
  type AgentLoopStepIdentity,
  type AgentLoopStepInvariantConflict,
  type AgentLoopStepProviderTurnLink,
  type AgentLoopStepRecord,
  type AgentLoopStepState,
  AgentLoopStepStore,
  Clock,
  type LeaseFencingRejected,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface StepRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly provider_turn_id: string;
  readonly predecessor_logical_step_no: number | null;
  readonly predecessor_repair_attempt: number | null;
  readonly manifest_id: string | null;
  readonly state: AgentLoopStepState;
  readonly decoder_version: string | null;
  readonly provider_failure_json: string | null;
  readonly repair_disposition_json: string | null;
  readonly successor_json: string | null;
  readonly next_step_reason: string | null;
  readonly decoded_output_hash: string | null;
  readonly model_output_session_sequence: number | null;
  readonly next_action_index: number;
  readonly settlement_json: string | null;
  readonly migration_provenance_json: string | null;
  readonly revision: number;
  readonly updated_at: string;
}

interface ActionRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly route_kind: "Executable" | "Control";
  readonly action_kind: string;
  readonly input_hash: string;
  readonly state: AgentLoopStepActionState;
  readonly result_ref: string | null;
  readonly settlement_ref: string | null;
  readonly disposition_json: string | null;
  readonly observation_source_ref: string | null;
  readonly revision: number;
  readonly updated_at: string;
}

interface ProviderTurnLinkRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly overflow_ordinal: 0;
  readonly role: AgentLoopStepProviderTurnLink["role"];
  readonly provider_turn_id: string;
  readonly predecessor_provider_turn_id: string | null;
  readonly context_epoch: number;
  readonly manifest_id: string | null;
  readonly state: AgentLoopStepProviderTurnLink["state"];
  readonly created_at: string;
}

const toProviderTurnLink = (
  row: ProviderTurnLinkRow,
): AgentLoopStepProviderTurnLink => ({
  identity: toIdentity(row),
  overflowOrdinal: 0,
  role: row.role,
  providerTurnId: row.provider_turn_id as ProviderTurnId,
  ...(row.predecessor_provider_turn_id === null
    ? {}
    : {
        predecessorProviderTurnId:
          row.predecessor_provider_turn_id as ProviderTurnId,
      }),
  contextEpoch: row.context_epoch as never,
  ...(row.manifest_id === null ? {} : { manifestId: row.manifest_id }),
  state: row.state,
  createdAt: row.created_at,
});

const parseJson = (value: string | null): unknown | undefined =>
  value === null ? undefined : (JSON.parse(value) as unknown);

const toIdentity = (row: {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
}): AgentLoopStepIdentity => ({
  executionId: row.execution_id as ExecutionId,
  logicalStepNo: Number(row.logical_step_no),
  repairAttempt: Number(row.repair_attempt),
});

const toStep = (row: StepRow): AgentLoopStepRecord => ({
  identity: toIdentity(row),
  ...(row.predecessor_logical_step_no === null ||
  row.predecessor_repair_attempt === null
    ? {}
    : {
        predecessor: {
          executionId: row.execution_id as ExecutionId,
          logicalStepNo: Number(row.predecessor_logical_step_no),
          repairAttempt: Number(row.predecessor_repair_attempt),
        },
      }),
  providerTurnId: row.provider_turn_id as ProviderTurnId,
  ...(row.manifest_id === null ? {} : { manifestId: row.manifest_id }),
  state: row.state,
  ...(row.decoder_version === null
    ? {}
    : { decoderVersion: row.decoder_version }),
  ...(row.provider_failure_json === null
    ? {}
    : { providerFailure: parseJson(row.provider_failure_json) as never }),
  ...(row.repair_disposition_json === null
    ? {}
    : { repairDisposition: parseJson(row.repair_disposition_json) }),
  ...(row.successor_json === null
    ? {}
    : { successor: parseJson(row.successor_json) as never }),
  ...(row.next_step_reason === null
    ? {}
    : { nextStepReason: row.next_step_reason }),
  ...(row.decoded_output_hash === null
    ? {}
    : { decodedOutputHash: row.decoded_output_hash }),
  ...(row.model_output_session_sequence === null
    ? {}
    : {
        modelOutputSessionSequence: Number(row.model_output_session_sequence),
      }),
  nextActionIndex: Number(row.next_action_index),
  ...(row.settlement_json === null
    ? {}
    : { settlement: parseJson(row.settlement_json) as never }),
  ...(row.migration_provenance_json === null
    ? {}
    : { migrationProvenance: parseJson(row.migration_provenance_json) }),
  revision: Number(row.revision),
  updatedAt: row.updated_at,
});

const toAction = (row: ActionRow): AgentLoopStepActionRecord => ({
  identity: toIdentity(row),
  actionIndex: Number(row.action_index),
  logicalActionId: row.logical_action_id,
  callRef: row.call_ref,
  routeKind: row.route_kind,
  actionKind: row.action_kind,
  inputHash: row.input_hash,
  state: row.state,
  ...(row.result_ref === null ? {} : { resultRef: row.result_ref }),
  ...(row.settlement_ref === null ? {} : { settlementRef: row.settlement_ref }),
  ...(row.disposition_json === null
    ? {}
    : { disposition: parseJson(row.disposition_json) }),
  ...(row.observation_source_ref === null
    ? {}
    : { observationSourceRef: row.observation_source_ref }),
  revision: Number(row.revision),
  updatedAt: row.updated_at,
});

const jsonOrNull = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

const stepParams = (record: AgentLoopStepRecord): ReadonlyArray<unknown> => [
  record.identity.executionId,
  record.identity.logicalStepNo,
  record.identity.repairAttempt,
  record.providerTurnId,
  record.predecessor?.logicalStepNo ?? null,
  record.predecessor?.repairAttempt ?? null,
  record.manifestId ?? null,
  record.state,
  record.decoderVersion ?? null,
  jsonOrNull(record.providerFailure),
  jsonOrNull(record.repairDisposition),
  jsonOrNull(record.successor),
  record.nextStepReason ?? null,
  record.decodedOutputHash ?? null,
  record.modelOutputSessionSequence ?? null,
  record.nextActionIndex,
  jsonOrNull(record.settlement),
  jsonOrNull(record.migrationProvenance),
  record.revision,
  record.updatedAt,
];

const actionParams = (
  record: AgentLoopStepActionRecord,
): ReadonlyArray<unknown> => [
  record.identity.executionId,
  record.identity.logicalStepNo,
  record.identity.repairAttempt,
  record.actionIndex,
  record.logicalActionId,
  record.callRef,
  record.routeKind,
  record.actionKind,
  record.inputHash,
  record.state,
  record.resultRef ?? null,
  record.settlementRef ?? null,
  jsonOrNull(record.disposition),
  record.observationSourceRef ?? null,
  record.revision,
  record.updatedAt,
];

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const AgentLoopStepStoreLive: Layer.Layer<
  AgentLoopStepStore,
  never,
  SqlClient | Clock
> = Layer.effect(
  AgentLoopStepStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = repositoryFailure("AgentLoopStepStore", "agent-loop-step");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const conflict = (reason: string): AgentLoopStepInvariantConflict => ({
      _tag: "AgentLoopStepInvariantConflict",
      reason,
    });
    const checkFence = (fence: AgentLoopStepFence) =>
      Effect.gen(function* () {
        const now = yield* clock.now();
        const rows = yield* run(
          sql.unsafe<{ ok: number }>(
            "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.worker_id = ? AND l.worker_incarnation_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
            [
              fence.executionId,
              fence.workerId,
              fence.workerIncarnationId,
              fence.fencingGeneration,
              now,
            ],
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId: fence.executionId,
            generation: fence.fencingGeneration,
          });
        }
      });
    const findStep = (identity: AgentLoopStepIdentity) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<StepRow>(
            "SELECT * FROM agent_loop_steps WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?",
            [
              identity.executionId,
              identity.logicalStepNo,
              identity.repairAttempt,
            ],
          ),
        );
        return rows[0] === undefined
          ? Option.none<AgentLoopStepRecord>()
          : Option.some(toStep(rows[0]));
      });

    return AgentLoopStepStore.of({
      isAvailable: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'agent_loop_steps'",
            ),
          );
          return Number(rows[0]?.count ?? 0) === 1;
        }),
      find: findStep,
      findCurrent: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<StepRow>(
              "SELECT * FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no DESC, repair_attempt DESC LIMIT 1",
              [executionId],
            ),
          );
          return rows[0] === undefined
            ? Option.none<AgentLoopStepRecord>()
            : Option.some(toStep(rows[0]));
        }),
      createPrepared: (record, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          if (record.state !== "Prepared") {
            return yield* Effect.fail(conflict("create requires Prepared"));
          }
          const existing = yield* findStep(record.identity);
          if (Option.isSome(existing)) {
            return same(existing.value, record)
              ? existing.value
              : yield* Effect.fail(
                  conflict("existing step differs from Prepared record"),
                );
          }
          const rows = yield* run(
            sql.unsafe<StepRow>(
              "INSERT INTO agent_loop_steps (execution_id, logical_step_no, repair_attempt, provider_turn_id, predecessor_logical_step_no, predecessor_repair_attempt, manifest_id, state, decoder_version, provider_failure_json, repair_disposition_json, successor_json, next_step_reason, decoded_output_hash, model_output_session_sequence, next_action_index, settlement_json, migration_provenance_json, revision, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
              stepParams(record),
            ),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(failure("insert returned no row"));
          }
          return toStep(row);
        }),
      transition: (input, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          if (
            !same(input.identity, input.next.identity) ||
            input.next.revision !== input.expectedRevision + 1
          ) {
            return yield* Effect.fail(
              conflict("transition identity/revision mismatch"),
            );
          }
          const params = stepParams(input.next);
          const rows = yield* run(
            sql.unsafe<StepRow>(
              "UPDATE agent_loop_steps SET provider_turn_id=?, predecessor_logical_step_no=?, predecessor_repair_attempt=?, manifest_id=?, state=?, decoder_version=?, provider_failure_json=?, repair_disposition_json=?, successor_json=?, next_step_reason=?, decoded_output_hash=?, model_output_session_sequence=?, next_action_index=?, settlement_json=?, migration_provenance_json=?, revision=?, updated_at=? WHERE execution_id=? AND logical_step_no=? AND repair_attempt=? AND revision=? AND state=? RETURNING *",
              [
                ...params.slice(3),
                input.identity.executionId,
                input.identity.logicalStepNo,
                input.identity.repairAttempt,
                input.expectedRevision,
                input.expectedState,
              ],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? yield* Effect.fail(conflict("step CAS rejected"))
            : toStep(row);
        }),
      ensureSuccessor: (predecessor, successor, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          if (!same(successor.predecessor, predecessor)) {
            return yield* Effect.fail(
              conflict("successor predecessor mismatch"),
            );
          }
          if (successor.state !== "Prepared") {
            return yield* Effect.fail(conflict("successor must be Prepared"));
          }
          const existing = yield* findStep(successor.identity);
          if (Option.isSome(existing)) {
            return same(existing.value, successor)
              ? existing.value
              : yield* Effect.fail(conflict("existing successor differs"));
          }
          const rows = yield* run(
            sql.unsafe<StepRow>(
              "INSERT INTO agent_loop_steps (execution_id, logical_step_no, repair_attempt, provider_turn_id, predecessor_logical_step_no, predecessor_repair_attempt, manifest_id, state, decoder_version, provider_failure_json, repair_disposition_json, successor_json, next_step_reason, decoded_output_hash, model_output_session_sequence, next_action_index, settlement_json, migration_provenance_json, revision, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
              stepParams(successor),
            ),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(failure("insert returned no row"));
          }
          return toStep(row);
        }),
      createAction: (record, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          const existing = yield* run(
            sql.unsafe<ActionRow>(
              "SELECT * FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ? AND action_index = ?",
              [
                record.identity.executionId,
                record.identity.logicalStepNo,
                record.identity.repairAttempt,
                record.actionIndex,
              ],
            ),
          );
          if (existing[0] !== undefined) {
            const prior = toAction(existing[0]);
            return same(prior, record)
              ? prior
              : yield* Effect.fail(conflict("existing action differs"));
          }
          const rows = yield* run(
            sql.unsafe<ActionRow>(
              "INSERT INTO agent_loop_step_actions (execution_id, logical_step_no, repair_attempt, action_index, logical_action_id, call_ref, route_kind, action_kind, input_hash, state, result_ref, settlement_ref, disposition_json, observation_source_ref, revision, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
              actionParams(record),
            ),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(failure("action insert returned no row"));
          }
          return toAction(row);
        }),
      transitionAction: (input, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          if (
            !same(input.identity, input.next.identity) ||
            input.next.actionIndex !== input.actionIndex ||
            input.next.revision !== input.expectedRevision + 1
          ) {
            return yield* Effect.fail(
              conflict("action transition identity/revision mismatch"),
            );
          }
          const params = actionParams(input.next);
          const rows = yield* run(
            sql.unsafe<ActionRow>(
              "UPDATE agent_loop_step_actions SET logical_action_id=?, call_ref=?, route_kind=?, action_kind=?, input_hash=?, state=?, result_ref=?, settlement_ref=?, disposition_json=?, observation_source_ref=?, revision=?, updated_at=? WHERE execution_id=? AND logical_step_no=? AND repair_attempt=? AND action_index=? AND revision=? AND state=? RETURNING *",
              [
                ...params.slice(4),
                input.identity.executionId,
                input.identity.logicalStepNo,
                input.identity.repairAttempt,
                input.actionIndex,
                input.expectedRevision,
                input.expectedState,
              ],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? yield* Effect.fail(conflict("action CAS rejected"))
            : toAction(row);
        }),
      listActions: (identity) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ActionRow>(
              "SELECT * FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ? ORDER BY action_index",
              [
                identity.executionId,
                identity.logicalStepNo,
                identity.repairAttempt,
              ],
            ),
          );
          return rows.map(toAction);
        }),
      ensureProviderTurnLink: (link, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          const existing = yield* run(
            sql.unsafe<ProviderTurnLinkRow>(
              "SELECT * FROM agent_loop_step_provider_turns WHERE execution_id=? AND logical_step_no=? AND repair_attempt=? AND overflow_ordinal=? AND role=?",
              [
                link.identity.executionId,
                link.identity.logicalStepNo,
                link.identity.repairAttempt,
                link.overflowOrdinal,
                link.role,
              ],
            ),
          );
          if (existing[0] !== undefined) {
            const prior = toProviderTurnLink(existing[0]);
            return same(prior, link)
              ? prior
              : yield* Effect.fail(
                  conflict("existing provider turn link differs"),
                );
          }
          const rows = yield* run(
            sql.unsafe<ProviderTurnLinkRow>(
              "INSERT INTO agent_loop_step_provider_turns (execution_id,logical_step_no,repair_attempt,overflow_ordinal,role,provider_turn_id,predecessor_provider_turn_id,context_epoch,manifest_id,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
              [
                link.identity.executionId,
                link.identity.logicalStepNo,
                link.identity.repairAttempt,
                link.overflowOrdinal,
                link.role,
                link.providerTurnId,
                link.predecessorProviderTurnId ?? null,
                link.contextEpoch,
                link.manifestId ?? null,
                link.state,
                link.createdAt,
              ],
            ),
          );
          return toProviderTurnLink(rows[0] as ProviderTurnLinkRow);
        }),
      listProviderTurnLinks: (identity) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ProviderTurnLinkRow>(
              "SELECT * FROM agent_loop_step_provider_turns WHERE execution_id=? AND logical_step_no=? AND repair_attempt=? ORDER BY overflow_ordinal, role",
              [
                identity.executionId,
                identity.logicalStepNo,
                identity.repairAttempt,
              ],
            ),
          );
          return rows.map(toProviderTurnLink);
        }),
    });
  }),
);
