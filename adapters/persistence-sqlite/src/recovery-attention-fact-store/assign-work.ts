import {
  Actor,
  parse,
} from "@arbor/domain";
import type {
  RecoveryAttentionFactStoreError,
} from "@arbor/ports";
import {
  IdGenerator,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import {
  Effect,
  Option,
} from "effect";
import type { RecoveryAttentionFactStoreService } from "@arbor/ports";
import {
  type Row,
  toFact,
} from "./row-codecs.js";
import type { FactContext } from "./context.js";

export const makeAssignWorkFacts = (context: FactContext): Pick<RecoveryAttentionFactStoreService, "recordAssignWorkBindingFailure" | "findAssignWorkBindingFailure"> => {
  const { sql, journal, ids, run, readByTuple, qualificationProbe } = context;
  return {
        recordAssignWorkBindingFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const attentionFactId = `att_${sha256Hex(
              JSON.stringify({
                version: 1,
                executionId: input.executionId,
                logicalActionId: input.logicalActionId,
                committedCommandId: input.committedCommandId,
              }),
            )}`;
            const prior = yield* readByTuple(input);
            if (prior[0] !== undefined) {
              const fact = toFact(prior[0]);
              if (
                fact.projectId !== input.projectId ||
                fact.targetWorkspaceId !== input.targetWorkspaceId ||
                fact.attentionFactId !== attentionFactId
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing AssignWork binding fact has a conflicting identity",
                });
              }
              return fact;
            }
            const events = yield* journal
              .appendReturningIds([
                {
                  projectId: input.projectId,
                  eventType: "AssignWorkTargetBindingEscalated",
                  eventVersion: 1,
                  occurredAt: input.firstDetectedAt,
                  aggregateRef: input.targetWorkspaceId,
                  actor: parse(Actor)("system:recovery"),
                  causedByCommandId: input.committedCommandId,
                  correlationRef: input.logicalActionId,
                  payload: {
                    attentionFactId,
                    executionId: input.executionId,
                    targetWorkspaceId: input.targetWorkspaceId,
                    logicalActionId: input.logicalActionId,
                    committedCommandId: input.committedCommandId,
                    failureCode: input.failureCode,
                  },
                },
              ])
              .pipe(Effect.provideService(IdGenerator, ids));
            const eventId = events[0];
            if (eventId === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "event journal did not return the AssignWork binding event id",
              });
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO assign_work_binding_attention_facts (
                attention_fact_id, event_id, project_id, execution_id,
                target_workspace_id, logical_action_id, committed_command_id,
                failure_code, first_detected_at
              ) VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                  attentionFactId,
                  eventId,
                  input.projectId,
                  input.executionId,
                  input.targetWorkspaceId,
                  input.logicalActionId,
                  input.committedCommandId,
                  input.failureCode,
                  input.firstDetectedAt,
                ],
              ),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH10BeforeAssignWorkBindingAttentionCommit",
                  executionId: input.executionId,
                  logicalActionId: input.logicalActionId,
                  committedCommandId: input.committedCommandId,
                }),
              );
            }
            return {
              ...input,
              attentionFactId,
              eventId,
            };
          }),
        findAssignWorkBindingFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<Row>(
                `SELECT attention_fact_id, event_id, project_id, execution_id,
                      target_workspace_id, logical_action_id, committed_command_id,
                      failure_code, first_detected_at
                 FROM assign_work_binding_attention_facts WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toFact(rows[0]));
          }),
  };
};
